package controlplane

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/store"
)

func TestAccessTokenRequiresAuthenticatedProbeUnlessUnreachable(t *testing.T) {
	t.Run("authenticated probe", func(t *testing.T) {
		stateDir := stateWithCredential(t)
		var authorization string
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			authorization = request.Header.Get("Authorization")
			writer.WriteHeader(http.StatusNoContent)
		}))
		defer server.Close()
		client := newTestClient(t, server.URL, stateDir, server.Client())
		token, err := client.ValidAccessToken(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if token != "old-access" || authorization != "Bearer old-access" {
			t.Fatalf("token = %q, Authorization = %q", token, authorization)
		}
	})

	t.Run("unreachable control plane", func(t *testing.T) {
		stateDir := stateWithCredential(t)
		server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		origin := server.URL
		server.Close()
		client := newTestClient(t, origin, stateDir, nil)
		token, err := client.ValidAccessToken(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if token != "old-access" {
			t.Fatalf("token = %q", token)
		}
	})
}

func TestExactlyHTTP401TriggersRefresh(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusInternalServerError} {
		t.Run(fmt.Sprintf("HTTP %d", status), func(t *testing.T) {
			stateDir := stateWithCredential(t)
			var refreshes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case agentAPIProbePath:
					writer.WriteHeader(status)
				case "/oauth/token":
					refreshes.Add(1)
					io.WriteString(writer, issuedJSON("new-access", "new-refresh"))
				default:
					http.NotFound(writer, request)
				}
			}))
			defer server.Close()
			client := newTestClient(t, server.URL, stateDir, server.Client())
			token, err := client.ValidAccessToken(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			wantToken := "old-access"
			wantRefreshes := int32(0)
			if status == http.StatusUnauthorized {
				wantToken = "new-access"
				wantRefreshes = 1
			}
			if token != wantToken || refreshes.Load() != wantRefreshes {
				t.Fatalf("token = %q, refreshes = %d", token, refreshes.Load())
			}
		})
	}
}

func TestRefreshIsSerializedAcrossProcessesWithSeparateLockFile(t *testing.T) {
	stateDir := stateWithCredential(t)
	var probes atomic.Int32
	var refreshes atomic.Int32
	bothProbed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case agentAPIProbePath:
			if request.Header.Get("Authorization") == "Bearer old-access" {
				if probes.Add(1) == 2 {
					close(bothProbed)
				}
				<-bothProbed
				writer.WriteHeader(http.StatusUnauthorized)
				return
			}
			writer.WriteHeader(http.StatusNoContent)
		case "/oauth/token":
			if refreshes.Add(1) != 1 {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			io.WriteString(writer, issuedJSON("new-access", "new-refresh"))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	commands := make([]*exec.Cmd, 2)
	results := make([]string, 2)
	for index := range commands {
		results[index] = filepath.Join(t.TempDir(), "result")
		command := exec.Command(executable, "-test.run=^TestAPITokenProcessHelper$")
		command.Env = append(os.Environ(),
			"BLITZ_APITOKEN_PROCESS_HELPER=1",
			"BLITZ_APITOKEN_STATE_DIR="+stateDir,
			"BLITZ_APITOKEN_ORIGIN="+server.URL,
			"BLITZ_APITOKEN_RESULT="+results[index],
		)
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		commands[index] = command
	}
	for _, command := range commands {
		if err := command.Wait(); err != nil {
			t.Fatalf("helper failed: %v", err)
		}
	}
	for _, result := range results {
		data, err := os.ReadFile(result)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != "new-access" {
			t.Fatalf("helper token = %q", data)
		}
	}
	if refreshes.Load() != 1 {
		t.Fatalf("refresh requests = %d", refreshes.Load())
	}
	credentialInfo, err := os.Stat(store.CredentialPath(stateDir))
	if err != nil {
		t.Fatal(err)
	}
	lockInfo, err := os.Stat(filepath.Join(stateDir, RefreshLockFile))
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(credentialInfo, lockInfo) {
		t.Fatal("refresh lock uses the credential inode")
	}
}

func TestAPITokenProcessHelper(t *testing.T) {
	if os.Getenv("BLITZ_APITOKEN_PROCESS_HELPER") != "1" {
		return
	}
	client := newTestClient(t, os.Getenv("BLITZ_APITOKEN_ORIGIN"), os.Getenv("BLITZ_APITOKEN_STATE_DIR"), nil)
	token, err := client.ValidAccessToken(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("BLITZ_APITOKEN_RESULT"), []byte(token), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialIsRereadWhileHoldingRefreshLock(t *testing.T) {
	stateDir := stateWithCredential(t)
	lockPath := filepath.Join(stateDir, RefreshLockFile)
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}

	probed := make(chan struct{})
	var refreshes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case agentAPIProbePath:
			close(probed)
			writer.WriteHeader(http.StatusUnauthorized)
		case "/oauth/token":
			refreshes.Add(1)
			writer.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, stateDir, server.Client())
	type result struct {
		token string
		err   error
	}
	answer := make(chan result, 1)
	go func() {
		token, err := client.ValidAccessToken(context.Background())
		answer <- result{token: token, err: err}
	}()
	<-probed
	newCredential := store.Credential{BoxID: "box", AccessToken: "new-access", RefreshToken: "new-refresh"}
	if err := store.SaveCredential(stateDir, newCredential); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}
	got := <-answer
	if got.err != nil {
		t.Fatal(got.err)
	}
	if got.token != "new-access" || refreshes.Load() != 0 {
		t.Fatalf("token = %q, refreshes = %d", got.token, refreshes.Load())
	}
}

func TestRotatedCredentialIsAtomicAndWrittenOnlyAfterRefreshAcceptance(t *testing.T) {
	stateDir := stateWithCredential(t)
	credentialPath := store.CredentialPath(stateDir)
	beforeBytes, err := os.ReadFile(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeInfo, err := os.Stat(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	var accept atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case agentAPIProbePath:
			writer.WriteHeader(http.StatusUnauthorized)
		case "/oauth/token":
			if !accept.Load() {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			io.WriteString(writer, issuedJSON("new-access", "new-refresh"))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()
	client := newTestClient(t, server.URL, stateDir, server.Client())
	if _, err := client.ValidAccessToken(context.Background()); err == nil {
		t.Fatal("rejected refresh succeeded")
	}
	deniedBytes, err := os.ReadFile(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	deniedInfo, err := os.Stat(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(deniedBytes) != string(beforeBytes) || !os.SameFile(beforeInfo, deniedInfo) {
		t.Fatal("rejected refresh changed the credential")
	}

	accept.Store(true)
	token, err := client.ValidAccessToken(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	afterInfo, err := os.Stat(credentialPath)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := store.LoadCredential(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if token != "new-access" || credential.AccessToken != "new-access" || credential.RefreshToken != "new-refresh" {
		t.Fatalf("token = %q, credential = %+v", token, credential)
	}
	if os.SameFile(beforeInfo, afterInfo) {
		t.Fatal("accepted refresh did not replace the credential atomically")
	}
}

func TestRefreshResponsesAreCappedAndStrictlyDecoded(t *testing.T) {
	for name, body := range map[string]string{
		"oversized":     strings.Repeat("x", responseMaxBytes+1),
		"unknown field": `{"box_id":"box","access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","expires_in":900,"extra":true}`,
	} {
		t.Run(name, func(t *testing.T) {
			stateDir := stateWithCredential(t)
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path == agentAPIProbePath {
					writer.WriteHeader(http.StatusUnauthorized)
					return
				}
				io.WriteString(writer, body)
			}))
			defer server.Close()
			client := newTestClient(t, server.URL, stateDir, server.Client())
			if _, err := client.ValidAccessToken(context.Background()); err == nil {
				t.Fatal("invalid response was accepted")
			}
			credential, err := store.LoadCredential(stateDir)
			if err != nil {
				t.Fatal(err)
			}
			if credential.AccessToken != "old-access" || credential.RefreshToken != "old-refresh" {
				t.Fatalf("credential changed to %+v", credential)
			}
		})
	}
}

func TestOriginsRequireHTTPSExceptLocalhost(t *testing.T) {
	accepted := []string{
		"https://cp.example", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787",
	}
	for _, origin := range accepted {
		if _, err := ValidateOrigin(origin); err != nil {
			t.Errorf("ValidateOrigin(%q): %v", origin, err)
		}
	}
	rejected := []string{
		"http://cp.example", "https://cp.example/path", "https://user@cp.example", "https://cp.example?query=1",
	}
	for _, origin := range rejected {
		if _, err := ValidateOrigin(origin); err == nil {
			t.Errorf("ValidateOrigin(%q) succeeded", origin)
		}
	}
}

func stateWithCredential(t *testing.T) string {
	t.Helper()
	stateDir := t.TempDir()
	credential := store.Credential{BoxID: "box", AccessToken: "old-access", RefreshToken: "old-refresh"}
	if err := store.SaveCredential(stateDir, credential); err != nil {
		t.Fatal(err)
	}
	return stateDir
}

func newTestClient(t *testing.T, origin, stateDir string, httpClient *http.Client) *Client {
	t.Helper()
	client, err := New(origin, stateDir, httpClient)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func issuedJSON(accessToken, refreshToken string) string {
	return fmt.Sprintf(
		`{"box_id":"box","access_token":%q,"refresh_token":%q,"token_type":"Bearer","expires_in":900}`,
		accessToken,
		refreshToken,
	)
}
