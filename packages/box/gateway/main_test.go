package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestParsePreviewPath(t *testing.T) {
	tests := []struct {
		path         string
		port         int
		upstreamPath string
		wantError    bool
	}{
		{path: "/preview/3000/", port: 3000, upstreamPath: "/"},
		{path: "/preview/5173/assets/app.js", port: 5173, upstreamPath: "/assets/app.js"},
		{path: "/preview/65535", port: 65535, upstreamPath: "/"},
		{path: "/preview/", wantError: true},
		{path: "/preview/nope/", wantError: true},
		{path: "/preview/65536/", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			port, path, err := parsePreviewPath(test.path)
			if (err != nil) != test.wantError {
				t.Fatalf("parsePreviewPath() error = %v, wantError %v", err, test.wantError)
			}
			if port != test.port || path != test.upstreamPath {
				t.Fatalf("parsePreviewPath() = (%d, %q), want (%d, %q)", port, path, test.port, test.upstreamPath)
			}
		})
	}
}

func TestGatewayRoutesPortsPreviewAndDufs(t *testing.T) {
	preview := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(response, strings.Join([]string{
			request.URL.RequestURI(),
			request.Header.Get("X-Forwarded-Prefix"),
			request.Header.Get("X-Forwarded-Proto"),
		}, "|"))
	}))
	defer preview.Close()
	previewPort := mustServerPort(t, preview.URL)

	dufs := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = io.WriteString(response, "dufs:"+request.URL.Path)
	}))
	defer dufs.Close()
	dufsURL, err := url.Parse(dufs.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler := &gateway{
		dufs:      httputil.NewSingleHostReverseProxy(dufsURL),
		discover:  func() ([]portInfo, error) { return []portInfo{{Port: 3000, Process: "node"}}, nil },
		transport: http.DefaultTransport,
	}

	portsRequest := httptest.NewRequest(http.MethodGet, "http://box/ports", nil)
	portsResponse := httptest.NewRecorder()
	handler.ServeHTTP(portsResponse, portsRequest)
	if portsResponse.Code != http.StatusOK || portsResponse.Body.String() != "{\"ports\":[{\"port\":3000,\"process\":\"node\"}]}\n" {
		t.Fatalf("unexpected /ports response: %d %q", portsResponse.Code, portsResponse.Body.String())
	}

	previewRequest := httptest.NewRequest(http.MethodGet, "http://box/preview/"+strconv.Itoa(previewPort)+"/nested?q=1", nil)
	previewRequest.Header.Set("X-Forwarded-Proto", "https")
	previewResponse := httptest.NewRecorder()
	handler.ServeHTTP(previewResponse, previewRequest)
	if previewResponse.Code != http.StatusOK || previewResponse.Body.String() != "/nested?q=1|/preview/"+strconv.Itoa(previewPort)+"|https" {
		t.Fatalf("unexpected preview response: %d %q", previewResponse.Code, previewResponse.Body.String())
	}

	dufsRequest := httptest.NewRequest(http.MethodGet, "http://box/workspace/file.txt", nil)
	dufsResponse := httptest.NewRecorder()
	handler.ServeHTTP(dufsResponse, dufsRequest)
	if dufsResponse.Code != http.StatusOK || dufsResponse.Body.String() != "dufs:/workspace/file.txt" {
		t.Fatalf("unexpected dufs response: %d %q", dufsResponse.Code, dufsResponse.Body.String())
	}
}

func TestCORSPreflight(t *testing.T) {
	const controlPlaneOrigin = "https://blitz-control-plane.example"
	dufsRequests := 0
	dufs := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		dufsRequests++
		response.Header().Set("X-Upstream-Method", request.Method)
		response.WriteHeader(http.StatusAccepted)
	}))
	defer dufs.Close()
	dufsURL, err := url.Parse(dufs.URL)
	if err != nil {
		t.Fatal(err)
	}

	discoverCalls := 0
	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(dufsURL),
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		discover: func() ([]portInfo, error) {
			discoverCalls++
			return nil, nil
		},
		transport: http.DefaultTransport,
	}

	t.Run("control plane PROPFIND", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "http://box/workspace/", nil)
		request.Header.Set("Origin", controlPlaneOrigin)
		request.Header.Set("Access-Control-Request-Method", "PROPFIND")
		request.Header.Set("Access-Control-Request-Headers", "Depth, Content-Type")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != controlPlaneOrigin {
			t.Errorf("Access-Control-Allow-Origin = %q", got)
		}
		if got := response.Header().Get("Access-Control-Allow-Methods"); got != corsAllowMethods {
			t.Errorf("Access-Control-Allow-Methods = %q", got)
		}
		if got := response.Header().Get("Access-Control-Allow-Headers"); got != "Depth, Content-Type" {
			t.Errorf("Access-Control-Allow-Headers = %q", got)
		}
		if got := response.Header().Get("Access-Control-Max-Age"); got != "600" {
			t.Errorf("Access-Control-Max-Age = %q", got)
		}
		if got := response.Header().Get("Vary"); got != "Origin" {
			t.Errorf("Vary = %q", got)
		}
	})

	t.Run("localhost any port and header fallback", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "http://box/ports", nil)
		request.Header.Set("Origin", "http://localhost:5173")
		request.Header.Set("Access-Control-Request-Method", http.MethodGet)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
			t.Errorf("Access-Control-Allow-Origin = %q", got)
		}
		if got := response.Header().Get("Access-Control-Allow-Headers"); got != "*" {
			t.Errorf("Access-Control-Allow-Headers = %q, want wildcard fallback", got)
		}
	})

	t.Run("OPTIONS without requested method follows normal routing", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "http://box/workspace/", nil)
		request.Header.Set("Origin", controlPlaneOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusAccepted {
			t.Fatalf("status = %d, want upstream status %d", response.Code, http.StatusAccepted)
		}
		if got := response.Header().Get("X-Upstream-Method"); got != http.MethodOptions {
			t.Errorf("upstream method = %q", got)
		}
		assertActualCORS(t, response.Header(), controlPlaneOrigin)
	})

	t.Run("disallowed origin", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "http://box/workspace/", nil)
		request.Header.Set("Origin", "https://evil.example")
		request.Header.Set("Access-Control-Request-Method", "PROPFIND")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
		assertNoAccessControlHeaders(t, response.Header())
	})

	if dufsRequests != 1 {
		t.Errorf("dufs request count = %d, want only the non-preflight OPTIONS", dufsRequests)
	}
	if discoverCalls != 0 {
		t.Errorf("discover call count = %d, want preflight to bypass /ports", discoverCalls)
	}
}

func TestCORSActualResponses(t *testing.T) {
	const controlPlaneOrigin = "https://blitz-control-plane.example"
	preview := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Access-Control-Allow-Origin", "*")
		response.Header().Set("Access-Control-Allow-Credentials", "true")
		response.Header().Set("ETag", `"preview-version"`)
		_, _ = io.WriteString(response, "preview")
	}))
	defer preview.Close()
	previewPort := mustServerPort(t, preview.URL)

	dufs := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Access-Control-Allow-Origin", "*")
		response.Header().Set("Access-Control-Allow-Credentials", "true")
		response.Header().Set("ETag", `"workspace-version"`)
		response.Header().Set("DAV", "1")
		response.WriteHeader(http.StatusMultiStatus)
	}))
	defer dufs.Close()
	dufsURL, err := url.Parse(dufs.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(dufsURL),
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		discover:               func() ([]portInfo, error) { return []portInfo{}, nil },
		transport:              http.DefaultTransport,
	}

	t.Run("PROPFIND dufs passthrough exposes ETag", func(t *testing.T) {
		request := httptest.NewRequest("PROPFIND", "http://box/workspace/", nil)
		request.Header.Set("Origin", controlPlaneOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusMultiStatus {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusMultiStatus)
		}
		if got := response.Header().Get("ETag"); got != `"workspace-version"` {
			t.Errorf("ETag = %q", got)
		}
		assertActualCORS(t, response.Header(), controlPlaneOrigin)
	})

	t.Run("ports", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box/ports", nil)
		request.Header.Set("Origin", "http://localhost:5173")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
		}
		assertActualCORS(t, response.Header(), "http://localhost:5173")
	})

	t.Run("preview", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box/preview/"+strconv.Itoa(previewPort)+"/", nil)
		request.Header.Set("Origin", controlPlaneOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
		}
		if got := response.Header().Get("ETag"); got != `"preview-version"` {
			t.Errorf("ETag = %q", got)
		}
		assertActualCORS(t, response.Header(), controlPlaneOrigin)
	})

	t.Run("evil origin strips upstream and route CORS", func(t *testing.T) {
		for _, path := range []string{"/ports", "/preview/" + strconv.Itoa(previewPort) + "/"} {
			request := httptest.NewRequest(http.MethodGet, "http://box"+path, nil)
			request.Header.Set("Origin", "https://evil.example")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusOK {
				t.Fatalf("%s status = %d, want %d", path, response.Code, http.StatusOK)
			}
			assertNoAccessControlHeaders(t, response.Header())
		}
	})

	t.Run("absent origin strips upstream CORS", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box/preview/"+strconv.Itoa(previewPort)+"/", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
		}
		assertNoAccessControlHeaders(t, response.Header())
	})
}

func TestWebSocketOriginPolicy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	upstreamPort := mustServerPort(t, upstream.URL)
	if _, excluded := excludedPorts[upstreamPort]; excluded {
		t.Fatalf("test upstream unexpectedly selected excluded port %d", upstreamPort)
	}

	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(upstreamURL),
		terminal:               upstreamURL,
		controlPlaneOriginPath: writeOriginFile(t, "https://blitz-control-plane.example"),
		discover:               func() ([]portInfo, error) { return nil, nil },
		transport:              http.DefaultTransport,
	}
	routes := []string{
		"/terminal/ws?arg=terminal&arg=origin-matrix",
		"/preview/" + strconv.Itoa(upstreamPort) + "/socket",
	}
	tests := []struct {
		name   string
		origin *string
		status int
	}{
		{name: "absent", status: http.StatusNoContent},
		{name: "localhost any port", origin: stringPointer("http://localhost:49152"), status: http.StatusNoContent},
		{name: "loopback IP any port", origin: stringPointer("https://127.0.0.1:8445"), status: http.StatusNoContent},
		{name: "control plane exact", origin: stringPointer("https://blitz-control-plane.example"), status: http.StatusNoContent},
		{name: "evil", origin: stringPointer("https://evil.example"), status: http.StatusForbidden},
	}

	for _, route := range routes {
		for _, test := range tests {
			t.Run(route+"/"+test.name, func(t *testing.T) {
				request := httptest.NewRequest(http.MethodGet, "http://box"+route, nil)
				request.Header.Set("Connection", "keep-alive, Upgrade")
				request.Header.Set("Upgrade", "websocket")
				if test.origin != nil {
					request.Header.Set("Origin", *test.origin)
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if response.Code != test.status {
					t.Fatalf("status = %d, want %d; body = %q", response.Code, test.status, response.Body.String())
				}
			})
		}
	}

	t.Run("plain HTTP keeps existing behavior", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box/preview/"+strconv.Itoa(upstreamPort)+"/plain", nil)
		request.Header.Set("Origin", "https://evil.example")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
		assertNoAccessControlHeaders(t, response.Header())
	})
}

func TestTerminalProxyHandshakeContract(t *testing.T) {
	type observedRequest struct {
		requestURI  string
		host        string
		origin      string
		subprotocol string
	}
	observed := make(chan observedRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		observed <- observedRequest{
			requestURI:  request.URL.RequestURI(),
			host:        request.Host,
			origin:      request.Header.Get("Origin"),
			subprotocol: request.Header.Get("Sec-WebSocket-Protocol"),
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler := &gateway{
		terminal:               upstreamURL,
		controlPlaneOriginPath: writeOriginFile(t, "https://blitz-control-plane.example"),
		transport:              http.DefaultTransport,
	}
	request := httptest.NewRequest(
		http.MethodGet,
		"http://box/terminal/ws?arg=terminal&arg=go-test&arg=ro",
		nil,
	)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Origin", "https://blitz-control-plane.example")
	request.Header.Set("Sec-WebSocket-Protocol", "tty")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
	}

	got := <-observed
	if got.requestURI != "/ws?arg=terminal&arg=go-test&arg=ro" {
		t.Errorf("upstream request URI = %q", got.requestURI)
	}
	if got.host != terminalHost {
		t.Errorf("upstream Host = %q, want %q", got.host, terminalHost)
	}
	if got.origin != terminalOrigin {
		t.Errorf("upstream Origin = %q, want %q", got.origin, terminalOrigin)
	}
	if got.subprotocol != "tty" {
		t.Errorf("upstream subprotocol = %q, want tty", got.subprotocol)
	}
}

func TestLoadControlPlaneOriginTrimsWhitespace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "origin")
	if err := os.WriteFile(path, []byte("  https://blitz-control-plane.example\n\t"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := loadControlPlaneOrigin(path); got != "https://blitz-control-plane.example" {
		t.Fatalf("loadControlPlaneOrigin() = %q", got)
	}
}

func TestWebSocketControlPlaneOriginAppearsAfterGatewayStart(t *testing.T) {
	const origin = "https://blitz-control-plane.example"
	originPath := filepath.Join(t.TempDir(), "origin")
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Connection", "Upgrade")
		response.Header().Set("Upgrade", "websocket")
		response.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}

	handler := &gateway{
		terminal:               upstreamURL,
		controlPlaneOriginPath: originPath,
		transport:              http.DefaultTransport,
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	check := func() int {
		request, err := http.NewRequest(http.MethodGet, server.URL+"/terminal/ws", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Origin", origin)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}

	if got := check(); got != http.StatusForbidden {
		t.Fatalf("status before origin file exists = %d, want %d", got, http.StatusForbidden)
	}
	if err := os.WriteFile(originPath, []byte("  "+origin+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := check(); got != http.StatusSwitchingProtocols {
		t.Fatalf("status after origin file is written = %d, want %d", got, http.StatusSwitchingProtocols)
	}
}

func TestDiscoverPorts(t *testing.T) {
	procRoot := t.TempDir()
	mustWrite(t, filepath.Join(procRoot, "net", "tcp"), strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0",
		"   1: 0100007F:1D15 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0",
		"   2: 0100007F:0FA0 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0",
	}, "\n"))
	mustWrite(t, filepath.Join(procRoot, "net", "tcp6"), strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 00000000000000000000000000000000:146B 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 100 0 0 10 0",
	}, "\n"))
	mustWrite(t, filepath.Join(procRoot, "41", "comm"), "node\n")
	if err := os.MkdirAll(filepath.Join(procRoot, "41", "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("socket:[111]", filepath.Join(procRoot, "41", "fd", "3")); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(procRoot, "42", "comm"), "python3\n")
	if err := os.MkdirAll(filepath.Join(procRoot, "42", "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("socket:[444]", filepath.Join(procRoot, "42", "fd", "4")); err != nil {
		t.Fatal(err)
	}

	got, err := discoverPorts(procRoot, map[int]struct{}{7445: {}})
	if err != nil {
		t.Fatal(err)
	}
	want := []portInfo{{Port: 3000, Process: "node"}, {Port: 5227, Process: "python3"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("discoverPorts() = %#v, want %#v", got, want)
	}
}

func mustWrite(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func writeOriginFile(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "origin")
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func mustServerPort(t *testing.T, rawURL string) int {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	_, portText, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func stringPointer(value string) *string {
	return &value
}

func assertActualCORS(t *testing.T, header http.Header, origin string) {
	t.Helper()
	if got := header.Get("Access-Control-Allow-Origin"); got != origin {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, origin)
	}
	if got := header.Get("Access-Control-Expose-Headers"); got != corsExposeHeaders {
		t.Errorf("Access-Control-Expose-Headers = %q, want %q", got, corsExposeHeaders)
	}
	if got := header.Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
	if got := header.Get("Access-Control-Allow-Credentials"); got != "" {
		t.Errorf("Access-Control-Allow-Credentials = %q, want absent", got)
	}
}

func assertNoAccessControlHeaders(t *testing.T, header http.Header) {
	t.Helper()
	for name, values := range header {
		if strings.HasPrefix(strings.ToLower(name), "access-control-") {
			t.Errorf("unexpected %s: %q", name, values)
		}
	}
}
