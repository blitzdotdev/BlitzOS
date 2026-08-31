package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func signedTicket(t *testing.T, secret string, claims webAppTicketClaims) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	input := "v1." + encoded
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(input))
	return input + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestServeEndTerminalSessionFixtures(t *testing.T) {
	fixturesDirectory := filepath.Join("..", "..", "schema", "fixtures", "terminal-session-end")
	entries, err := os.ReadDir(fixturesDirectory)
	if err != nil {
		t.Fatal(err)
	}
	fixtureCount := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		fixtureCount++
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(fixturesDirectory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Request json.RawMessage `json:"request"`
				Status  int             `json:"status"`
				Target  string          `json:"target"`
			}
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			var killed string
			handler := &gateway{endTmuxSession: func(target string) (bool, error) {
				killed = target
				return true, nil
			}}
			request := httptest.NewRequest(http.MethodPost, "http://box/terminal/session/end", bytes.NewReader(fixture.Request))
			response := httptest.NewRecorder()
			handler.serveEndTerminalSession(response, request)
			if response.Code != fixture.Status {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, fixture.Status, response.Body.String())
			}
			if fixture.Status == http.StatusOK {
				if killed != fixture.Target {
					t.Fatalf("kill target = %q, want %q", killed, fixture.Target)
				}
				var body struct {
					Ended bool `json:"ended"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				if !body.Ended {
					t.Fatalf("ended = false, want true")
				}
			} else if killed != "" {
				t.Fatalf("rejected request killed %q", killed)
			}
		})
	}
	if fixtureCount != 10 {
		t.Fatalf("terminal-session-end fixture count = %d, want 10", fixtureCount)
	}
}

func TestServeEndTerminalSessionReportsAbsentSession(t *testing.T) {
	handler := &gateway{endTmuxSession: func(string) (bool, error) { return false, nil }}
	request := httptest.NewRequest(http.MethodPost, "http://box/terminal/session/end",
		strings.NewReader(`{"kind":"claude","key":"gone"}`))
	response := httptest.NewRecorder()
	handler.serveEndTerminalSession(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if body := strings.TrimSpace(response.Body.String()); body != `{"ended":false}` {
		t.Fatalf("body = %q, want {\"ended\":false}", body)
	}
}

func TestEndTerminalSessionRejectsNonPost(t *testing.T) {
	handler := &gateway{endTmuxSession: func(string) (bool, error) { return true, nil }}
	get := httptest.NewRequest(http.MethodGet, "http://box/terminal/session/end", nil)
	getResponse := httptest.NewRecorder()
	handler.serveEndTerminalSession(getResponse, get)
	if getResponse.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status = %d, want 405", getResponse.Code)
	}
	if allow := getResponse.Header().Get("Allow"); allow != "POST, OPTIONS" {
		t.Fatalf("Allow = %q", allow)
	}
}

func writeGatewayIdentity(t *testing.T, secret, workspaceID string) (string, string) {
	t.Helper()
	directory := t.TempDir()
	tokenPath := filepath.Join(directory, "webapp-token")
	workspacePath := filepath.Join(directory, "workspace-id")
	if err := os.WriteFile(tokenPath, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(workspacePath, []byte(workspaceID), 0o600); err != nil {
		t.Fatal(err)
	}
	return tokenPath, workspacePath
}

func TestTicketVerificationAndViewerEnforcement(t *testing.T) {
	const secret = "workspace-ticket-secret"
	const workspaceID = "workspace-ticket"
	tokenPath, workspacePath := writeGatewayIdentity(t, secret, workspaceID)
	observed := make(chan string, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		observed <- request.URL.RequestURI()
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := &gateway{
		dufs:            httputil.NewSingleHostReverseProxy(upstreamURL),
		terminal:        upstreamURL,
		webAppTokenPath: tokenPath,
		workspaceIDPath: workspacePath,
		transport:       http.DefaultTransport,
	}
	viewer := webAppTicketClaims{
		WorkspaceID: workspaceID, UserID: "viewer-user", MembershipID: "viewer-member",
		Role: "viewer", Exp: time.Now().Unix() + 60,
	}
	request := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws?arg=terminal&arg=tab", nil)
	request.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
	request.Header.Set("Origin", "http://localhost:3000")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("terminal status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
	}
	if got := <-observed; got != "/ws?arg=terminal&arg=tab&arg=ro" {
		t.Fatalf("viewer terminal URI = %q", got)
	}

	// The read-only flag is positional. A request that is not shaped to
	// carry it is refused: appending "ro" to a single argument would put it
	// in the session-key slot, where blitz-term defaults the mode back to
	// read-write and hands the observer a writable shell.
	for _, query := range []string{"arg=terminal", "arg=terminal&arg=tab&arg=client-value", ""} {
		malformed := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws?"+query, nil)
		malformed.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
		malformed.Header.Set("Origin", "http://localhost:3000")
		malformedResponse := httptest.NewRecorder()
		handler.ServeHTTP(malformedResponse, malformed)
		if malformedResponse.Code != http.StatusBadRequest {
			t.Fatalf("viewer terminal %q status = %d, want %d", query, malformedResponse.Code, http.StatusBadRequest)
		}
	}

	// A client that already asked for read-only passes through unchanged.
	alreadyReadOnly := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws?arg=terminal&arg=tab&arg=ro", nil)
	alreadyReadOnly.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
	alreadyReadOnly.Header.Set("Origin", "http://localhost:3000")
	alreadyResponse := httptest.NewRecorder()
	handler.ServeHTTP(alreadyResponse, alreadyReadOnly)
	if alreadyResponse.Code != http.StatusNoContent {
		t.Fatalf("viewer read-only terminal status = %d", alreadyResponse.Code)
	}
	if got := <-observed; got != "/ws?arg=terminal&arg=tab&arg=ro" {
		t.Fatalf("viewer read-only terminal URI = %q", got)
	}

	// Viewers may look at a preview but not send to it.
	previewWrite := httptest.NewRequest(http.MethodPost, "http://box/preview/3000/api", strings.NewReader("x"))
	previewWrite.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
	previewResponse := httptest.NewRecorder()
	handler.ServeHTTP(previewResponse, previewWrite)
	if previewResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer preview write status = %d, want %d", previewResponse.Code, http.StatusForbidden)
	}

	// Drain is the control plane's switch, not a user surface.
	drainRequest := httptest.NewRequest(http.MethodPost, "http://box/admin/drain", strings.NewReader("{}"))
	drainRequest.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
	drainResponse := httptest.NewRecorder()
	handler.ServeHTTP(drainResponse, drainRequest)
	if drainResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer drain status = %d, want %d", drainResponse.Code, http.StatusForbidden)
	}

	writeRequest := httptest.NewRequest(http.MethodPut, "http://box/workspace/file.txt", strings.NewReader("write"))
	writeRequest.Header.Set(webAppTokenHeader, signedTicket(t, secret, viewer))
	writeResponse := httptest.NewRecorder()
	handler.ServeHTTP(writeResponse, writeRequest)
	if writeResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer write status = %d, want %d", writeResponse.Code, http.StatusForbidden)
	}

	expired := viewer
	expired.Exp = time.Now().Unix()
	expiredRequest := httptest.NewRequest(http.MethodGet, "http://box/workspace/file.txt", nil)
	expiredRequest.Header.Set(webAppTokenHeader, signedTicket(t, secret, expired))
	expiredResponse := httptest.NewRecorder()
	handler.ServeHTTP(expiredResponse, expiredRequest)
	if expiredResponse.Code != http.StatusForbidden {
		t.Fatalf("expired ticket status = %d, want %d", expiredResponse.Code, http.StatusForbidden)
	}
}

func TestTargetedDrainClosesOnlyMatchingIdentity(t *testing.T) {
	tokenPath, workspacePath := writeGatewayIdentity(t, "drain-target-secret", "workspace-drain")
	handler := &gateway{webAppTokenPath: tokenPath, workspaceIDPath: workspacePath}
	first, firstPeer := net.Pipe()
	second, secondPeer := net.Pipe()
	defer firstPeer.Close()
	defer secondPeer.Close()
	handler.trackConnection(first, webAppIdentity{UserID: "user-one", MembershipID: "member-one", Role: "editor"})
	handler.trackConnection(second, webAppIdentity{UserID: "user-two", MembershipID: "member-two", Role: "editor"})
	request := httptest.NewRequest(http.MethodPost, "/admin/drain", strings.NewReader(`{"membershipId":"member-one"}`))
	request.Header.Set(webAppTokenHeader, "drain-target-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("targeted drain status = %d", response.Code)
	}
	if _, err := firstPeer.Write([]byte("closed")); err == nil {
		t.Fatal("matching connection remained open")
	}
	go func() { _, _ = secondPeer.Write([]byte("open")) }()
	buffer := make([]byte, 4)
	if _, err := second.Read(buffer); err != nil || string(buffer) != "open" {
		t.Fatalf("nonmatching connection was closed: %v", err)
	}
	_ = second.Close()
}

func TestDrainRequiresTokenAndClosesTrackedConnections(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "webapp-token")
	if err := os.WriteFile(tokenPath, []byte("drain-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := &gateway{webAppTokenPath: tokenPath, tunnelTokenPath: filepath.Join(t.TempDir(), "tunnel-token")}
	client, peer := net.Pipe()
	defer peer.Close()
	handler.trackConnection(client, webAppIdentity{UserID: "user-drain", MembershipID: "member-drain", Role: "owner"})

	forbidden := httptest.NewRecorder()
	handler.ServeHTTP(forbidden, httptest.NewRequest(http.MethodPost, "/admin/drain", nil))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("unauthorized drain status = %d, want %d", forbidden.Code, http.StatusForbidden)
	}

	request := httptest.NewRequest(http.MethodPost, "/admin/drain", nil)
	request.Header.Set(webAppTokenHeader, "drain-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized drain status = %d, want %d", response.Code, http.StatusNoContent)
	}
	if _, err := peer.Write([]byte("closed")); err == nil {
		t.Fatal("tracked peer remained writable after drain")
	}
}

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

func TestGatewayLegacyRoutesWhenBothTokensAbsent(t *testing.T) {
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

	authDir := t.TempDir()
	handler := &gateway{
		dufs:            httputil.NewSingleHostReverseProxy(dufsURL),
		webAppTokenPath: filepath.Join(authDir, "webapp-token"),
		tunnelTokenPath: filepath.Join(authDir, "tunnel-token"),
		discover:        func() ([]portInfo, error) { return []portInfo{{Port: 3000, Process: "node"}}, nil },
		transport:       http.DefaultTransport,
	}

	portsRequest := httptest.NewRequest(http.MethodGet, "http://box/ports", nil)
	portsResponse := httptest.NewRecorder()
	handler.ServeHTTP(portsResponse, portsRequest)
	if portsResponse.Code != http.StatusOK || portsResponse.Body.String() != "{\"ports\":[{\"port\":3000,\"process\":\"node\"}]}\n" {
		t.Fatalf("unexpected /ports response: %d %q", portsResponse.Code, portsResponse.Body.String())
	}
	if got := portsResponse.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("/ports Cache-Control = %q, want no-store", got)
	}
	if got := portsResponse.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("/ports Content-Type = %q, want application/json", got)
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

func TestGatewayWebAppTokenAuthentication(t *testing.T) {
	upstreamRequests := 0
	dufs := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		upstreamRequests++
		response.WriteHeader(http.StatusNoContent)
	}))
	defer dufs.Close()
	dufsURL, err := url.Parse(dufs.URL)
	if err != nil {
		t.Fatal(err)
	}

	tokenPath := filepath.Join(t.TempDir(), "webapp-token")
	handler := &gateway{
		dufs:            httputil.NewSingleHostReverseProxy(dufsURL),
		webAppTokenPath: tokenPath,
		tunnelTokenPath: filepath.Join(filepath.Dir(tokenPath), "tunnel-token"),
		transport:       http.DefaultTransport,
	}
	request := func(token *string, webSocket bool) *httptest.ResponseRecorder {
		t.Helper()
		gatewayRequest := httptest.NewRequest(http.MethodGet, "http://box/workspace/file.txt", nil)
		if token != nil {
			gatewayRequest.Header.Set(webAppTokenHeader, *token)
		}
		if webSocket {
			gatewayRequest.Header.Set("Connection", "Upgrade")
			gatewayRequest.Header.Set("Upgrade", "websocket")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, gatewayRequest)
		return response
	}

	t.Run("absent file keeps current behavior", func(t *testing.T) {
		response := request(nil, false)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
	})

	const token = "opaque-webapp-token"
	if err := os.WriteFile(tokenPath, []byte("  "+token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("missing header is forbidden", func(t *testing.T) {
		response := request(nil, false)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	t.Run("websocket missing header is forbidden", func(t *testing.T) {
		response := request(nil, true)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	t.Run("wrong header is forbidden", func(t *testing.T) {
		wrongToken := token + "-wrong"
		response := request(&wrongToken, false)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	t.Run("correct header passes", func(t *testing.T) {
		response := request(stringPointer(token), false)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
	})

	if err := os.Remove(tokenPath); err != nil {
		t.Fatal(err)
	}

	t.Run("deleted file keeps enforcing the last valid token", func(t *testing.T) {
		response := request(stringPointer(token), false)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
	})

	t.Run("deleted file does not allow a missing header", func(t *testing.T) {
		response := request(nil, false)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	const rotatedToken = "rotated-webapp-token"
	if err := os.WriteFile(tokenPath, []byte(rotatedToken), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("new valid file value rotates the token", func(t *testing.T) {
		response := request(stringPointer(rotatedToken), false)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
		response = request(stringPointer(token), false)
		if response.Code != http.StatusForbidden {
			t.Fatalf("old token status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
		}
	})

	if upstreamRequests != 4 {
		t.Fatalf("upstream request count = %d, want legacy and three authenticated requests", upstreamRequests)
	}
}

func TestGatewayEmptyWebAppTokenFailsClosedEveryRoute(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		upstreamRequests++
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	upstreamPort := mustServerPort(t, upstream.URL)

	authDir := t.TempDir()
	webAppPath := filepath.Join(authDir, "webapp-token")
	if err := os.WriteFile(webAppPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	discoverCalls := 0
	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(upstreamURL),
		terminal:               upstreamURL,
		controlPlaneOriginPath: writeOriginFile(t, "https://blitz-control-plane.example"),
		webAppTokenPath:        webAppPath,
		tunnelTokenPath:        filepath.Join(authDir, "tunnel-token"),
		discover: func() ([]portInfo, error) {
			discoverCalls++
			return nil, nil
		},
		transport: http.DefaultTransport,
	}

	tests := []struct {
		name      string
		method    string
		path      string
		configure func(*http.Request)
	}{
		{name: "ports", method: http.MethodGet, path: "/ports"},
		{name: "dufs", method: http.MethodGet, path: "/workspace/file.txt"},
		{name: "preview", method: http.MethodGet, path: "/preview/" + strconv.Itoa(upstreamPort) + "/"},
		{
			name:   "terminal websocket",
			method: http.MethodGet,
			path:   "/terminal/ws",
			configure: func(request *http.Request) {
				request.Header.Set("Connection", "Upgrade")
				request.Header.Set("Upgrade", "websocket")
			},
		},
		{
			name:   "lody sync websocket",
			method: http.MethodGet,
			path:   lodySyncPath,
			configure: func(request *http.Request) {
				request.Header.Set("Connection", "Upgrade")
				request.Header.Set("Upgrade", "websocket")
			},
		},
		{name: "lody rpc", method: http.MethodPost, path: lodyRPCPath},
		{name: "lody session control", method: http.MethodPost, path: lodyControlPath},
		{name: "lody project control", method: http.MethodPost, path: lodyProjectPath},
		{name: "lody platform", method: http.MethodGet, path: lodyPlatformPath},
		{
			name:   "CORS preflight",
			method: http.MethodOptions,
			path:   "/workspace/file.txt",
			configure: func(request *http.Request) {
				request.Header.Set("Origin", "https://blitz-control-plane.example")
				request.Header.Set("Access-Control-Request-Method", http.MethodGet)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(test.method, "http://box"+test.path, nil)
			if test.configure != nil {
				test.configure(request)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusServiceUnavailable, response.Body.String())
			}
		})
	}
	if upstreamRequests != 0 {
		t.Errorf("upstream requests = %d, want 0", upstreamRequests)
	}
	if discoverCalls != 0 {
		t.Errorf("port discovery calls = %d, want 0", discoverCalls)
	}
}

func TestGatewayInvalidWebAppTokenFailsClosed(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T, string, string)
	}{
		{
			name: "whitespace only",
			setup: func(t *testing.T, webAppPath, _ string) {
				if err := os.WriteFile(webAppPath, []byte(" \n\t"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "webApp path is a directory",
			setup: func(t *testing.T, webAppPath, _ string) {
				if err := os.Mkdir(webAppPath, 0o700); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "tunnel token only",
			setup: func(t *testing.T, _, tunnelPath string) {
				if err := os.WriteFile(tunnelPath, []byte("tunnel-token"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			authDir := t.TempDir()
			webAppPath := filepath.Join(authDir, "webapp-token")
			tunnelPath := filepath.Join(authDir, "tunnel-token")
			test.setup(t, webAppPath, tunnelPath)
			handler := &gateway{
				webAppTokenPath: webAppPath,
				tunnelTokenPath: tunnelPath,
			}
			request := httptest.NewRequest(http.MethodGet, "http://box/ports", nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusServiceUnavailable, response.Body.String())
			}
		})
	}
}

func TestGatewayStripsWebAppTokenFromAllUpstreams(t *testing.T) {
	type observation struct {
		requestURI     string
		hasWebAppToken bool
	}
	observed := make(chan observation, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		hasWebAppToken := false
		for name := range request.Header {
			if strings.EqualFold(name, webAppTokenHeader) {
				hasWebAppToken = true
			}
		}
		observed <- observation{requestURI: request.URL.RequestURI(), hasWebAppToken: hasWebAppToken}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	upstreamPort := mustServerPort(t, upstream.URL)

	authDir := t.TempDir()
	webAppPath := filepath.Join(authDir, "webapp-token")
	const token = "opaque-webapp-token"
	if err := os.WriteFile(webAppPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := &gateway{
		dufs:            httputil.NewSingleHostReverseProxy(upstreamURL),
		terminal:        upstreamURL,
		lody:            upstreamURL,
		webAppTokenPath: webAppPath,
		tunnelTokenPath: filepath.Join(authDir, "tunnel-token"),
		transport:       http.DefaultTransport,
	}
	// Every route that reaches an upstream.
	tests := []struct {
		name        string
		path        string
		upstreamURI string
		webSocket   bool
	}{
		{name: "dufs", path: "/workspace/file.txt", upstreamURI: "/workspace/file.txt"},
		{name: "preview", path: "/preview/" + strconv.Itoa(upstreamPort) + "/asset.js?x=1", upstreamURI: "/asset.js?x=1"},
		{name: "terminal websocket", path: "/terminal/ws?arg=terminal", upstreamURI: "/ws?arg=terminal", webSocket: true},
		{name: "lody sync websocket", path: lodySyncPath, upstreamURI: "/sync", webSocket: true},
		{name: "lody rpc", path: lodyRPCPath, upstreamURI: "/rpc"},
		{name: "lody session control", path: lodyControlPath, upstreamURI: "/control"},
		{name: "lody project control", path: lodyProjectPath, upstreamURI: "/project"},
		{name: "lody platform", path: lodyPlatformPath, upstreamURI: "/platform"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://box"+test.path, nil)
			request.Header.Set(webAppTokenHeader, token)
			if test.webSocket {
				request.Header.Set("Connection", "Upgrade")
				request.Header.Set("Upgrade", "websocket")
				request.Header.Set("Origin", "http://localhost:3000")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
			}
			got := <-observed
			if got.requestURI != test.upstreamURI {
				t.Errorf("upstream request URI = %q, want %q", got.requestURI, test.upstreamURI)
			}
			if got.hasWebAppToken {
				t.Errorf("upstream token presence = %v, want false", got.hasWebAppToken)
			}
		})
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

	t.Run("webApp token header is filtered case-insensitively", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "http://box/workspace/", nil)
		request.Header.Set("Origin", controlPlaneOrigin)
		request.Header.Set("Access-Control-Request-Method", "PROPFIND")
		request.Header.Set("Access-Control-Request-Headers", "Depth, x-blitz-webapp-token, Content-Type")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)

		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
		if got := response.Header().Get("Access-Control-Allow-Headers"); got != "Depth, Content-Type" {
			t.Errorf("Access-Control-Allow-Headers = %q", got)
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

func TestAuthenticatedCORSPreflightNeverAllowsWebAppToken(t *testing.T) {
	const (
		controlPlaneOrigin = "https://blitz-control-plane.example"
		token              = "opaque-webapp-token"
	)
	authDir := t.TempDir()
	webAppPath := filepath.Join(authDir, "webapp-token")
	if err := os.WriteFile(webAppPath, []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := &gateway{
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		webAppTokenPath:        webAppPath,
		tunnelTokenPath:        filepath.Join(authDir, "tunnel-token"),
	}

	tests := []struct {
		name             string
		requestedHeaders string
		wantAllowHeaders string
	}{
		{name: "no requested headers"},
		{
			name:             "mixed requested headers",
			requestedHeaders: "Depth, X-BLITZ-WEBAPP-TOKEN, Content-Type",
			wantAllowHeaders: "Depth, Content-Type",
		},
		{
			name:             "webApp token only",
			requestedHeaders: "x-blitz-webapp-token",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, "http://box/workspace/", nil)
			request.Header.Set(webAppTokenHeader, token)
			request.Header.Set("Origin", controlPlaneOrigin)
			request.Header.Set("Access-Control-Request-Method", "PROPFIND")
			if test.requestedHeaders != "" {
				request.Header.Set("Access-Control-Request-Headers", test.requestedHeaders)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
			}
			got := response.Header().Get("Access-Control-Allow-Headers")
			if got != test.wantAllowHeaders {
				t.Errorf("Access-Control-Allow-Headers = %q, want %q", got, test.wantAllowHeaders)
			}
			if got == "*" || strings.Contains(strings.ToLower(got), strings.ToLower(webAppTokenHeader)) {
				t.Errorf("unsafe Access-Control-Allow-Headers = %q", got)
			}
		})
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
		{name: "absent", status: http.StatusForbidden},
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

// The Lody bridge listens on a unix socket, not a port, so this drives the real
// transport main() installs rather than a TCP stand-in: a wrong dial network or
// a dropped socket path would 502 here and nowhere else. It also pins the two
// upstream paths, because the gateway is what turns /lody/sync into /sync.
func TestLodyProxyRoutesThroughUnixSocket(t *testing.T) {
	type observedRequest struct {
		requestURI string
		host       string
		method     string
		body       string
	}
	observed := make(chan observedRequest, 4)
	socketPath := filepath.Join(t.TempDir(), "lody-bridge.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	upstream := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, readErr := io.ReadAll(request.Body)
		if readErr != nil {
			t.Errorf("reading upstream body: %v", readErr)
		}
		observed <- observedRequest{
			requestURI: request.URL.RequestURI(),
			host:       request.Host,
			method:     request.Method,
			body:       string(body),
		}
		response.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = upstream.Serve(listener) }()
	defer func() { _ = upstream.Close() }()

	const secret = "lody-ticket-secret"
	const workspaceID = "workspace-lody"
	const controlPlaneOrigin = "https://blitz-control-plane.example"
	tokenPath, workspacePath := writeGatewayIdentity(t, secret, workspaceID)
	handler := &gateway{
		// A path that is NOT a lody door falls through to dufs, and this suite
		// has one such case on purpose ("healthz is not a lody door"). Without a
		// proxy here that fall-through is a nil dereference, which panics the
		// whole suite rather than failing one case.
		dufs:                   httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: "dufs.invalid"}),
		lody:                   &url.URL{Scheme: "http", Host: lodyBridgeHost},
		lodyTransport:          unixSocketTransport(socketPath),
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		webAppTokenPath:        tokenPath,
		workspaceIDPath:        workspacePath,
		transport:              http.DefaultTransport,
	}
	ticketFor := func(role string) string {
		return signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID:  workspaceID,
			UserID:       "member-user",
			MembershipID: "member-membership",
			Role:         role,
			Exp:          time.Now().Add(time.Hour).Unix(),
		})
	}

	t.Run("editor reaches the sync websocket", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box"+lodySyncPath, nil)
		request.Header.Set(webAppTokenHeader, ticketFor("editor"))
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Origin", controlPlaneOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
		got := <-observed
		if got.requestURI != "/sync" {
			t.Errorf("upstream request URI = %q, want %q", got.requestURI, "/sync")
		}
		if got.host != lodyBridgeHost {
			t.Errorf("upstream Host = %q, want %q", got.host, lodyBridgeHost)
		}
	})

	// The three POST planes are separate doors on one control socket, so the
	// body has to survive and the upstream path has to be the one the bridge
	// maps to that plane. A path collapsed into another is the failure this
	// catches: the bodies are three different request unions.
	for _, plane := range []struct {
		name        string
		path        string
		upstreamURI string
		payload     string
	}{
		{name: "machine rpc", path: lodyRPCPath, upstreamURI: "/rpc", payload: `{"method":"session/terminate"}`},
		{name: "session control", path: lodyControlPath, upstreamURI: "/control", payload: `{"type":"machine/status"}`},
		{name: "project control", path: lodyProjectPath, upstreamURI: "/project", payload: `{"type":"local-project/list"}`},
	} {
		t.Run("owner reaches "+plane.name+" with its body", func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "http://box"+plane.path, strings.NewReader(plane.payload))
			request.Header.Set(webAppTokenHeader, ticketFor("owner"))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
			}
			got := <-observed
			if got.requestURI != plane.upstreamURI {
				t.Errorf("upstream request URI = %q, want %q", got.requestURI, plane.upstreamURI)
			}
			if got.method != http.MethodPost {
				t.Errorf("upstream method = %q, want POST", got.method)
			}
			if got.body != plane.payload {
				t.Errorf("upstream body = %q, want %q", got.body, plane.payload)
			}
		})
	}

	t.Run("editor reads the platform snapshot", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box"+lodyPlatformPath, nil)
		request.Header.Set(webAppTokenHeader, ticketFor("editor"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusNoContent, response.Body.String())
		}
		got := <-observed
		if got.requestURI != "/platform" {
			t.Errorf("upstream request URI = %q, want %q", got.requestURI, "/platform")
		}
	})

	// The bridge's own operator probe is not a browser surface, so the gateway
	// must not have grown a `/lody/` prefix match on the way to five paths.
	t.Run("healthz is not a lody door", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "http://box/lody/healthz", nil)
		request.Header.Set(webAppTokenHeader, ticketFor("owner"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		select {
		case got := <-observed:
			t.Errorf("upstream saw %q, want nothing", got.requestURI)
		default:
		}
	})

	// A viewer is refused on both paths, and refused before anything is
	// forwarded: the sync socket is bidirectional, so a read-only participant
	// has no meaning here until sharing (phase 6) can filter frames per grant.
	for _, refused := range []struct {
		name      string
		method    string
		path      string
		webSocket bool
	}{
		{name: "viewer sync", method: http.MethodGet, path: lodySyncPath, webSocket: true},
		{name: "viewer rpc", method: http.MethodPost, path: lodyRPCPath},
		{name: "viewer session control", method: http.MethodPost, path: lodyControlPath},
		{name: "viewer project control", method: http.MethodPost, path: lodyProjectPath},
		{name: "viewer platform", method: http.MethodGet, path: lodyPlatformPath},
	} {
		t.Run(refused.name, func(t *testing.T) {
			request := httptest.NewRequest(refused.method, "http://box"+refused.path, nil)
			request.Header.Set(webAppTokenHeader, ticketFor("viewer"))
			request.Header.Set("Origin", controlPlaneOrigin)
			if refused.webSocket {
				request.Header.Set("Connection", "Upgrade")
				request.Header.Set("Upgrade", "websocket")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusForbidden, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), "not available to viewers") {
				t.Errorf("body = %q, want the viewer refusal reason", response.Body.String())
			}
			select {
			case got := <-observed:
				t.Errorf("upstream saw %q, want nothing", got.requestURI)
			default:
			}
		})
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

func TestServePreviewsFixtures(t *testing.T) {
	fixturesDirectory := filepath.Join("..", "..", "schema", "fixtures", "previews")
	entries, err := os.ReadDir(fixturesDirectory)
	if err != nil {
		t.Fatal(err)
	}
	fixtureCount := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		fixtureCount++
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(fixturesDirectory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Input struct {
					Previews json.RawMessage `json:"previews"`
				} `json:"input"`
				Expected json.RawMessage `json:"expected"`
			}
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(t.TempDir(), "previews.json")
			if err := os.WriteFile(statePath, fixture.Input.Previews, 0o600); err != nil {
				t.Fatal(err)
			}
			handler := &gateway{previewsPath: statePath}
			request := httptest.NewRequest(http.MethodGet, "http://box/previews", nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusOK, response.Body.String())
			}
			if got := response.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q", got)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			var gotValue interface{}
			var expectedValue interface{}
			if err := json.Unmarshal(response.Body.Bytes(), &gotValue); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(fixture.Expected, &expectedValue); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotValue, expectedValue) {
				t.Fatalf("response = %s, want %s", response.Body.String(), fixture.Expected)
			}
		})
	}
	if fixtureCount != 4 {
		t.Fatalf("preview fixture count = %d, want 4", fixtureCount)
	}
}

func TestServePreviewsEmptyAbsentAndMethod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "previews.json")
	handler := &gateway{previewsPath: statePath}
	request := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "http://box/previews", nil))
		return response
	}

	for _, test := range []struct {
		name  string
		write bool
	}{
		{name: "absent"},
		{name: "empty", write: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.write {
				if err := os.WriteFile(statePath, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			response := request(http.MethodGet)
			if response.Code != http.StatusOK || response.Body.String() != "{\"previews\":[]}\n" {
				t.Fatalf("status = %d; body = %q", response.Code, response.Body.String())
			}
		})
	}

	response := request(http.MethodPost)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	if got := response.Header().Get("Allow"); got != "GET, OPTIONS" {
		t.Fatalf("Allow = %q", got)
	}
}

func TestServePreviewFocusFixtures(t *testing.T) {
	fixturesDirectory := filepath.Join("..", "..", "schema", "fixtures", "preview-focus")
	entries, err := os.ReadDir(fixturesDirectory)
	if err != nil {
		t.Fatal(err)
	}
	fixtureCount := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		fixtureCount++
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(fixturesDirectory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Input    json.RawMessage `json:"input"`
				Expected json.RawMessage `json:"expected"`
			}
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(t.TempDir(), "preview-focus.json")
			// A fixture whose marker is JSON null stands for an absent file.
			if strings.TrimSpace(string(fixture.Input)) != "null" {
				if err := os.WriteFile(statePath, fixture.Input, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			handler := &gateway{previewFocusPath: statePath}
			request := httptest.NewRequest(http.MethodGet, "http://box/preview-focus", nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusOK, response.Body.String())
			}
			if got := response.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q", got)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			var gotValue interface{}
			var expectedValue interface{}
			if err := json.Unmarshal(response.Body.Bytes(), &gotValue); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(fixture.Expected, &expectedValue); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotValue, expectedValue) {
				t.Fatalf("response = %s, want %s", response.Body.String(), fixture.Expected)
			}
		})
	}
	if fixtureCount != 8 {
		t.Fatalf("preview-focus fixture count = %d, want 8", fixtureCount)
	}
}

// The reserved-port set exists in three runtimes that cannot import each other.
// A port one of them serves and another drops makes a preview vanish, so pin
// this mirror to the shared definition.
func TestExcludedPortsMatchSharedFixture(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "schema", "fixtures", "preview-ports", "reserved.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		MinPort       int   `json:"minPort"`
		MaxPort       int   `json:"maxPort"`
		MaxPathLength int   `json:"maxPathLength"`
		ReservedPorts []int `json:"reservedPorts"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.MinPort != minPreviewPort || fixture.MaxPort != maxPreviewPort {
		t.Fatalf("port range = %d-%d, want %d-%d", minPreviewPort, maxPreviewPort, fixture.MinPort, fixture.MaxPort)
	}
	if fixture.MaxPathLength != maxPreviewPathBytes {
		t.Fatalf("maxPreviewPathBytes = %d, want %d", maxPreviewPathBytes, fixture.MaxPathLength)
	}
	if len(fixture.ReservedPorts) != len(excludedPorts) {
		t.Fatalf("excludedPorts has %d entries, want %d", len(excludedPorts), len(fixture.ReservedPorts))
	}
	for _, port := range fixture.ReservedPorts {
		if _, reserved := excludedPorts[port]; !reserved {
			t.Fatalf("excludedPorts is missing reserved port %d", port)
		}
	}
}

func TestIsPreviewPath(t *testing.T) {
	for _, test := range []struct {
		path string
		want bool
	}{
		{path: "/", want: true},
		{path: "/dashboard", want: true},
		{path: "/a..b", want: true},
		{path: "/" + strings.Repeat("a", maxPreviewPathBytes-1), want: true},
		{path: "dashboard"},
		{path: ""},
		{path: "/.."},
		{path: "/../workspace/"},
		{path: "/app/../../workspace/"},
		{path: "/" + strings.Repeat("a", maxPreviewPathBytes)},
	} {
		if got := isPreviewPath(test.path); got != test.want {
			t.Fatalf("isPreviewPath(%q) = %v, want %v", test.path, got, test.want)
		}
	}

	// The same verdicts through the marker parser the gateway actually uses.
	marker := func(path string) []byte {
		encoded, err := json.Marshal(map[string]any{
			"version": 1, "port": 3000, "path": path, "title": "t", "requestedAt": 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	if parsePreviewFocus(marker("/app/../../workspace/")) != nil {
		t.Fatal("parsePreviewFocus kept a traversal path")
	}
	if parsePreviewFocus(marker("/"+strings.Repeat("a", maxPreviewPathBytes))) != nil {
		t.Fatal("parsePreviewFocus kept an over-long path")
	}
	if parsePreviewFocus(marker("/dashboard")) == nil {
		t.Fatal("parsePreviewFocus dropped a usable path")
	}
}

func TestServePreviewFocusEmptyAbsentAndMethod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "preview-focus.json")
	handler := &gateway{previewFocusPath: statePath}
	request := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "http://box/preview-focus", nil))
		return response
	}

	for _, test := range []struct {
		name  string
		write bool
	}{
		{name: "absent"},
		{name: "empty", write: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.write {
				if err := os.WriteFile(statePath, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			response := request(http.MethodGet)
			if response.Code != http.StatusOK || response.Body.String() != "{\"focus\":null}\n" {
				t.Fatalf("status = %d; body = %q", response.Code, response.Body.String())
			}
		})
	}

	response := request(http.MethodPost)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	if got := response.Header().Get("Allow"); got != "GET, OPTIONS" {
		t.Fatalf("Allow = %q", got)
	}
}

// Reader side of the connections-focus cross-runtime contract. The CLI
// producer is pinned against the same fixtures in
// packages/box/guest-tests/test/connections-focus-conformance.test.ts, the browser
// consumer in packages/webapp/test/connections-focus.test.ts.
func TestServeConnectionsFocusFixtures(t *testing.T) {
	fixturesDirectory := filepath.Join("..", "..", "schema", "fixtures", "connections-focus")
	entries, err := os.ReadDir(fixturesDirectory)
	if err != nil {
		t.Fatal(err)
	}
	fixtureCount := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		fixtureCount++
		t.Run(entry.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join(fixturesDirectory, entry.Name()))
			if err != nil {
				t.Fatal(err)
			}
			var fixture struct {
				Input    json.RawMessage `json:"input"`
				Expected json.RawMessage `json:"expected"`
			}
			if err := json.Unmarshal(data, &fixture); err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(t.TempDir(), "connections-focus.json")
			// A fixture whose marker is JSON null stands for an absent file.
			if strings.TrimSpace(string(fixture.Input)) != "null" {
				if err := os.WriteFile(statePath, fixture.Input, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			handler := &gateway{connectionsFocusPath: statePath}
			request := httptest.NewRequest(http.MethodGet, "http://box/connections-focus", nil)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body = %q", response.Code, http.StatusOK, response.Body.String())
			}
			if got := response.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q", got)
			}
			if got := response.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q", got)
			}
			var gotValue interface{}
			var expectedValue interface{}
			if err := json.Unmarshal(response.Body.Bytes(), &gotValue); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(fixture.Expected, &expectedValue); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotValue, expectedValue) {
				t.Fatalf("response = %s, want %s", response.Body.String(), fixture.Expected)
			}
		})
	}
	if fixtureCount != 10 {
		t.Fatalf("connections-focus fixture count = %d, want 10", fixtureCount)
	}
}

func TestParseConnectionsFocus(t *testing.T) {
	marker := func(provider string) []byte {
		data, err := json.Marshal(map[string]interface{}{
			"version": 1, "provider": provider, "requestedAt": 1787000000000,
		})
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	// The charset rule at both cap edges: 63 is the control plane's grant
	// validator cap (schema isProviderName); the fixture corpus pins the same
	// edges for every runtime.
	if parseConnectionsFocus(marker(strings.Repeat("a", 63))) == nil {
		t.Fatal("parseConnectionsFocus dropped a 63-character provider")
	}
	if parseConnectionsFocus(marker(strings.Repeat("a", 64))) != nil {
		t.Fatal("parseConnectionsFocus kept a 64-character provider")
	}
	if parseConnectionsFocus(marker("-leading-dash")) != nil {
		t.Fatal("parseConnectionsFocus kept a provider starting with punctuation")
	}
	if parseConnectionsFocus(marker("has space")) != nil {
		t.Fatal("parseConnectionsFocus kept a provider with a space")
	}
	if parseConnectionsFocus(marker("google-workspace")) == nil {
		t.Fatal("parseConnectionsFocus dropped a usable provider")
	}
	// Unknown extra fields are forward compatibility, matching preview-focus.
	extra := []byte(`{"version":1,"provider":"github","requestedAt":1,"note":"future"}`)
	if parseConnectionsFocus(extra) == nil {
		t.Fatal("parseConnectionsFocus dropped a marker with an unknown field")
	}
}

func TestServeConnectionsFocusEmptyAbsentAndMethod(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "connections-focus.json")
	handler := &gateway{connectionsFocusPath: statePath}
	request := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "http://box/connections-focus", nil))
		return response
	}

	for _, test := range []struct {
		name  string
		write bool
	}{
		{name: "absent"},
		{name: "empty", write: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.write {
				if err := os.WriteFile(statePath, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			response := request(http.MethodGet)
			if response.Code != http.StatusOK || response.Body.String() != "{\"focus\":null}\n" {
				t.Fatalf("status = %d; body = %q", response.Code, response.Body.String())
			}
		})
	}

	response := request(http.MethodPost)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	if got := response.Header().Get("Allow"); got != "GET, OPTIONS" {
		t.Fatalf("Allow = %q", got)
	}
}

func TestDiscoverPorts(t *testing.T) {
	procRoot := t.TempDir()
	mustWrite(t, filepath.Join(procRoot, "net", "tcp"), strings.Join([]string{
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
		"   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0",
		"   1: 0100007F:1D15 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0",
		"   2: 0100007F:0FA0 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0",
		"   3: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1 0000000000000000 100 0 0 10 0",
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
	mustWrite(t, filepath.Join(procRoot, "43", "comm"), "cloudflared\n")
	if err := os.MkdirAll(filepath.Join(procRoot, "43", "fd"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("socket:[555]", filepath.Join(procRoot, "43", "fd", "5")); err != nil {
		t.Fatal(err)
	}

	got, err := discoverPorts(procRoot, map[int]struct{}{7445: {}})
	if err != nil {
		t.Fatal(err)
	}
	for _, port := range got {
		if port.Port == 8080 {
			t.Fatalf("discoverPorts() included cloudflared port: %#v", got)
		}
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

// captureGatewayLog points the package logger at a buffer for one test. Every
// policy refusal has to be readable from inside the box — that is the whole
// point of `deny` — so the log line is part of the contract these tests pin,
// not a side effect they tolerate.
func captureGatewayLog(t *testing.T) func() string {
	t.Helper()
	buffer := &bytes.Buffer{}
	previousWriter := log.Writer()
	previousFlags := log.Flags()
	log.SetOutput(buffer)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(previousWriter)
		log.SetFlags(previousFlags)
	})
	return buffer.String
}

// TestPolicyRefusalsExplainThemselves walks every refusal the gateway decides
// from box state. Before `deny`, each one wrote a bare status and logged
// nothing, so a box that refused everything looked identical to a healthy one.
// Each case asserts the reason and the deciding detail reach both the operator
// (the log) and the caller (the body).
func TestPolicyRefusalsExplainThemselves(t *testing.T) {
	const secret = "refusal-secret"
	const workspaceID = "workspace-refusal"
	const controlPlaneOrigin = "https://cp.example"
	tokenPath, workspacePath := writeGatewayIdentity(t, secret, workspaceID)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(upstreamURL),
		terminal:               upstreamURL,
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		webAppTokenPath:        tokenPath,
		workspaceIDPath:        workspacePath,
		transport:              http.DefaultTransport,
	}
	viewer := func() string {
		return signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID: workspaceID, UserID: "viewer-user", MembershipID: "viewer-member",
			Role: "viewer", Exp: time.Now().Unix() + 60,
		})
	}

	tests := []struct {
		name       string
		method     string
		target     string
		credential string
		origin     string
		webSocket  bool
		status     int
		reason     string
		details    []string
	}{
		{
			name: "webApp token missing", method: http.MethodGet, target: "/workspace/file.txt",
			status: http.StatusForbidden, reason: "webApp token forbidden",
			details: []string{"no " + webAppTokenHeader + " header"},
		},
		{
			name: "webApp token wrong", method: http.MethodGet, target: "/workspace/file.txt",
			credential: "not-the-token",
			status:     http.StatusForbidden, reason: "webApp token forbidden",
			details: []string{"static webApp token did not match the box token"},
		},
		{
			name: "webApp ticket rejected", method: http.MethodGet, target: "/workspace/file.txt",
			credential: "v1.bm90LWEtdGlja2V0.bm90LWEtc2ln",
			status:     http.StatusForbidden, reason: "webApp token forbidden",
			details: []string{"v1 ticket rejected", workspaceID},
		},
		{
			name: "drain by a viewer", method: http.MethodPost, target: "/admin/drain",
			credential: viewer(),
			status:     http.StatusForbidden, reason: "drain forbidden",
			details: []string{`role "viewer"`, `user "viewer-user"`},
		},
		{
			name: "diagnostics by a viewer", method: http.MethodGet, target: "/diag",
			credential: viewer(),
			status:     http.StatusForbidden, reason: "diagnostics forbidden",
			details: []string{`role "viewer"`, `user "viewer-user"`},
		},
		{
			name: "websocket origin", method: http.MethodGet, target: "/terminal/ws",
			credential: viewer(), origin: "https://evil.example", webSocket: true,
			status: http.StatusForbidden, reason: "websocket origin forbidden",
			details: []string{controlPlaneOrigin, "https://evil.example"},
		},
		{
			name: "terminal args", method: http.MethodGet, target: "/terminal/ws?arg=terminal",
			credential: viewer(),
			status:     http.StatusBadRequest, reason: "terminal requires a session type and key",
			details: []string{`role "viewer"`, "got 1 positional arg values, want 2"},
		},
		{
			name: "preview write by a viewer", method: http.MethodPost, target: "/preview/3000/api",
			credential: viewer(),
			status:     http.StatusForbidden, reason: "viewer preview access is read-only",
			details: []string{`role "viewer"`, "method POST"},
		},
		{
			name: "file write by a viewer", method: http.MethodPut, target: "/workspace/file.txt",
			credential: viewer(),
			status:     http.StatusForbidden, reason: "viewer file access is read-only",
			details: []string{`role "viewer"`, "method PUT"},
		},
		{
			name: "reserved preview port", method: http.MethodGet, target: "/preview/7443/",
			credential: secret,
			status:     http.StatusForbidden, reason: "port is reserved by the box",
			details: []string{"port 7443"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			logged := captureGatewayLog(t)
			request := httptest.NewRequest(test.method, "http://box"+test.target, nil)
			if test.credential != "" {
				request.Header.Set(webAppTokenHeader, test.credential)
			}
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if test.webSocket {
				request.Header.Set("Connection", "keep-alive, Upgrade")
				request.Header.Set("Upgrade", "websocket")
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			assertRefusalExplained(t, response, logged(), test.method, test.status, test.reason, test.details)
		})
	}

	t.Run("surface authentication unavailable", func(t *testing.T) {
		// A webApp token file that exists but is empty fails every request
		// closed. The box that does this is indistinguishable from a healthy
		// one unless it says which file it could not use.
		emptyTokenPath := filepath.Join(t.TempDir(), "webapp-token")
		if err := os.WriteFile(emptyTokenPath, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		failClosed := &gateway{webAppTokenPath: emptyTokenPath, workspaceIDPath: workspacePath}
		logged := captureGatewayLog(t)
		response := httptest.NewRecorder()
		failClosed.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "http://box/workspace/file.txt", nil))
		assertRefusalExplained(t, response, logged(), http.MethodGet, http.StatusServiceUnavailable,
			"surface authentication unavailable", []string{emptyTokenPath, "is empty"})
	})
}

// assertRefusalExplained pins the two places a refusal has to be readable: the
// box's own log, and the body the caller gets back.
func assertRefusalExplained(t *testing.T, response *httptest.ResponseRecorder, logText, method string, status int, reason string, details []string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; body = %q", response.Code, status, response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, reason) {
		t.Errorf("body = %q, want it to carry reason %q", body, reason)
	}
	if !strings.Contains(logText, fmt.Sprintf("reason=%q", reason)) {
		t.Errorf("log = %q, want it to carry reason %q", logText, reason)
	}
	if !strings.Contains(logText, fmt.Sprintf("status=%d", status)) {
		t.Errorf("log = %q, want it to carry status %d", logText, status)
	}
	if !strings.Contains(logText, "gateway refused "+method+" ") {
		t.Errorf("log = %q, want it to name method %s", logText, method)
	}
	for _, detail := range details {
		if !strings.Contains(body, detail) {
			t.Errorf("body = %q, want it to carry detail %q", body, detail)
		}
		if !strings.Contains(logText, detail) {
			t.Errorf("log = %q, want it to carry detail %q", logText, detail)
		}
	}
}

// TestWebSocketOriginRefusalNamesBothOrigins is the incident, written down. A
// control-plane domain change left every box pinned to an origin that no
// longer existed; the gateway refused every websocket and named neither side
// of the comparison, so the only evidence anywhere was a browser console. Both
// origins are the deployment's own domains, so both belong in the refusal.
func TestWebSocketOriginRefusalNamesBothOrigins(t *testing.T) {
	const bakedOrigin = "https://old-control-plane.example"
	const arrivingOrigin = "https://new-control-plane.example"

	t.Run("pinned to a domain that moved", func(t *testing.T) {
		logged := captureGatewayLog(t)
		handler := &gateway{controlPlaneOriginPath: writeOriginFile(t, bakedOrigin)}
		request := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws", nil)
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Origin", arrivingOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertRefusalExplained(t, response, logged(), http.MethodGet, http.StatusForbidden,
			"websocket origin forbidden", []string{bakedOrigin, arrivingOrigin})
	})

	t.Run("no origin file at all", func(t *testing.T) {
		// The expected origin is empty, which reads as "no expectation" unless
		// the refusal says which file was missing.
		missingPath := filepath.Join(t.TempDir(), "origin")
		logged := captureGatewayLog(t)
		handler := &gateway{controlPlaneOriginPath: missingPath}
		request := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws", nil)
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Origin", arrivingOrigin)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertRefusalExplained(t, response, logged(), http.MethodGet, http.StatusForbidden,
			"websocket origin forbidden", []string{missingPath, "missing or empty", arrivingOrigin})
	})

	t.Run("no origin header at all", func(t *testing.T) {
		logged := captureGatewayLog(t)
		handler := &gateway{controlPlaneOriginPath: writeOriginFile(t, bakedOrigin)}
		request := httptest.NewRequest(http.MethodGet, "http://box/terminal/ws", nil)
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertRefusalExplained(t, response, logged(), http.MethodGet, http.StatusForbidden,
			"websocket origin forbidden", []string{`expected "` + bakedOrigin + `" got ""`})
	})
}

// diagGateway builds a box whose every diagnosable fact is a fixture: a dufs
// that answers, a terminal address nothing listens on, a real origin, a real
// workspace id, and an agent credential file holding a value that must never
// leave the box.
func diagGateway(t *testing.T, secret, workspaceID, controlPlaneOrigin, credentialContents string) (*gateway, string) {
	t.Helper()
	tokenPath, workspacePath := writeGatewayIdentity(t, secret, workspaceID)
	live := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(live.Close)
	liveURL, err := url.Parse(live.URL)
	if err != nil {
		t.Fatal(err)
	}
	credentialPath := filepath.Join(t.TempDir(), ".credentials.json")
	if credentialContents != "" {
		if err := os.WriteFile(credentialPath, []byte(credentialContents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return &gateway{
		dufsAddress:            liveURL.Host,
		terminal:               &url.URL{Scheme: "http", Host: closedLoopbackAddress(t)},
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		webAppTokenPath:        tokenPath,
		workspaceIDPath:        workspacePath,
		agentCredentialPath:    credentialPath,
		transport:              http.DefaultTransport,
	}, credentialPath
}

// closedLoopbackAddress returns a loopback address nothing listens on, by
// taking one and giving it back. It stands in for a box service that died.
func closedLoopbackAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func diagRequest(t *testing.T, handler *gateway, credential string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "http://box/diag", nil)
	if credential != "" {
		request.Header.Set(webAppTokenHeader, credential)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

// TestDiagIsOwnerAndAdminOnly holds /diag to the guard /admin/drain keeps.
// The report names the box's internal addresses and the state its policy runs
// on, which a member of the workspace has no business enumerating.
func TestDiagIsOwnerAndAdminOnly(t *testing.T) {
	const secret = "diag-role-secret"
	const workspaceID = "workspace-diag-role"
	handler, _ := diagGateway(t, secret, workspaceID, "https://cp.example", `{"accessToken":"x"}`)
	ticket := func(role string) string {
		return signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID: workspaceID, UserID: role + "-user", MembershipID: role + "-member",
			Role: role, Exp: time.Now().Unix() + 60,
		})
	}
	for _, test := range []struct {
		role   string
		status int
	}{
		{role: "viewer", status: http.StatusForbidden},
		{role: "editor", status: http.StatusForbidden},
		{role: "admin", status: http.StatusOK},
		{role: "owner", status: http.StatusOK},
	} {
		t.Run(test.role, func(t *testing.T) {
			response := diagRequest(t, handler, ticket(test.role))
			if response.Code != test.status {
				t.Fatalf("%s /diag status = %d, want %d; body = %q",
					test.role, response.Code, test.status, response.Body.String())
			}
		})
	}

	t.Run("no credential at all", func(t *testing.T) {
		response := diagRequest(t, handler, "")
		if response.Code != http.StatusForbidden {
			t.Fatalf("anonymous /diag status = %d, want %d", response.Code, http.StatusForbidden)
		}
	})
}

// TestDiagReportsTheStateThatDecidesRefusals pins the answer itself. Each
// field is a fact an operator had to guess at during the outage: what origin
// is this box pinned to, which of its services are up, which workspace does it
// think it is, and does the agent have a credential at all.
func TestDiagReportsTheStateThatDecidesRefusals(t *testing.T) {
	const secret = "diag-report-secret"
	const workspaceID = "workspace-diag-report"
	const controlPlaneOrigin = "https://old-control-plane.example"
	handler, credentialPath := diagGateway(t, secret, workspaceID, controlPlaneOrigin, `{"accessToken":"x"}`)

	response := diagRequest(t, handler, secret)
	if response.Code != http.StatusOK {
		t.Fatalf("owner /diag status = %d, want %d; body = %q", response.Code, http.StatusOK, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var report diagReport
	if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil {
		t.Fatalf("decode /diag: %v; body = %q", err, response.Body.String())
	}
	if report.ControlPlaneOrigin != controlPlaneOrigin {
		t.Errorf("controlPlaneOrigin = %q, want %q", report.ControlPlaneOrigin, controlPlaneOrigin)
	}
	if report.WorkspaceID != workspaceID {
		t.Errorf("workspaceId = %q, want %q", report.WorkspaceID, workspaceID)
	}
	if !report.AuthRequired {
		t.Error("authRequired = false on a box that has a webApp token")
	}
	if report.AgentCredentialPath != credentialPath {
		t.Errorf("agentCredentialPath = %q, want %q", report.AgentCredentialPath, credentialPath)
	}
	if !report.AgentCredentialPresent {
		t.Error("agentCredentialPresent = false while the credential file exists")
	}

	// A box always answers for both services, in a fixed order, whether
	// or not they answer: "the terminal is missing from the list" is not a
	// diagnosis anyone can act on.
	wantNames := []string{"terminal", "dufs"}
	gotNames := make([]string, 0, len(report.Services))
	for _, service := range report.Services {
		gotNames = append(gotNames, service.Name)
	}
	if !reflect.DeepEqual(gotNames, wantNames) {
		t.Fatalf("services = %v, want %v", gotNames, wantNames)
	}
	reachable := map[string]bool{"terminal": false, "dufs": true}
	for _, service := range report.Services {
		if service.Reachable != reachable[service.Name] {
			t.Errorf("%s reachable = %v, want %v (address %s, error %q)",
				service.Name, service.Reachable, reachable[service.Name], service.Address, service.Error)
		}
		if service.Address == "" {
			t.Errorf("%s reported no address", service.Name)
		}
		if service.Reachable && service.Error != "" {
			t.Errorf("%s is reachable and still reported error %q", service.Name, service.Error)
		}
		if !service.Reachable && service.Error == "" {
			t.Errorf("%s is unreachable and said nothing about why", service.Name)
		}
	}

	t.Run("agent credential absent", func(t *testing.T) {
		if err := os.Remove(credentialPath); err != nil {
			t.Fatal(err)
		}
		absent := diagRequest(t, handler, secret)
		var report diagReport
		if err := json.Unmarshal(absent.Body.Bytes(), &report); err != nil {
			t.Fatal(err)
		}
		if report.AgentCredentialPresent {
			t.Error("agentCredentialPresent = true after the credential file was removed")
		}
	})
}

// TestDiagNeverCarriesSecretMaterial is the guard that lets /diag exist. The
// gateway sits on a webApp token and an agent OAuth credential, and a
// diagnostic that hands either one to its caller is worse than no diagnostic.
// It walks every value in the answer, not the fields this version happens to
// have, so a field added later is covered the day it is added.
func TestDiagNeverCarriesSecretMaterial(t *testing.T) {
	const secret = "sk-webapp-token-must-not-leak"
	const workspaceID = "workspace-diag-secrets"
	const credentialContents = `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-must-not-leak"}}`
	handler, _ := diagGateway(t, secret, workspaceID, "https://cp.example", credentialContents)

	response := diagRequest(t, handler, secret)
	if response.Code != http.StatusOK {
		t.Fatalf("owner /diag status = %d, want %d", response.Code, http.StatusOK)
	}
	body := response.Body.String()
	for _, forbidden := range []string{
		secret,
		credentialContents,
		"sk-ant-oat01-must-not-leak",
		"claudeAiOauth",
		"accessToken",
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("/diag body carries %q: %s", forbidden, body)
		}
	}

	// The field set is part of the contract: every one of these is either a
	// boolean, an address the gateway dials, or a path — never a value read
	// out of a file that holds a secret.
	var decoded map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	wantKeys := []string{
		"agentCredentialPath", "agentCredentialPresent", "authRequired",
		"controlPlaneOrigin", "services", "workspaceId",
	}
	if !reflect.DeepEqual(keys, wantKeys) {
		t.Fatalf("/diag fields = %v, want %v", keys, wantKeys)
	}
}

// TestDiagMethods keeps /diag to what the other 7445 surfaces answer: a read,
// and nothing else.
func TestDiagMethods(t *testing.T) {
	const secret = "diag-method-secret"
	handler, _ := diagGateway(t, secret, "workspace-diag-method", "https://cp.example", "")

	options := httptest.NewRequest(http.MethodOptions, "http://box/diag", nil)
	options.Header.Set(webAppTokenHeader, secret)
	optionsResponse := httptest.NewRecorder()
	handler.ServeHTTP(optionsResponse, options)
	if optionsResponse.Code != http.StatusNoContent {
		t.Errorf("OPTIONS /diag status = %d, want %d", optionsResponse.Code, http.StatusNoContent)
	}

	post := httptest.NewRequest(http.MethodPost, "http://box/diag", strings.NewReader("{}"))
	post.Header.Set(webAppTokenHeader, secret)
	postResponse := httptest.NewRecorder()
	handler.ServeHTTP(postResponse, post)
	if postResponse.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /diag status = %d, want %d", postResponse.Code, http.StatusMethodNotAllowed)
	}
	if got := postResponse.Header().Get("Allow"); got != "GET, OPTIONS" {
		t.Errorf("Allow = %q, want %q", got, "GET, OPTIONS")
	}
}

// The gateway's half of the share-claim contract
// (packages/schema/fixtures/lody-share-claim/): the bytes it puts on the header
// are what the bridge's ACL reads, and the bridge's own conformance suite drives
// those same bytes. A field one side renames is a grant the other stops seeing.
func TestShareClaimHeaderMatchesTheCorpus(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "schema", "fixtures", "lody-share-claim", "claims.json"))
	if err != nil {
		t.Fatalf("read share claim corpus: %v", err)
	}
	var corpus map[string]struct {
		Claim  webAppShareClaim `json:"claim"`
		Header string           `json:"header"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("parse share claim corpus: %v", err)
	}
	if len(corpus) == 0 {
		t.Fatal("no share claims in the corpus")
	}
	for name, entry := range corpus {
		encoded, err := json.Marshal(entry.Claim)
		if err != nil {
			t.Fatalf("%s: encode: %v", name, err)
		}
		if string(encoded) != entry.Header {
			t.Errorf("%s: header = %s, want %s", name, encoded, entry.Header)
		}
	}
}

// PHASE 6 (plans/LODY-SHARING.md §4.1) — a ticket routed to ANOTHER member's
// machine. The gateway decides WHERE such a request may go; the bridge decides
// what it may say once it gets there.
func TestSharedTicketReachesOnlyTheSessionDaemon(t *testing.T) {
	type sharedUpstream struct {
		requestURI string
		body       string
	}
	observed := make(chan sharedUpstream, 8)
	socketPath := filepath.Join(t.TempDir(), "b.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	upstream := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		observed <- sharedUpstream{
			requestURI: request.URL.RequestURI(),
			body:       string(body) + "|" + request.Header.Get(lodyShareHeader),
		}
		response.WriteHeader(http.StatusNoContent)
	})}
	go func() { _ = upstream.Serve(listener) }()
	defer func() { _ = upstream.Close() }()

	const secret = "shared-ticket-secret"
	const workspaceID = "workspace-shared"
	const controlPlaneOrigin = "https://blitz-control-plane.example"
	tokenPath, workspacePath := writeGatewayIdentity(t, secret, workspaceID)
	handler := &gateway{
		dufs:                   httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: "dufs.invalid"}),
		lody:                   &url.URL{Scheme: "http", Host: lodyBridgeHost},
		lodyTransport:          unixSocketTransport(socketPath),
		controlPlaneOriginPath: writeOriginFile(t, controlPlaneOrigin),
		webAppTokenPath:        tokenPath,
		workspaceIDPath:        workspacePath,
		transport:              http.DefaultTransport,
	}
	sharedTicket := func(role string) string {
		return signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID:  workspaceID,
			UserID:       "grantee-user",
			MembershipID: "grantee-membership",
			Role:         role,
			Exp:          time.Now().Add(time.Hour).Unix(),
			Share: json.RawMessage(
				`{"target":"owner-membership","scope":"sessions","read":["sess-alpha"],"write":["sess-beta"]}`,
			),
		})
	}

	// §0.1 grants "read access scoped to that session's worktree; nothing else
	// on the owner's box". Every one of these is "nothing else".
	for _, path := range []string{
		"/workspace/file.txt",
		"/preview/3000/",
		"/terminal/ws",
		"/ports",
		"/previews",
		"/diag",
		"/admin/drain",
	} {
		t.Run("refuses "+path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://box"+path, nil)
			request.Header.Set(webAppTokenHeader, sharedTicket("editor"))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want 403; body = %q", response.Code, response.Body.String())
			}
		})
	}

	t.Run("forwards the verified claim to the bridge", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "http://box"+lodyRPCPath, strings.NewReader("{}"))
		request.Header.Set(webAppTokenHeader, sharedTicket("editor"))
		// A forged inbound copy must never survive: the browser may not author
		// its own authority.
		request.Header.Set(lodyShareHeader, `{"target":"owner-membership","scope":"all","read":[],"write":[]}`)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204; body = %q", response.Code, response.Body.String())
		}
		got := <-observed
		want := `{}|{"target":"owner-membership","scope":"sessions","read":["sess-alpha"],"write":["sess-beta"]}`
		if got.body != want {
			t.Errorf("bridge saw %q, want %q", got.body, want)
		}
	})

	// A viewer holds no sessions of their own, so their own box's daemon stays
	// closed; a viewer holding a read-only share is what §0.1 asks to allow.
	t.Run("a viewer with a share reaches the daemon", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "http://box"+lodyRPCPath, strings.NewReader("{}"))
		request.Header.Set(webAppTokenHeader, sharedTicket("viewer"))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204; body = %q", response.Code, response.Body.String())
		}
		<-observed
	})

	t.Run("a viewer without one does not", func(t *testing.T) {
		plain := signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID:  workspaceID,
			UserID:       "viewer-user",
			MembershipID: "viewer-membership",
			Role:         "viewer",
			Exp:          time.Now().Add(time.Hour).Unix(),
		})
		request := httptest.NewRequest(http.MethodPost, "http://box"+lodyRPCPath, strings.NewReader("{}"))
		request.Header.Set(webAppTokenHeader, plain)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", response.Code)
		}
	})

	// An ordinary ticket carries no claim, so the bridge must see no header at
	// all — its absence is what selects the "copy bytes" path.
	t.Run("an unshared request carries no claim header", func(t *testing.T) {
		plain := signedTicket(t, secret, webAppTicketClaims{
			WorkspaceID:  workspaceID,
			UserID:       "owner-user",
			MembershipID: "owner-membership",
			Role:         "owner",
			Exp:          time.Now().Add(time.Hour).Unix(),
		})
		request := httptest.NewRequest(http.MethodPost, "http://box"+lodyRPCPath, strings.NewReader("{}"))
		request.Header.Set(webAppTokenHeader, plain)
		request.Header.Set(lodyShareHeader, `{"target":"x","scope":"all","read":[],"write":[]}`)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", response.Code)
		}
		if got := <-observed; got.body != "{}|" {
			t.Errorf("bridge saw %q, want %q", got.body, "{}|")
		}
	})
}
