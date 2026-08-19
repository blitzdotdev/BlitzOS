package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	listenAddress          = "127.0.0.1:7445"
	dufsAddress            = "127.0.0.1:17445"
	terminalAddress        = "127.0.0.1:7443"
	terminalHost           = "localhost:7443"
	terminalOrigin         = "http://localhost:7443"
	actorAddress           = "127.0.0.1:7444"
	actorHost              = "localhost:7444"
	actorOrigin            = "http://localhost:7444"
	controlPlaneOriginPath = "/var/lib/blitz/origin"
	webAppTokenPath        = "/var/lib/blitz/webapp-token"
	workspaceIDPath        = "/var/lib/blitz/workspace-id"
	tunnelTokenPath        = "/var/lib/blitz/tunnel-token"
	previewsPath           = "/var/lib/blitz/previews.json"
	previewFocusPath       = "/var/lib/blitz/preview-focus.json"
	webAppTokenHeader      = "X-Blitz-WebApp-Token"
	corsAllowMethods       = "GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
	corsExposeHeaders      = "ETag, DAV, Content-Type, Content-Length, Last-Modified, Location"
)

var excludedPorts = map[int]struct{}{
	22:    {}, // sshd
	7443:  {}, // ttyd
	7444:  {}, // ACP actor
	7445:  {}, // this gateway
	17445: {}, // private dufs upstream
}

type portInfo struct {
	Port    int    `json:"port"`
	Process string `json:"process"`
}

type previewLink struct {
	Url       string `json:"url"`
	Title     string `json:"title"`
	Source    string `json:"source"`
	CreatedAt int64  `json:"createdAt"`
}

type gateway struct {
	dufs                   *httputil.ReverseProxy
	terminal               *url.URL
	actor                  *url.URL
	controlPlaneOriginPath string
	webAppTokenPath        string
	workspaceIDPath        string
	tunnelTokenPath        string
	previewsPath           string
	previewFocusPath       string
	discover               func() ([]portInfo, error)
	transport              http.RoundTripper
	authMu                 sync.Mutex
	authRequired           bool
	lastWebAppToken        string
	authFailureLogged      bool
	connectionsMu          sync.Mutex
	connections            map[net.Conn]webAppIdentity
}

type webAppIdentity struct {
	UserID       string `json:"userId"`
	MembershipID string `json:"membershipId"`
	Role         string `json:"role"`
}

type webAppTicketClaims struct {
	WorkspaceID  string `json:"workspaceId"`
	UserID       string `json:"userId"`
	MembershipID string `json:"membershipId"`
	Role         string `json:"role"`
	Exp          int64  `json:"exp"`
}

type drainTarget struct {
	MembershipID string `json:"membershipId"`
	UserID       string `json:"userId"`
}

type trackedConn struct {
	net.Conn
	onClose func()
	once    sync.Once
}

func (connection *trackedConn) Close() error {
	connection.once.Do(connection.onClose)
	return connection.Conn.Close()
}

type trackingResponseWriter struct {
	http.ResponseWriter
	gateway  *gateway
	identity webAppIdentity
}

func (writer *trackingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := writer.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	connection, buffered, err := hijacker.Hijack()
	if err != nil {
		return nil, nil, err
	}
	tracked := writer.gateway.trackConnection(connection, writer.identity)
	return tracked, buffered, nil
}

func main() {
	dufsURL := &url.URL{Scheme: "http", Host: dufsAddress}
	dufsProxy := httputil.NewSingleHostReverseProxy(dufsURL)
	dufsProxy.ErrorHandler = proxyError

	handler := &gateway{
		dufs:                   dufsProxy,
		terminal:               &url.URL{Scheme: "http", Host: terminalAddress},
		actor:                  &url.URL{Scheme: "http", Host: actorAddress},
		controlPlaneOriginPath: controlPlaneOriginPath,
		webAppTokenPath:        webAppTokenPath,
		workspaceIDPath:        workspaceIDPath,
		tunnelTokenPath:        tunnelTokenPath,
		previewsPath:           previewsPath,
		previewFocusPath:       previewFocusPath,
		discover:               func() ([]portInfo, error) { return discoverPorts("/proc", excludedPorts) },
		transport:              http.DefaultTransport,
	}
	server := &http.Server{
		Addr:              listenAddress,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	log.Printf("box gateway listening on %s (dufs upstream %s)", listenAddress, dufsAddress)
	log.Fatal(server.ListenAndServe())
}

func (g *gateway) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	webAppToken, workspaceID, authRequired, available := g.currentWebAppAuth()
	if !available {
		http.Error(response, "surface authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	identity := webAppIdentity{UserID: "legacy-owner", MembershipID: "legacy-owner", Role: "owner"}
	if authRequired {
		var allowed bool
		identity, allowed = webAppCredential(request, webAppToken, workspaceID, time.Now().Unix())
		if !allowed {
			http.Error(response, "webApp token forbidden", http.StatusForbidden)
			return
		}
	}
	if request.URL.Path == "/admin/drain" {
		// Drain closes every matching connection and an empty target matches
		// all of them, so it is an administrative switch, not a user surface.
		// The control plane calls it with the workspace token, which presents
		// as the owner.
		if identity.Role != "owner" && identity.Role != "admin" {
			http.Error(response, "forbidden", http.StatusForbidden)
			return
		}
		removeWebAppTokenHeader(request.Header)
		g.serveDrain(response, request)
		return
	}

	controlPlaneOrigin := loadControlPlaneOrigin(g.controlPlaneOriginPath)
	if isCORSPreflight(request) {
		removeWebAppTokenHeader(request.Header)
		serveCORSPreflight(response, request, controlPlaneOrigin, authRequired)
		return
	}
	webSocket := isWebSocketUpgrade(request)
	if webSocket {
		response = &trackingResponseWriter{ResponseWriter: response, gateway: g, identity: identity}
	}
	if webSocket && !originAllowed(request, controlPlaneOrigin) {
		http.Error(response, "websocket origin forbidden", http.StatusForbidden)
		return
	}
	if !webSocket {
		origin, allowed := allowedCORSOrigin(request, controlPlaneOrigin)
		response = &corsResponseWriter{ResponseWriter: response, origin: origin, allowed: allowed}
	}
	if request.URL.Path == "/ports" {
		removeWebAppTokenHeader(request.Header)
		g.servePorts(response, request)
		return
	}
	if request.URL.Path == "/previews" {
		removeWebAppTokenHeader(request.Header)
		g.servePreviews(response, request)
		return
	}
	if request.URL.Path == "/preview-focus" {
		removeWebAppTokenHeader(request.Header)
		g.servePreviewFocus(response, request)
		return
	}
	if request.URL.Path == "/terminal/ws" {
		removeWebAppTokenHeader(request.Header)
		g.serveTerminal(response, request)
		return
	}
	if request.URL.Path == "/acp" || strings.HasPrefix(request.URL.Path, "/acp/") {
		// The actor has no role guard of its own, so an observer reaching it
		// here would drive the agent.
		if identity.Role == "viewer" {
			http.Error(response, "viewers cannot drive the workspace agent", http.StatusForbidden)
			return
		}
		g.serveACP(response, request)
		return
	}
	removeWebAppTokenHeader(request.Header)
	if strings.HasPrefix(request.URL.Path, "/preview/") {
		// A preview proxies straight into whatever the workspace is running,
		// so an observer gets to look but not to send.
		if identity.Role == "viewer" && !filesReadMethod(request.Method) {
			response.Header().Set("Allow", "GET, HEAD, OPTIONS")
			http.Error(response, "viewer preview access is read-only", http.StatusForbidden)
			return
		}
		g.servePreview(response, request)
		return
	}
	if identity.Role == "viewer" && !filesReadMethod(request.Method) {
		response.Header().Set("Allow", "GET, HEAD, OPTIONS, PROPFIND")
		http.Error(response, "viewer file access is read-only", http.StatusForbidden)
		return
	}
	g.dufs.ServeHTTP(response, request)
}

func (g *gateway) trackConnection(connection net.Conn, identity webAppIdentity) net.Conn {
	tracked := &trackedConn{Conn: connection}
	tracked.onClose = func() {
		g.connectionsMu.Lock()
		delete(g.connections, tracked)
		g.connectionsMu.Unlock()
	}
	g.connectionsMu.Lock()
	if g.connections == nil {
		g.connections = make(map[net.Conn]webAppIdentity)
	}
	g.connections[tracked] = identity
	g.connectionsMu.Unlock()
	return tracked
}

func (g *gateway) serveDrain(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	target := drainTarget{}
	if request.Body != nil && request.ContentLength != 0 {
		decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 4<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&target); err != nil || requireJSONEOF(decoder) != nil || (target.MembershipID != "" && target.UserID != "") {
			http.Error(response, "invalid drain target", http.StatusBadRequest)
			return
		}
	}
	g.connectionsMu.Lock()
	connections := make([]net.Conn, 0, len(g.connections))
	for connection, identity := range g.connections {
		if target.MembershipID != "" && identity.MembershipID != target.MembershipID {
			continue
		}
		if target.UserID != "" && identity.UserID != target.UserID {
			continue
		}
		connections = append(connections, connection)
	}
	g.connectionsMu.Unlock()
	for _, connection := range connections {
		_ = connection.Close()
	}
	response.WriteHeader(http.StatusNoContent)
}

func (g *gateway) serveTerminal(response http.ResponseWriter, request *http.Request) {
	if identity, ok := request.Context().Value(webAppIdentityContextKey{}).(webAppIdentity); ok && identity.Role == "viewer" {
		if !forceReadOnlyTerminalArgs(request.URL) {
			http.Error(response, "terminal requires a session type and key", http.StatusBadRequest)
			return
		}
	}
	target := g.terminal
	if target == nil {
		target = &url.URL{Scheme: "http", Host: terminalAddress}
	}
	proxy := g.reverseProxy(target, "/ws", "", request)
	previousRewrite := proxy.Rewrite
	proxy.Rewrite = func(proxyRequest *httputil.ProxyRequest) {
		previousRewrite(proxyRequest)
		proxyRequest.Out.Host = terminalHost
		proxyRequest.Out.Header.Set("Origin", terminalOrigin)
	}
	proxy.ServeHTTP(response, request)
}

func (g *gateway) serveACP(response http.ResponseWriter, request *http.Request) {
	target := g.actor
	if target == nil {
		target = &url.URL{Scheme: "http", Host: actorAddress}
	}
	upstreamPath := strings.TrimPrefix(request.URL.Path, "/acp")
	if upstreamPath == "" {
		upstreamPath = "/"
	}
	proxy := g.reverseProxy(target, upstreamPath, "/acp", request)
	previousRewrite := proxy.Rewrite
	proxy.Rewrite = func(proxyRequest *httputil.ProxyRequest) {
		previousRewrite(proxyRequest)
		proxyRequest.Out.Host = actorHost
		proxyRequest.Out.Header.Set("Origin", actorOrigin)
	}
	proxy.ServeHTTP(response, request)
}

func (g *gateway) servePorts(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ports, err := g.discover()
	if err != nil {
		log.Printf("port discovery failed: %v", err)
		http.Error(response, "port discovery failed", http.StatusInternalServerError)
		return
	}
	if ports == nil {
		ports = []portInfo{}
	}

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(struct {
		Ports []portInfo `json:"ports"`
	}{Ports: ports}); err != nil {
		log.Printf("port response failed: %v", err)
	}
}

func parsePreviewLinks(data []byte) []previewLink {
	var entries []json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		return []previewLink{}
	}
	previews := make([]previewLink, 0, len(entries))
	for _, data := range entries {
		var fields struct {
			Url       *string `json:"url"`
			Title     *string `json:"title"`
			Source    *string `json:"source"`
			CreatedAt *int64  `json:"createdAt"`
		}
		if err := json.Unmarshal(data, &fields); err != nil ||
			fields.Url == nil || strings.TrimSpace(*fields.Url) == "" ||
			fields.Title == nil || fields.Source == nil || fields.CreatedAt == nil ||
			*fields.CreatedAt < -9007199254740991 || *fields.CreatedAt > 9007199254740991 {
			continue
		}
		previews = append(previews, previewLink{
			Url:       *fields.Url,
			Title:     *fields.Title,
			Source:    *fields.Source,
			CreatedAt: *fields.CreatedAt,
		})
	}
	return previews
}

func (g *gateway) servePreviews(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	previews := []previewLink{}
	data, err := os.ReadFile(g.previewsPath)
	if err == nil && len(bytes.TrimSpace(data)) > 0 {
		previews = parsePreviewLinks(data)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("preview state read failed: %v", err)
	}

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(struct {
		Previews []previewLink `json:"previews"`
	}{Previews: previews}); err != nil {
		log.Printf("preview response failed: %v", err)
	}
}

type previewFocus struct {
	Version     int    `json:"version"`
	Port        int    `json:"port"`
	Path        string `json:"path"`
	Title       string `json:"title"`
	RequestedAt int64  `json:"requestedAt"`
}

// parsePreviewFocus validates the marker `blitz preview open` writes. Anything
// that is not a version-1 object with a usable, non-reserved port and a
// rooted path is treated as no focus at all (nil), the same way the browser
// falls back to null. Unknown extra fields are tolerated for forward
// compatibility, matching parsePreviewLinks.
func parsePreviewFocus(data []byte) *previewFocus {
	var fields struct {
		Version     *int    `json:"version"`
		Port        *int    `json:"port"`
		Path        *string `json:"path"`
		Title       *string `json:"title"`
		RequestedAt *int64  `json:"requestedAt"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil
	}
	if fields.Version == nil || *fields.Version != 1 {
		return nil
	}
	if fields.Port == nil || *fields.Port < 1024 || *fields.Port > 65535 {
		return nil
	}
	if _, reserved := excludedPorts[*fields.Port]; reserved {
		return nil
	}
	if fields.Path == nil || !strings.HasPrefix(*fields.Path, "/") {
		return nil
	}
	if fields.Title == nil {
		return nil
	}
	if fields.RequestedAt == nil || *fields.RequestedAt < 0 || *fields.RequestedAt > 9007199254740991 {
		return nil
	}
	return &previewFocus{
		Version:     *fields.Version,
		Port:        *fields.Port,
		Path:        *fields.Path,
		Title:       *fields.Title,
		RequestedAt: *fields.RequestedAt,
	}
}

func (g *gateway) servePreviewFocus(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodOptions {
		response.WriteHeader(http.StatusNoContent)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var focus *previewFocus
	data, err := os.ReadFile(g.previewFocusPath)
	if err == nil && len(bytes.TrimSpace(data)) > 0 {
		focus = parsePreviewFocus(data)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("preview focus read failed: %v", err)
	}

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(struct {
		Focus *previewFocus `json:"focus"`
	}{Focus: focus}); err != nil {
		log.Printf("preview focus response failed: %v", err)
	}
}

type corsResponseWriter struct {
	http.ResponseWriter
	origin      string
	allowed     bool
	wroteHeader bool
}

func (response *corsResponseWriter) WriteHeader(status int) {
	if response.wroteHeader {
		return
	}
	response.prepareHeaders()
	response.wroteHeader = true
	response.ResponseWriter.WriteHeader(status)
}

func (response *corsResponseWriter) Write(body []byte) (int, error) {
	if !response.wroteHeader {
		response.WriteHeader(http.StatusOK)
	}
	return response.ResponseWriter.Write(body)
}

func (response *corsResponseWriter) Unwrap() http.ResponseWriter {
	return response.ResponseWriter
}

func (response *corsResponseWriter) prepareHeaders() {
	removeAccessControlHeaders(response.Header())
	if !response.allowed {
		return
	}
	response.Header().Set("Access-Control-Allow-Origin", response.origin)
	response.Header().Set("Access-Control-Expose-Headers", corsExposeHeaders)
	addVaryOrigin(response.Header())
}

func isCORSPreflight(request *http.Request) bool {
	return request.Method == http.MethodOptions && request.Header.Get("Access-Control-Request-Method") != ""
}

func serveCORSPreflight(response http.ResponseWriter, request *http.Request, controlPlaneOrigin string, authRequired bool) {
	removeAccessControlHeaders(response.Header())
	if origin, allowed := allowedCORSOrigin(request, controlPlaneOrigin); allowed {
		response.Header().Set("Access-Control-Allow-Origin", origin)
		response.Header().Set("Access-Control-Allow-Methods", corsAllowMethods)
		requestedHeaders := strings.Join(request.Header.Values("Access-Control-Request-Headers"), ",")
		if allowedHeaders := filterCORSRequestHeaders(requestedHeaders); allowedHeaders != "" {
			response.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
		} else if requestedHeaders == "" && !authRequired {
			response.Header().Set("Access-Control-Allow-Headers", "*")
		}
		response.Header().Set("Access-Control-Max-Age", "600")
		addVaryOrigin(response.Header())
	}
	response.WriteHeader(http.StatusNoContent)
}

func filterCORSRequestHeaders(requested string) string {
	allowed := make([]string, 0)
	for _, name := range strings.Split(requested, ",") {
		name = strings.TrimSpace(name)
		if name != "" && !strings.EqualFold(name, webAppTokenHeader) {
			allowed = append(allowed, name)
		}
	}
	return strings.Join(allowed, ", ")
}

func allowedCORSOrigin(request *http.Request, controlPlaneOrigin string) (string, bool) {
	origins := request.Header.Values("Origin")
	if len(origins) != 1 || origins[0] == "" || !originAllowed(request, controlPlaneOrigin) {
		return "", false
	}
	return origins[0], true
}

func removeAccessControlHeaders(header http.Header) {
	for name := range header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			header.Del(name)
		}
	}
}

func addVaryOrigin(header http.Header) {
	for _, value := range header.Values("Vary") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "Origin") {
				return
			}
		}
	}
	header.Add("Vary", "Origin")
}

func (g *gateway) servePreview(response http.ResponseWriter, request *http.Request) {
	port, upstreamPath, err := parsePreviewPath(request.URL.Path)
	if err != nil {
		http.Error(response, err.Error(), http.StatusBadRequest)
		return
	}
	if _, excluded := excludedPorts[port]; excluded {
		http.Error(response, "port is reserved by the box", http.StatusForbidden)
		return
	}

	target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", port)}
	prefix := fmt.Sprintf("/preview/%d", port)
	g.reverseProxy(target, upstreamPath, prefix, request).ServeHTTP(response, request)
}

func (g *gateway) reverseProxy(target *url.URL, upstreamPath, prefix string, request *http.Request) *httputil.ReverseProxy {
	originalHost := request.Host
	originalProto := request.Header.Get("X-Forwarded-Proto")
	return &httputil.ReverseProxy{
		Transport:     g.transport,
		FlushInterval: -1,
		ErrorHandler:  proxyError,
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(target)
			proxyRequest.Out.URL.Path = upstreamPath
			proxyRequest.Out.URL.RawPath = ""
			proxyRequest.Out.Host = target.Host
			proxyRequest.SetXForwarded()
			proxyRequest.Out.Header.Set("X-Forwarded-Host", originalHost)
			if originalProto != "" {
				proxyRequest.Out.Header.Set("X-Forwarded-Proto", originalProto)
			}
			if prefix != "" {
				proxyRequest.Out.Header.Set("X-Forwarded-Prefix", prefix)
			}
		},
	}
}

func loadControlPlaneOrigin(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func readOptionalFile(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func (g *gateway) currentWebAppAuth() (token string, workspaceID string, authRequired bool, available bool) {
	g.authMu.Lock()
	defer g.authMu.Unlock()

	data, err := os.ReadFile(g.webAppTokenPath)
	token = strings.TrimSpace(string(data))
	if err == nil && token != "" {
		g.authRequired = true
		g.lastWebAppToken = token
		return token, strings.TrimSpace(readOptionalFile(g.workspaceIDPath)), true, true
	}

	if g.authRequired {
		if !g.authFailureLogged {
			if err != nil {
				log.Printf("webApp token unavailable after authentication was enabled; continuing with last valid token: %v", err)
			} else {
				log.Printf("webApp token empty after authentication was enabled; continuing with last valid token")
			}
			g.authFailureLogged = true
		}
		return g.lastWebAppToken, strings.TrimSpace(readOptionalFile(g.workspaceIDPath)), true, true
	}

	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return "", "", true, false
	}
	if _, surfaceErr := os.Lstat(g.webAppTokenPath); !errors.Is(surfaceErr, os.ErrNotExist) {
		return "", "", true, false
	}
	if _, tunnelErr := os.Lstat(g.tunnelTokenPath); !errors.Is(tunnelErr, os.ErrNotExist) {
		return "", "", true, false
	}
	return "", "", false, true
}

type webAppIdentityContextKey struct{}

func webAppCredential(request *http.Request, secret, workspaceID string, now int64) (webAppIdentity, bool) {
	values := request.Header.Values(webAppTokenHeader)
	if len(values) != 1 {
		return webAppIdentity{}, false
	}
	credential := values[0]
	if !strings.HasPrefix(credential, "v1.") {
		// TODO(identity-phase-4): Remove static-token acceptance after every box image is re-pinned.
		if subtle.ConstantTimeCompare([]byte(credential), []byte(secret)) != 1 {
			return webAppIdentity{}, false
		}
		identity := webAppIdentity{UserID: "legacy-owner", MembershipID: "legacy-owner", Role: "owner"}
		*request = *request.WithContext(context.WithValue(request.Context(), webAppIdentityContextKey{}, identity))
		return identity, true
	}
	parts := strings.Split(credential, ".")
	if len(parts) != 3 || parts[0] != "v1" || workspaceID == "" {
		return webAppIdentity{}, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return webAppIdentity{}, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("v1." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return webAppIdentity{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return webAppIdentity{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	var claims webAppTicketClaims
	if err := decoder.Decode(&claims); err != nil || requireJSONEOF(decoder) != nil || claims.Exp <= now || claims.WorkspaceID != workspaceID {
		return webAppIdentity{}, false
	}
	if claims.UserID == "" || claims.MembershipID == "" || !validWebAppRole(claims.Role) {
		return webAppIdentity{}, false
	}
	identity := webAppIdentity{UserID: claims.UserID, MembershipID: claims.MembershipID, Role: claims.Role}
	*request = *request.WithContext(context.WithValue(request.Context(), webAppIdentityContextKey{}, identity))
	return identity, true
}

func requireJSONEOF(decoder *json.Decoder) error {
	var extra any
	err := decoder.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("multiple JSON values")
	}
	return err
}

func validWebAppRole(role string) bool {
	return role == "owner" || role == "admin" || role == "editor" || role == "viewer"
}

func filesReadMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions || method == "PROPFIND"
}

// forceReadOnlyTerminalArgs appends the read-only flag to a terminal request,
// reporting whether the request was shaped to take it.
//
// The contract is `<type> <key> [ro]`, positional. Anything other than the two
// positional arguments is refused rather than repaired: with one argument the
// appended "ro" would land in the session-key slot and blitz-term would
// default the mode back to read-write, handing an observer a writable shell.
func forceReadOnlyTerminalArgs(target *url.URL) bool {
	query := target.Query()
	args := query["arg"]
	// The client already asks for read-only; nothing to add.
	if len(args) == 3 && args[2] == "ro" {
		return true
	}
	if len(args) != 2 {
		return false
	}
	query.Del("arg")
	query.Add("arg", args[0])
	query.Add("arg", args[1])
	query.Add("arg", "ro")
	target.RawQuery = query.Encode()
	return true
}

func removeWebAppTokenHeader(header http.Header) {
	for name := range header {
		if strings.EqualFold(name, webAppTokenHeader) {
			delete(header, name)
		}
	}
}

func isWebSocketUpgrade(request *http.Request) bool {
	if !strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket") {
		return false
	}
	for _, value := range request.Header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

func originAllowed(request *http.Request, controlPlaneOrigin string) bool {
	origins := request.Header.Values("Origin")
	if len(origins) != 1 {
		return false
	}
	origin := origins[0]
	if controlPlaneOrigin != "" && origin == controlPlaneOrigin {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	host := parsed.Hostname()
	return strings.EqualFold(host, "localhost") || host == "127.0.0.1"
}

func parsePreviewPath(path string) (int, string, error) {
	remainder := strings.TrimPrefix(path, "/preview/")
	parts := strings.SplitN(remainder, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		return 0, "", errors.New("preview port is required")
	}
	port, err := strconv.Atoi(parts[0])
	if err != nil || port < 1 || port > 65535 {
		return 0, "", errors.New("preview port must be between 1 and 65535")
	}
	upstreamPath := "/"
	if len(parts) == 2 && parts[1] != "" {
		upstreamPath += parts[1]
	}
	return port, upstreamPath, nil
}

func proxyError(response http.ResponseWriter, request *http.Request, err error) {
	log.Printf("proxy %s %s failed: %v", request.Method, request.URL.Path, err)
	http.Error(response, "upstream unavailable", http.StatusBadGateway)
}

func discoverPorts(procRoot string, excluded map[int]struct{}) ([]portInfo, error) {
	portInodes := make(map[int]map[string]struct{})
	for _, name := range []string{"tcp", "tcp6"} {
		if err := readTCPTable(filepath.Join(procRoot, "net", name), portInodes); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}

	inodeProcesses := readSocketProcesses(procRoot)
	ports := make([]portInfo, 0, len(portInodes))
	for port, inodes := range portInodes {
		if _, excluded := excluded[port]; excluded {
			continue
		}
		processes := make(map[string]struct{})
		for inode := range inodes {
			if process := inodeProcesses[inode]; process != "" {
				processes[process] = struct{}{}
			}
		}
		if _, ok := processes["cloudflared"]; ok {
			continue
		}
		process := "unknown"
		if len(processes) > 0 {
			names := make([]string, 0, len(processes))
			for name := range processes {
				names = append(names, name)
			}
			sort.Strings(names)
			process = strings.Join(names, ",")
		}
		ports = append(ports, portInfo{Port: port, Process: process})
	}
	sort.Slice(ports, func(left, right int) bool { return ports[left].Port < ports[right].Port })
	return ports, nil
}

func readTCPTable(path string, ports map[int]map[string]struct{}) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for lineNumber, line := range strings.Split(string(data), "\n") {
		if lineNumber == 0 || strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 10 || fields[3] != "0A" {
			continue
		}
		address := fields[1]
		separator := strings.LastIndexByte(address, ':')
		if separator < 0 {
			continue
		}
		parsedPort, err := strconv.ParseUint(address[separator+1:], 16, 16)
		if err != nil {
			continue
		}
		port := int(parsedPort)
		if ports[port] == nil {
			ports[port] = make(map[string]struct{})
		}
		ports[port][fields[9]] = struct{}{}
	}
	return nil
}

func readSocketProcesses(procRoot string) map[string]string {
	processes := make(map[string]string)
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return processes
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		processDir := filepath.Join(procRoot, entry.Name())
		nameBytes, err := os.ReadFile(filepath.Join(processDir, "comm"))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(string(nameBytes))
		if name == "" {
			continue
		}
		fds, err := os.ReadDir(filepath.Join(processDir, "fd"))
		if err != nil {
			continue
		}
		for _, fd := range fds {
			target, err := os.Readlink(filepath.Join(processDir, "fd", fd.Name()))
			if err != nil || !strings.HasPrefix(target, "socket:[") || !strings.HasSuffix(target, "]") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")
			if processes[inode] == "" || name < processes[inode] {
				processes[inode] = name
			}
		}
	}
	return processes
}
