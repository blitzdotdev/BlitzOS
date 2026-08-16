package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
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
	surfaceTokenPath       = "/var/lib/blitz/surface-token"
	tunnelTokenPath        = "/var/lib/blitz/tunnel-token"
	surfaceTokenHeader     = "X-Blitz-Surface-Token"
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

type gateway struct {
	dufs                   *httputil.ReverseProxy
	terminal               *url.URL
	actor                  *url.URL
	controlPlaneOriginPath string
	surfaceTokenPath       string
	tunnelTokenPath        string
	discover               func() ([]portInfo, error)
	transport              http.RoundTripper
	authMu                 sync.Mutex
	authRequired           bool
	lastSurfaceToken       string
	authFailureLogged      bool
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
		surfaceTokenPath:       surfaceTokenPath,
		tunnelTokenPath:        tunnelTokenPath,
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
	surfaceToken, authRequired, available := g.currentSurfaceToken()
	if !available {
		http.Error(response, "surface authentication unavailable", http.StatusServiceUnavailable)
		return
	}
	if authRequired && !surfaceTokenAllowed(request, surfaceToken) {
		http.Error(response, "surface token forbidden", http.StatusForbidden)
		return
	}
	removeSurfaceTokenHeader(request.Header)

	controlPlaneOrigin := loadControlPlaneOrigin(g.controlPlaneOriginPath)
	if isCORSPreflight(request) {
		serveCORSPreflight(response, request, controlPlaneOrigin, authRequired)
		return
	}
	webSocket := isWebSocketUpgrade(request)
	if webSocket && !originAllowed(request, controlPlaneOrigin) {
		http.Error(response, "websocket origin forbidden", http.StatusForbidden)
		return
	}
	if !webSocket {
		origin, allowed := allowedCORSOrigin(request, controlPlaneOrigin)
		response = &corsResponseWriter{ResponseWriter: response, origin: origin, allowed: allowed}
	}
	if request.URL.Path == "/ports" {
		g.servePorts(response, request)
		return
	}
	if request.URL.Path == "/terminal/ws" {
		g.serveTerminal(response, request)
		return
	}
	if request.URL.Path == "/acp" || strings.HasPrefix(request.URL.Path, "/acp/") {
		g.serveACP(response, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/preview/") {
		g.servePreview(response, request)
		return
	}
	g.dufs.ServeHTTP(response, request)
}

func (g *gateway) serveTerminal(response http.ResponseWriter, request *http.Request) {
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
		if name != "" && !strings.EqualFold(name, surfaceTokenHeader) {
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

func (g *gateway) currentSurfaceToken() (token string, authRequired bool, available bool) {
	g.authMu.Lock()
	defer g.authMu.Unlock()

	data, err := os.ReadFile(g.surfaceTokenPath)
	token = strings.TrimSpace(string(data))
	if err == nil && token != "" {
		g.authRequired = true
		g.lastSurfaceToken = token
		return token, true, true
	}

	if g.authRequired {
		if !g.authFailureLogged {
			if err != nil {
				log.Printf("surface token unavailable after authentication was enabled; continuing with last valid token: %v", err)
			} else {
				log.Printf("surface token empty after authentication was enabled; continuing with last valid token")
			}
			g.authFailureLogged = true
		}
		return g.lastSurfaceToken, true, true
	}

	if err == nil || !errors.Is(err, os.ErrNotExist) {
		return "", true, false
	}
	if _, surfaceErr := os.Lstat(g.surfaceTokenPath); !errors.Is(surfaceErr, os.ErrNotExist) {
		return "", true, false
	}
	if _, tunnelErr := os.Lstat(g.tunnelTokenPath); !errors.Is(tunnelErr, os.ErrNotExist) {
		return "", true, false
	}
	return "", false, true
}

func surfaceTokenAllowed(request *http.Request, surfaceToken string) bool {
	values := request.Header.Values(surfaceTokenHeader)
	return len(values) == 1 && subtle.ConstantTimeCompare([]byte(values[0]), []byte(surfaceToken)) == 1
}

func removeSurfaceTokenHeader(header http.Header) {
	for name := range header {
		if strings.EqualFold(name, surfaceTokenHeader) {
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
	if len(origins) == 0 {
		return true
	}
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
