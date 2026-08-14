package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func TestEnrollAcceptsCredentialWithAdditionalFields(t *testing.T) {
	stateDir := t.TempDir()
	credential := []byte(`{
  "box_id": "box",
  "access_token": "access",
  "refresh_token": "refresh",
  "token_type": "Bearer",
  "expires_in": 900
}`)
	if err := os.WriteFile(filepath.Join(stateDir, store.CredentialFile), credential, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BLITZ_STATE_DIR", stateDir)

	if err := run([]string{"enroll", "--origin", "https://cp.example"}, io.Discard); err != nil {
		t.Fatalf("blitz-cred rejected a credential with additional fields: %v", err)
	}
}

func TestTokenDispatchKeepsHarnessesOnBrokerAndUsesCPForIntegrations(t *testing.T) {
	stateDir := t.TempDir()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["integration"] != "github" {
			t.Errorf("integration = %q", body["integration"])
		}
		io.WriteString(writer, `{"integration":"github","mode":"inject","placements":[],"expiresAt":2000000000000}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	for _, harness := range []string{"claude", "codex"} {
		if err := run([]string{"token", harness}, io.Discard); err == nil {
			t.Fatalf("token %s unexpectedly succeeded without broker config", harness)
		}
	}
	if calls != 0 {
		t.Fatalf("broker token routes made %d CP calls", calls)
	}
	var output strings.Builder
	if err := run([]string{"token", "github"}, &output); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || output.String() != "2000000000000\n" {
		t.Fatalf("CP token calls=%d output=%q", calls, output.String())
	}
}

func TestGitHelperProtocol(t *testing.T) {
	stateDir := t.TempDir()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		io.WriteString(writer, `{"integration":"github","mode":"inject","placements":[{"kind":"env","name":"GH_TOKEN","value":"github-secret"}],"expiresAt":2000000000000}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output bytes.Buffer
	input := strings.NewReader("protocol=https\nhost=github.com\npath=owner/repo.git\n\n")
	if err := runWithInput([]string{"git-helper", "get"}, input, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "username=x-access-token\npassword=github-secret\n\n" {
		t.Fatalf("git helper output = %q", output.String())
	}
	for _, action := range []string{"store", "erase"} {
		output.Reset()
		if err := runWithInput([]string{"git-helper", action}, strings.NewReader("protocol=https\n\n"), &output); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		if output.Len() != 0 {
			t.Fatalf("%s output = %q", action, output.String())
		}
	}
	if calls != 1 {
		t.Fatalf("git helper mint calls = %d", calls)
	}
}

func TestGitHelper404IsSilent(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output bytes.Buffer
	if err := runWithInput([]string{"git-helper", "get"}, strings.NewReader("host=github.com\n\n"), &output); err != nil {
		t.Fatal(err)
	}
	if output.Len() != 0 {
		t.Fatalf("404 output = %q", output.String())
	}
}

func TestDeniedCommandsUsePolicyMessage(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	if err := run([]string{"token", "slack"}, io.Discard); err == nil || err.Error() != "blitz: access to slack denied by workspace policy" {
		t.Fatalf("token denial = %v", err)
	}
	if err := runWithInput([]string{"git-helper", "get"}, strings.NewReader("host=github.com\n\n"), io.Discard); err == nil || err.Error() != "blitz: access to github denied by workspace policy" {
		t.Fatalf("git denial = %v", err)
	}
}

func TestRequestedCommandsPrintApprovalStatus(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		switch body["integration"] {
		case "slack":
			writer.WriteHeader(http.StatusForbidden)
			io.WriteString(writer, `{"error":"denied","request_id":"request-403"}`)
		case "future-provider":
			writer.WriteHeader(http.StatusNotFound)
			io.WriteString(writer, `{"error":"missing","request_id":"request-404"}`)
		case "github":
			writer.WriteHeader(http.StatusForbidden)
			io.WriteString(writer, `{"error":"denied","request_id":"request-github"}`)
		default:
			writer.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	if err := run([]string{"token", "slack"}, io.Discard); err == nil || err.Error() != "blitz: access to slack requested (request-403), awaiting approval" {
		t.Fatalf("403 request = %v", err)
	}
	if err := run([]string{"token", "future-provider"}, io.Discard); err == nil || err.Error() != "blitz: integration future-provider requested (request-404), not configured yet" {
		t.Fatalf("404 request = %v", err)
	}
	if err := runWithInput([]string{"git-helper", "get"}, strings.NewReader("host=github.com\n\n"), io.Discard); err == nil || err.Error() != "blitz: access to github requested (request-github), awaiting approval" {
		t.Fatalf("git request = %v", err)
	}
}

func prepareCPState(t *testing.T, stateDir, origin string) {
	t.Helper()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveOrigin(stateDir, origin); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BLITZ_STATE_DIR", stateDir)
}
