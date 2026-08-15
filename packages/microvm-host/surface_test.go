package agent

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

const surfaceTestToken = "01234567890123456789012345678901"

func surfaceTestHandler(t *testing.T, backendURL string) http.Handler {
	t.Helper()
	dir := t.TempDir()
	manager, err := NewManager(testConfig(dir), NewStateStore(dir), &mockBackend{})
	if err != nil {
		t.Fatal(err)
	}
	manager.vms["vm-1-surface"] = &VM{
		VMID: "vm-1-surface", GuestIP: "172.30.21.2", Status: StatusRunning,
	}
	backend, err := url.Parse(backendURL)
	if err != nil {
		t.Fatal(err)
	}
	api := NewHandler(manager, surfaceTestToken).(*API)
	api.surfaceTransport = &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", backend.Host)
		},
	}
	return api
}

func TestSurfaceRoutingRestrictionAuthAndUnknownVM(t *testing.T) {
	type observedRequest struct {
		method, uri, authorization, cookie, origin, body string
	}
	observed := make(chan observedRequest, 4)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		observed <- observedRequest{
			method: request.Method, uri: request.URL.RequestURI(),
			authorization: request.Header.Get("Authorization"),
			cookie:        request.Header.Get("Cookie"), origin: request.Header.Get("Origin"),
			body: string(body),
		}
		response.Header().Set("X-Guest", "gateway")
		response.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(response, "proxied")
	}))
	defer backend.Close()
	handler := surfaceTestHandler(t, backend.URL)

	t.Run("requires bearer auth", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/vms/vm-1-surface/surface/7445/ports", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
		}
	})

	t.Run("rejects every port outside the allowlist", func(t *testing.T) {
		for _, port := range []string{"22", "7443", "7446", "not-a-port"} {
			request := httptest.NewRequest(http.MethodGet, "/vms/vm-1-surface/surface/"+port+"/", nil)
			request.Header.Set("Authorization", "Bearer "+surfaceTestToken)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("port %s status = %d, want %d", port, response.Code, http.StatusBadRequest)
			}
		}
	})

	t.Run("returns 404 for an unknown VM", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/vms/vm-9-missing/surface/7445/", nil)
		request.Header.Set("Authorization", "Bearer "+surfaceTestToken)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
		}
	})

	t.Run("proxies any HTTP method and strips its route prefix", func(t *testing.T) {
		request := httptest.NewRequest(
			http.MethodPatch,
			"/vms/vm-1-surface/surface/7445/workspace/a%20b?arg=one&arg=two",
			strings.NewReader("payload"),
		)
		request.Header.Set("Authorization", "Bearer "+surfaceTestToken)
		request.Header.Set("Cookie", "blitz_session=must-not-reach-guest")
		request.Header.Set("Origin", "https://cp.example.test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusCreated || response.Body.String() != "proxied" {
			t.Fatalf("response = %d %q", response.Code, response.Body.String())
		}
		got := <-observed
		if got.method != http.MethodPatch || got.uri != "/workspace/a%20b?arg=one&arg=two" || got.body != "payload" {
			t.Fatalf("upstream request = %#v", got)
		}
		if got.authorization != "" || got.cookie != "" || got.origin != "https://cp.example.test" {
			t.Fatalf("upstream credential/origin headers = %#v", got)
		}
	})

	t.Run("rewrites ACP origin after the authenticated boundary", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/vms/vm-1-surface/surface/7444", nil)
		request.Header.Set("Authorization", "Bearer "+surfaceTestToken)
		request.Header.Set("Origin", "https://cp.example.test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusCreated {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusCreated)
		}
		got := <-observed
		if got.uri != "/" || got.origin != "http://127.0.0.1" {
			t.Fatalf("ACP upstream request = %#v", got)
		}
	})
}

func TestSurfaceWebSocketBidirectionalPipe(t *testing.T) {
	backendResult := make(chan string, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" || request.Header.Get("Origin") != "http://127.0.0.1" {
			backendResult <- "unexpected forwarded credentials or origin"
			return
		}
		hijacker, ok := response.(http.Hijacker)
		if !ok {
			backendResult <- "response does not support hijacking"
			return
		}
		connection, buffered, err := hijacker.Hijack()
		if err != nil {
			backendResult <- err.Error()
			return
		}
		defer connection.Close()
		accept := websocketAccept(request.Header.Get("Sec-WebSocket-Key"))
		_, _ = fmt.Fprintf(buffered, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\nSec-WebSocket-Protocol: acp\r\n\r\n", accept)
		if err := buffered.Flush(); err != nil {
			backendResult <- err.Error()
			return
		}
		message, err := readWebSocketText(buffered.Reader, true)
		if err != nil {
			backendResult <- err.Error()
			return
		}
		if err := writeWebSocketText(connection, "echo:"+message, false); err != nil {
			backendResult <- err.Error()
			return
		}
		backendResult <- message
	}))
	defer backend.Close()

	agentServer := httptest.NewServer(surfaceTestHandler(t, backend.URL))
	defer agentServer.Close()
	agentURL, err := url.Parse(agentServer.URL)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := net.DialTimeout("tcp", agentURL.Host, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	key := base64.StdEncoding.EncodeToString([]byte("surface-test-key"))
	_, _ = fmt.Fprintf(connection, "GET /vms/vm-1-surface/surface/7444?arg=kept HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Protocol: acp\r\nOrigin: https://cp.example.test\r\n\r\n", agentURL.Host, surfaceTestToken, key)
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols || response.Header.Get("Sec-WebSocket-Protocol") != "acp" {
		t.Fatalf("upgrade response = %s headers=%v", response.Status, response.Header)
	}
	if err := writeWebSocketText(connection, "hello", true); err != nil {
		t.Fatal(err)
	}
	message, err := readWebSocketText(reader, false)
	if err != nil {
		t.Fatal(err)
	}
	if message != "echo:hello" {
		t.Fatalf("WebSocket response = %q", message)
	}
	if result := <-backendResult; result != "hello" {
		t.Fatalf("backend result = %q", result)
	}
}

func TestMicroVMInitBridgesOnlyHostTapSurfaceTraffic(t *testing.T) {
	contents, err := os.ReadFile("guest/microvm-init")
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	for _, required := range []string{
		"/proc/sys/net/ipv4/conf/eth0/route_localnet",
		"for surface_port in 7444 7445",
		"-i eth0 -p tcp -s \"$guest_gw\" -d \"$guest_ip\" --dport \"$surface_port\"",
		"--to-destination \"127.0.0.1:$surface_port\"",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("guest surface bridge is missing %q", required)
		}
	}
}

func websocketAccept(key string) string {
	digest := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(digest[:])
}

func writeWebSocketText(writer io.Writer, value string, masked bool) error {
	payload := []byte(value)
	if len(payload) > 125 {
		return fmt.Errorf("test payload is too large")
	}
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	frame := []byte{0x81, maskBit | byte(len(payload))}
	if masked {
		mask := []byte{1, 2, 3, 4}
		frame = append(frame, mask...)
		for index, value := range payload {
			frame = append(frame, value^mask[index%len(mask)])
		}
	} else {
		frame = append(frame, payload...)
	}
	_, err := writer.Write(frame)
	return err
}

func readWebSocketText(reader *bufio.Reader, masked bool) (string, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil {
		return "", err
	}
	if header[0] != 0x81 || header[1]&0x7f > 125 || (header[1]&0x80 != 0) != masked {
		return "", fmt.Errorf("unexpected WebSocket frame header %v", header)
	}
	length := int(header[1] & 0x7f)
	var mask []byte
	if masked {
		mask = make([]byte, 4)
		if _, err := io.ReadFull(reader, mask); err != nil {
			return "", err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return "", err
	}
	for index := range payload {
		if masked {
			payload[index] ^= mask[index%len(mask)]
		}
	}
	return string(payload), nil
}
