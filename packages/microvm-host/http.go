package agent

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// 7445 is the gateway every current guest serves. 7444 belonged to the retired
// ACP actor and stays accepted so guests already in the field keep answering an
// older control plane; nothing in this tree asks for it.
var allowedWebAppPorts = map[int]struct{}{
	7444: {},
	7445: {},
}

func ReadBearerToken(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("stat token file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
		return "", fmt.Errorf("token file must be a regular file with mode 0600")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read token file: %w", err)
	}
	token := strings.TrimSpace(string(b))
	if len(token) < 32 || strings.ContainsAny(token, " \t\r\n") {
		return "", fmt.Errorf("token must be at least 32 non-whitespace characters")
	}
	return token, nil
}

type API struct {
	manager         *Manager
	token           string
	webAppTransport http.RoundTripper
}

func NewHandler(manager *Manager, token string) http.Handler {
	return &API{manager: manager, token: token}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="blitz-microvm-agent"`)
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	switch {
	case r.URL.Path == "/v1/healthz" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.Health(r.Context()))
	case r.URL.Path == "/v1/capacity" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.Capacity())
	case r.URL.Path == "/v1/vms" && r.Method == http.MethodGet:
		writeJSON(w, http.StatusOK, a.manager.List())
	case r.URL.Path == "/v1/vms" && r.Method == http.MethodPost:
		a.create(w, r)
	case strings.HasPrefix(r.URL.Path, "/vms/"):
		a.webApp(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/vms/") && r.Method == http.MethodDelete:
		a.delete(w, r)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

type webAppTarget struct {
	vmID        string
	port        int
	path        string
	rawPath     string
	matchedPath bool
}

func parseWebAppTarget(requestURL *url.URL) webAppTarget {
	escaped := requestURL.EscapedPath()
	if !strings.HasPrefix(escaped, "/vms/") {
		return webAppTarget{}
	}
	parts := strings.SplitN(strings.TrimPrefix(escaped, "/vms/"), "/", 4)
	if len(parts) < 3 || parts[1] != "webapp" || parts[0] == "" || parts[2] == "" {
		return webAppTarget{}
	}
	vmID, err := url.PathUnescape(parts[0])
	if err != nil || !vmIDPattern.MatchString(vmID) {
		return webAppTarget{}
	}
	port, err := strconv.Atoi(parts[2])
	if err != nil {
		return webAppTarget{matchedPath: true}
	}
	rawPath := "/"
	if len(parts) == 4 && parts[3] != "" {
		rawPath += parts[3]
	}
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return webAppTarget{matchedPath: true, port: port}
	}
	return webAppTarget{
		vmID: vmID, port: port, path: path, rawPath: rawPath, matchedPath: true,
	}
}

func (a *API) webApp(w http.ResponseWriter, r *http.Request) {
	target := parseWebAppTarget(r.URL)
	if !target.matchedPath {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, ok := allowedWebAppPorts[target.port]; !ok || target.vmID == "" || target.path == "" {
		writeError(w, http.StatusBadRequest, "webApp port must be 7444 or 7445")
		return
	}
	vm, ok := a.manager.Lookup(target.vmID)
	if !ok {
		writeError(w, http.StatusNotFound, "VM not found")
		return
	}
	// WebApp uploads, downloads, previews, and upgraded connections may all
	// legitimately outlive the API server's short JSON request deadlines.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	upstream := &url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort(vm.GuestIP, strconv.Itoa(target.port)),
	}
	proxy := &httputil.ReverseProxy{
		Transport:     a.webAppTransport,
		FlushInterval: -1,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			webAppCredential := proxyRequest.Out.Header.Values("X-Blitz-WebApp-Token")
			proxyRequest.SetURL(upstream)
			proxyRequest.Out.URL.Path = target.path
			proxyRequest.Out.URL.RawPath = target.rawPath
			proxyRequest.Out.Host = upstream.Host
			proxyRequest.Out.Header.Del("Authorization")
			proxyRequest.Out.Header.Del("Proxy-Authorization")
			proxyRequest.Out.Header.Del("Cookie")
			// X-Blitz-WebApp-Token is guest authentication, not host API
			// authentication. Preserve exactly one value across the host-auth strip.
			proxyRequest.Out.Header.Del("X-Blitz-WebApp-Token")
			if len(webAppCredential) == 1 {
				proxyRequest.Out.Header.Set("X-Blitz-WebApp-Token", webAppCredential[0])
			}
			if target.port == 7444 {
				// 7444 served the retired ACP actor. The route stays for guests
				// already in the field: their loopback-only listener accepts only
				// loopback origins, and the authenticated proxy is the boundary.
				proxyRequest.Out.Header.Set("Origin", "http://127.0.0.1")
			}
			proxyRequest.SetXForwarded()
		},
		ErrorHandler: func(response http.ResponseWriter, _ *http.Request, _ error) {
			writeError(response, http.StatusBadGateway, "guest webApp unavailable")
		},
	}
	proxy.ServeHTTP(w, r)
}

func (a *API) authorized(r *http.Request) bool {
	want := "Bearer " + a.token
	got := r.Header.Get("Authorization")
	return len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

func (a *API) create(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req CreateRequest
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := ensureJSONEOF(dec); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	resp, err := a.manager.Create(r.Context(), req)
	if err != nil {
		switch {
		case errors.Is(err, ErrInvalid):
			writeError(w, http.StatusBadRequest, err.Error())
		case errors.Is(err, ErrCapacity):
			writeError(w, http.StatusConflict, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "VM creation failed")
		}
		return
	}
	writeJSON(w, http.StatusCreated, resp)
}

func (a *API) delete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/v1/vms/")
	if id == "" || strings.Contains(id, "/") || !vmIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := a.manager.Delete(r.Context(), id); err != nil {
		writeError(w, http.StatusInternalServerError, "VM deletion failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func ensureJSONEOF(dec *json.Decoder) error {
	var extra any
	err := dec.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
