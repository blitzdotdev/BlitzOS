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
	"regexp"
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
	lodyBridgeSocketPath   = "/var/lib/blitz/lody-bridge.sock"
	lodySyncPath           = "/lody/sync"
	lodyRPCPath            = "/lody/rpc"
	lodyControlPath        = "/lody/control"
	lodyProjectPath        = "/lody/project"
	lodyPlatformPath       = "/lody/platform"
	controlPlaneOriginPath = "/var/lib/blitz/origin"
	webAppTokenPath        = "/var/lib/blitz/webapp-token"
	workspaceIDPath        = "/var/lib/blitz/workspace-id"
	tunnelTokenPath        = "/var/lib/blitz/tunnel-token"
	previewsPath           = "/var/lib/blitz/previews.json"
	previewFocusPath       = "/var/lib/blitz/preview-focus.json"
	connectionsFocusPath   = "/var/lib/blitz/connections-focus.json"
	agentCredentialPath    = "/var/lib/blitz/home/.claude/.credentials.json"
	webAppTokenHeader      = "X-Blitz-WebApp-Token"
	corsAllowMethods       = "GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, MKCOL, MOVE, COPY"
	corsExposeHeaders      = "ETag, DAV, Content-Type, Content-Length, Last-Modified, Location"
)

// lodyBridgeHost is a placeholder authority, not a name anything resolves. The
// Lody bridge listens on a unix socket, so the proxy's transport dials the path
// and ignores the address entirely; this only fills the Host header and keeps
// httputil.ReverseProxy's URL rewriting well-formed.
//
// lodyBridgeSocketPath above is that socket. Keep it short: `sun_path` caps a
// unix socket at 103 bytes, and the Lody daemon THROWS
// `local_ipc_socket_path_too_long` rather than falling back, so every socket
// path under /var/lib/blitz is budgeted against that cap
// (see /usr/local/libexec/blitz-lody-bridge). This one spends 31.
const lodyBridgeHost = "lody-bridge"

// The exact paths blitz-lody-bridge answers, each with the `/lody` prefix this
// gateway strips before forwarding. A prefix match would be wrong here: the
// bridge also serves `/healthz`, which is an operator probe and not a browser
// surface, and packages/schema/src/webapp-surface.ts lists these five exactly.
var lodyPaths = map[string]struct{}{
	lodySyncPath:     {},
	lodyRPCPath:      {},
	lodyControlPath:  {},
	lodyProjectPath:  {},
	lodyPlatformPath: {},
}

// Ports the box runs its own services on. A preview may never claim one, so
// this set both hides them from the discovered-port list and rejects a focus
// marker naming them. It mirrors packages/schema/src/preview.ts and the
// `blitz preview open` producer; all three are pinned to
// packages/schema/fixtures/preview-ports/reserved.json.
var excludedPorts = map[int]struct{}{
	22:    {}, // sshd
	7443:  {}, // ttyd
	7444:  {}, // retired ACP actor; stays reserved for boxes in the field
	7445:  {}, // this gateway
	7446:  {}, // public dufs file server
	17445: {}, // private dufs upstream
	17789: {}, // lody daemon's single-instance host lease
}

const (
	minPreviewPort      = 1024
	maxPreviewPort      = 65535
	maxPreviewPathBytes = 4096
)

// isPreviewPath mirrors isPreviewPath in packages/schema/src/preview.ts. The
// traversal rule is the load-bearing one: the browser normalizes
// `/preview/<port>/a/../../workspace/` before the request leaves the tab, so a
// `..` this reader passes on walks the iframe out of the `/preview/<port>/`
// prefix onto another box surface.
func isPreviewPath(path string) bool {
	if !strings.HasPrefix(path, "/") || len(path) > maxPreviewPathBytes {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
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
	dufsAddress            string
	terminal               *url.URL
	lody                   *url.URL
	lodyTransport          http.RoundTripper
	controlPlaneOriginPath string
	webAppTokenPath        string
	workspaceIDPath        string
	tunnelTokenPath        string
	previewsPath           string
	previewFocusPath       string
	connectionsFocusPath   string
	agentCredentialPath    string
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
		dufsAddress:            dufsAddress,
		terminal:               &url.URL{Scheme: "http", Host: terminalAddress},
		lody:                   &url.URL{Scheme: "http", Host: lodyBridgeHost},
		lodyTransport:          unixSocketTransport(lodyBridgeSocketPath),
		controlPlaneOriginPath: controlPlaneOriginPath,
		webAppTokenPath:        webAppTokenPath,
		workspaceIDPath:        workspaceIDPath,
		tunnelTokenPath:        tunnelTokenPath,
		previewsPath:           previewsPath,
		previewFocusPath:       previewFocusPath,
		connectionsFocusPath:   connectionsFocusPath,
		agentCredentialPath:    agentCredentialPath,
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
	webAppToken, workspaceID, authRequired, available, authDetail := g.currentWebAppAuth()
	if !available {
		deny(response, request, http.StatusServiceUnavailable, "surface authentication unavailable", authDetail)
		return
	}
	identity := webAppIdentity{UserID: "legacy-owner", MembershipID: "legacy-owner", Role: "owner"}
	if authRequired {
		var allowed bool
		identity, allowed = webAppCredential(request, webAppToken, workspaceID, time.Now().Unix())
		if !allowed {
			deny(response, request, http.StatusForbidden, "webApp token forbidden", webAppCredentialDetail(request, workspaceID))
			return
		}
	}
	if request.URL.Path == "/admin/drain" {
		// Drain closes every matching connection and an empty target matches
		// all of them, so it is an administrative switch, not a user surface.
		// The control plane calls it with the workspace token, which presents
		// as the owner.
		if identity.Role != "owner" && identity.Role != "admin" {
			deny(response, request, http.StatusForbidden, "drain forbidden", roleDetail(identity))
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
		// The refusal that cost hours: after a domain change every box kept
		// answering, kept looking healthy, and rejected every websocket
		// because the origin it was pinned to no longer existed. Both
		// origins are the deployment's own domains, so both go out.
		deny(response, request, http.StatusForbidden, "websocket origin forbidden", g.originDetail(controlPlaneOrigin, request))
		return
	}
	if !webSocket {
		origin, allowed := allowedCORSOrigin(request, controlPlaneOrigin)
		response = &corsResponseWriter{ResponseWriter: response, origin: origin, allowed: allowed}
	}
	if request.URL.Path == "/diag" {
		removeWebAppTokenHeader(request.Header)
		g.serveDiag(response, request, identity, controlPlaneOrigin, authRequired)
		return
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
	if request.URL.Path == "/connections-focus" {
		removeWebAppTokenHeader(request.Header)
		g.serveConnectionsFocus(response, request)
		return
	}
	if request.URL.Path == "/terminal/ws" {
		removeWebAppTokenHeader(request.Header)
		g.serveTerminal(response, request)
		return
	}
	if _, isLody := lodyPaths[request.URL.Path]; isLody {
		removeWebAppTokenHeader(request.Header)
		g.serveLody(response, request, identity, strings.TrimPrefix(request.URL.Path, "/lody"))
		return
	}
	removeWebAppTokenHeader(request.Header)
	if strings.HasPrefix(request.URL.Path, "/preview/") {
		// A preview proxies straight into whatever the workspace is running,
		// so an observer gets to look but not to send.
		if identity.Role == "viewer" && !filesReadMethod(request.Method) {
			response.Header().Set("Allow", "GET, HEAD, OPTIONS")
			deny(response, request, http.StatusForbidden, "viewer preview access is read-only", roleDetail(identity)+" method "+request.Method)
			return
		}
		g.servePreview(response, request)
		return
	}
	if identity.Role == "viewer" && !filesReadMethod(request.Method) {
		response.Header().Set("Allow", "GET, HEAD, OPTIONS, PROPFIND")
		deny(response, request, http.StatusForbidden, "viewer file access is read-only", roleDetail(identity)+" method "+request.Method)
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
			deny(response, request, http.StatusBadRequest, "terminal requires a session type and key",
				fmt.Sprintf("%s got %d positional arg values, want 2", roleDetail(identity), len(request.URL.Query()["arg"])))
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

// unixSocketTransport dials one unix socket whatever address the proxy asks
// for. http.Transport is what makes a websocket upgrade work over it: on a 101
// it hands the proxy a body that is also the writer, which is the only thing
// httputil.ReverseProxy needs to splice the two connections.
func unixSocketTransport(socketPath string) http.RoundTripper {
	return &http.Transport{
		DialContext: func(ctx context.Context, _ string, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
}

// serveLody proxies the browser's five doors into the Lody session daemon:
// `/lody/sync`, the websocket carrying its CRDT data plane; `/lody/rpc`,
// `/lody/control` and `/lody/project`, the three HTTP request planes (machine
// RPC, session control, local-project control); and `/lody/platform`, the
// daemon's own local identity and implicit workspace. All five land on
// blitz-lody-bridge, which re-serves the daemon's unix sockets on one of its
// own; nothing here talks to the daemon directly.
//
// The three added in phase 2 carry the same viewer policy as the first two, for
// the same reason: `/lody/control` posts `session/create`, which dispatches an
// agent turn, and `/lody/project` posts `local-project/checkout-branch`, which
// moves a git worktree. Neither is narrower than the sync socket.
//
// TODO(lody-phase6): a viewer is refused outright here. Sharing
// (plans/LODY-SESSIONS.md §0.1, phase 6) is what gives a read-only participant a
// scoped way in — a per-room ACL keyed to a share grant, enforced where the
// frames are, not a read-only HTTP method filter. Until that exists, "read-only"
// has no meaning on this surface: the sync socket is bidirectional and one
// `update` frame writes a session, so GET-versus-POST tells nobody anything. The
// `/preview/` and dufs branches below can narrow a viewer to reads because their
// protocols carry that distinction in the method; this one does not. Phase 6
// replaces this refusal with a grant lookup, and the enforcement point is the
// bridge, not here — the gateway cannot see frames.
func (g *gateway) serveLody(response http.ResponseWriter, request *http.Request, identity webAppIdentity, upstreamPath string) {
	if identity.Role == "viewer" {
		deny(response, request, http.StatusForbidden, "lody sessions are not available to viewers", roleDetail(identity))
		return
	}
	target := g.lody
	if target == nil {
		target = &url.URL{Scheme: "http", Host: lodyBridgeHost}
	}
	proxy := g.reverseProxy(target, upstreamPath, "", request)
	if g.lodyTransport != nil {
		proxy.Transport = g.lodyTransport
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

// diagService reports whether one of the box's internal listeners answers a
// TCP connect. It is a liveness probe, not a health check: the gateway proxies
// to these addresses, so "nothing is listening" and "something is listening"
// is the distinction that tells an operator which service died.
type diagService struct {
	Name      string `json:"name"`
	Address   string `json:"address"`
	Reachable bool   `json:"reachable"`
	Error     string `json:"error,omitempty"`
}

// diagReport is what `GET /diag` answers: the box state that decides whether a
// request is refused, and whether the services behind the gateway are up. No
// field carries a token, a signature, or the contents of any file.
type diagReport struct {
	WorkspaceID string `json:"workspaceId"`
	// ControlPlaneOrigin is the origin baked into the box when it was created,
	// the one a websocket Origin is compared against. Empty means the file is
	// missing or blank, which is the state that refused every websocket.
	ControlPlaneOrigin string `json:"controlPlaneOrigin"`
	// AuthRequired is false on a box that has no webApp token, where every
	// caller presents as the owner. It decides the role every guard reads.
	AuthRequired bool `json:"authRequired"`
	// AgentCredentialPresent costs one os.Stat and never a read: an agent that
	// cannot log in and an agent that never had a credential look identical
	// from the outside, and only the file's existence tells them apart.
	AgentCredentialPath    string        `json:"agentCredentialPath"`
	AgentCredentialPresent bool          `json:"agentCredentialPresent"`
	Services               []diagService `json:"services"`
}

// diagDialTimeout keeps /diag cheap. Everything it probes is on loopback, so a
// connect that has not completed by now is not going to.
const diagDialTimeout = 500 * time.Millisecond

func (g *gateway) serveDiag(response http.ResponseWriter, request *http.Request, identity webAppIdentity, controlPlaneOrigin string, authRequired bool) {
	// The same guard /admin/drain keeps: this is an operator surface, and a
	// member of the workspace has no business enumerating its plumbing.
	if identity.Role != "owner" && identity.Role != "admin" {
		deny(response, request, http.StatusForbidden, "diagnostics forbidden", roleDetail(identity))
		return
	}
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

	// Stat, never read. The credential is the one file named here that holds a
	// secret, and the answer an operator needs is only whether it is there.
	_, credentialErr := os.Stat(g.agentCredentialPath)
	report := diagReport{
		WorkspaceID:            strings.TrimSpace(readOptionalFile(g.workspaceIDPath)),
		ControlPlaneOrigin:     controlPlaneOrigin,
		AuthRequired:           authRequired,
		AgentCredentialPath:    g.agentCredentialPath,
		AgentCredentialPresent: credentialErr == nil,
		Services:               g.diagServices(),
	}
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(report); err != nil {
		log.Printf("diag response failed: %v", err)
	}
}

// diagServices probes the two addresses this gateway proxies to, and always
// both: a box that reports one service is not a diagnosis anyone can act on.
// main is the only place a gateway is built and it sets both, so the
// addresses are read straight off the struct.
func (g *gateway) diagServices() []diagService {
	services := make([]diagService, 0, 2)
	for _, service := range []diagService{
		{Name: "terminal", Address: g.terminal.Host},
		{Name: "dufs", Address: g.dufsAddress},
	} {
		connection, err := net.DialTimeout("tcp", service.Address, diagDialTimeout)
		if err == nil {
			service.Reachable = true
			_ = connection.Close()
		} else {
			service.Error = err.Error()
		}
		services = append(services, service)
	}
	return services
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
// that is not a version-1 object with a usable, non-reserved port and a rooted,
// traversal-free path is treated as no focus at all (nil), the same way the
// browser falls back to null. The marker is written by the in-box agent's own
// uid, so the CLI's checks are convenience, not a boundary: this reader repeats
// every one of them. Unknown extra fields are tolerated for forward
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
	if fields.Port == nil || *fields.Port < minPreviewPort || *fields.Port > maxPreviewPort {
		return nil
	}
	if _, reserved := excludedPorts[*fields.Port]; reserved {
		return nil
	}
	if fields.Path == nil || !isPreviewPath(*fields.Path) {
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

type connectionsFocus struct {
	Version     int    `json:"version"`
	Provider    string `json:"provider"`
	RequestedAt int64  `json:"requestedAt"`
}

// connectionsFocusProvider mirrors `isProviderName` in
// packages/schema/src/provider-name.ts, the one provider-name rule: a catalog
// id or a member-named generic connection, 1-63 characters (the control
// plane's grant validator cap), lowercase alphanumeric plus . _ -, starting
// alphanumeric. Go cannot import the TypeScript helper, so the fixture corpus
// packages/schema/fixtures/connections-focus/ is what pins the two together
// (and the CLI producer and the browser consumer with them).
var connectionsFocusProvider = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}$`)

// parseConnectionsFocus validates the marker `blitz connections open` writes.
// Anything that is not a version-1 object with a usable provider name and a
// safe non-negative requestedAt is treated as no focus at all (nil), the same
// way the browser falls back to null. The marker is written by the in-box
// agent's own uid, so the CLI's checks are convenience, not a boundary: this
// reader repeats every one of them. Unknown extra fields are tolerated for
// forward compatibility, matching parsePreviewFocus.
func parseConnectionsFocus(data []byte) *connectionsFocus {
	var fields struct {
		Version     *int    `json:"version"`
		Provider    *string `json:"provider"`
		RequestedAt *int64  `json:"requestedAt"`
	}
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil
	}
	if fields.Version == nil || *fields.Version != 1 {
		return nil
	}
	if fields.Provider == nil || !connectionsFocusProvider.MatchString(*fields.Provider) {
		return nil
	}
	if fields.RequestedAt == nil || *fields.RequestedAt < 0 || *fields.RequestedAt > 9007199254740991 {
		return nil
	}
	return &connectionsFocus{
		Version:     *fields.Version,
		Provider:    *fields.Provider,
		RequestedAt: *fields.RequestedAt,
	}
}

func (g *gateway) serveConnectionsFocus(response http.ResponseWriter, request *http.Request) {
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

	var focus *connectionsFocus
	data, err := os.ReadFile(g.connectionsFocusPath)
	if err == nil && len(bytes.TrimSpace(data)) > 0 {
		focus = parseConnectionsFocus(data)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("connections focus read failed: %v", err)
	}

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(struct {
		Focus *connectionsFocus `json:"focus"`
	}{Focus: focus}); err != nil {
		log.Printf("connections focus response failed: %v", err)
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
		deny(response, request, http.StatusForbidden, "port is reserved by the box", fmt.Sprintf("port %d", port))
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

func (g *gateway) currentWebAppAuth() (token string, workspaceID string, authRequired bool, available bool, detail string) {
	g.authMu.Lock()
	defer g.authMu.Unlock()

	data, err := os.ReadFile(g.webAppTokenPath)
	token = strings.TrimSpace(string(data))
	if err == nil && token != "" {
		g.authRequired = true
		g.lastWebAppToken = token
		return token, strings.TrimSpace(readOptionalFile(g.workspaceIDPath)), true, true, ""
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
		return g.lastWebAppToken, strings.TrimSpace(readOptionalFile(g.workspaceIDPath)), true, true, ""
	}

	if err == nil || !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return "", "", true, false, fmt.Sprintf("%s unreadable: %v", g.webAppTokenPath, err)
		}
		return "", "", true, false, fmt.Sprintf("%s is empty", g.webAppTokenPath)
	}
	if _, surfaceErr := os.Lstat(g.webAppTokenPath); !errors.Is(surfaceErr, os.ErrNotExist) {
		return "", "", true, false, fmt.Sprintf("%s exists but does not resolve: %v", g.webAppTokenPath, surfaceErr)
	}
	if _, tunnelErr := os.Lstat(g.tunnelTokenPath); !errors.Is(tunnelErr, os.ErrNotExist) {
		return "", "", true, false, fmt.Sprintf("%s is present without %s", g.tunnelTokenPath, g.webAppTokenPath)
	}
	return "", "", false, true, ""
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

// deny refuses a request and says why, in the log and in the response body.
//
// Every policy refusal used to be silent: the gateway wrote a bare status and
// logged nothing at all. After a control-plane domain change every existing
// box rejected every websocket, and the only evidence anywhere was one line
// in a browser console — the box logs, the workspace and the control plane all
// looked healthy. A refusal that cannot be read from the box is a refusal that
// costs hours, so an authorization decision that depends on box state goes
// through here and carries the state that decided it.
//
// The detail is required — a refusal with nothing to say does not need this
// helper — and it is operator-facing, never secret: roles, methods, ports,
// file paths and the deployment's own origins. Never a token, and never the
// contents of a credential file.
func deny(response http.ResponseWriter, request *http.Request, status int, reason, detail string) {
	// The detail goes in raw and last. It quotes the values inside itself, and
	// %q here would escape those quotes into a line nobody wants to read at
	// three in the morning.
	log.Printf("gateway refused %s %s: status=%d reason=%q detail=%s",
		request.Method, request.URL.Path, status, reason, detail)
	http.Error(response, reason+": "+detail, status)
}

// roleDetail names the caller without naming the credential that proved it.
func roleDetail(identity webAppIdentity) string {
	return fmt.Sprintf("role %q user %q", identity.Role, identity.UserID)
}

// originDetail reports both sides of the origin comparison. Neither is a
// secret — they are the deployment's own domains — and printing only one of
// them is what made the outage unreadable.
func (g *gateway) originDetail(controlPlaneOrigin string, request *http.Request) string {
	detail := fmt.Sprintf("expected %q got %q", controlPlaneOrigin, requestOrigin(request))
	if controlPlaneOrigin == "" {
		detail += fmt.Sprintf(" (%s is missing or empty)", g.controlPlaneOriginPath)
	}
	return detail
}

// requestOrigin renders the Origin header for a human. Zero headers reads as
// empty, and the several-headers case — itself a refusal reason — is joined
// rather than hidden behind the first value.
func requestOrigin(request *http.Request) string {
	origins := request.Header.Values("Origin")
	if len(origins) == 0 {
		return ""
	}
	return strings.Join(origins, ", ")
}

// webAppCredentialDetail says which way the credential failed without
// repeating any part of it. Which kind arrived — none, several, a static
// token, a v1 ticket — and the workspace id the box expects are the whole
// diagnosis; the credential itself never appears.
func webAppCredentialDetail(request *http.Request, workspaceID string) string {
	values := request.Header.Values(webAppTokenHeader)
	switch {
	case len(values) == 0:
		return fmt.Sprintf("no %s header", webAppTokenHeader)
	case len(values) > 1:
		return fmt.Sprintf("%d %s headers, want 1", len(values), webAppTokenHeader)
	case strings.HasPrefix(values[0], "v1."):
		return fmt.Sprintf("v1 ticket rejected (signature, expiry, role, or workspace id); box workspace id %q", workspaceID)
	default:
		return "static webApp token did not match the box token"
	}
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
