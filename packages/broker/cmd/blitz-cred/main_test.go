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
	"github.com/blitzdotdev/blitz-core/broker/internal/workspace"
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
	// The summary's own shape is pinned in TestTokenIntegrationPrintsALabeledSummary;
	// here it only has to show that the integration went to the control plane.
	if calls != 1 || !strings.HasPrefix(output.String(), "github\n") {
		t.Fatalf("CP token calls=%d output=%q", calls, output.String())
	}
}

// The verb list an agent reads when it guesses wrong. `--help` used to print
// "unknown blitz-cred command" and exit 1.
func TestHelpAndNoArgumentsNameEveryVerb(t *testing.T) {
	verbs := []string{"enroll", "register", "token", "sync", "list", "git-helper", "watch"}
	// Empty on purpose: help answers before the state check, so it works on a
	// machine that is not a box.
	t.Setenv("BLITZ_STATE_DIR", "")
	for _, help := range []string{"--help", "-h", "help"} {
		var output strings.Builder
		if err := run([]string{help}, &output); err != nil {
			t.Fatalf("%s: %v", help, err)
		}
		for _, verb := range verbs {
			if !strings.Contains(output.String(), verb) {
				t.Errorf("%s output does not name %q: %q", help, verb, output.String())
			}
		}
	}
	err := run(nil, io.Discard)
	if err == nil {
		t.Fatal("blitz-cred without arguments returned no error")
	}
	for _, verb := range verbs {
		if !strings.Contains(err.Error(), verb) {
			t.Errorf("no-argument error does not name %q: %q", verb, err.Error())
		}
	}
}

// The PATH shims (/usr/local/bin/blitz-cred-claude, blitz-cred-codex) and
// ~/.codex/config.toml's [auth] command read this stdout as the token itself,
// so it carries the broker's bytes and nothing else: no label, no newline.
func TestTokenHarnessOutputStaysRawForTheShims(t *testing.T) {
	stateDir := t.TempDir()
	broker := []byte(`{"host":"broker.example","port":2222,"member":"m-0123456789ab"}`)
	if err := os.WriteFile(filepath.Join(stateDir, workspace.BrokerFile), broker, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BLITZ_STATE_DIR", stateDir)
	// A fake ssh stands in for the broker: Token shells out to `ssh` and copies
	// what it prints. The trailing newline is the mint reply's line terminator,
	// which the broker client strips.
	fakeBin := t.TempDir()
	if err := os.WriteFile(filepath.Join(fakeBin, "ssh"), []byte("#!/bin/sh\nprintf 'broker-minted-token\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	for _, harness := range []string{"claude", "codex"} {
		var output strings.Builder
		if err := run([]string{"token", harness}, &output); err != nil {
			t.Fatalf("token %s: %v", harness, err)
		}
		if output.String() != "broker-minted-token" {
			t.Fatalf("token %s output = %q", harness, output.String())
		}
	}
}

func TestTokenIntegrationPrintsALabeledSummary(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		io.WriteString(writer, `{"integration":"linear","mode":"inject","placements":[`+
			`{"kind":"env","name":"LINEAR_API_KEY","value":"linear-secret-value"},`+
			`{"kind":"env","name":"LINEAR_WORKSPACE_ID","value":"workspace-secret-value"}`+
			`],"expiresAt":2000000000000}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"token", "linear"}, &output); err != nil {
		t.Fatal(err)
	}
	summary := output.String()
	for _, want := range []string{"linear", "LINEAR_API_KEY", "LINEAR_WORKSPACE_ID", "2033-05-18T03:33:20Z", "creds/env.d", "revokes"} {
		if !strings.Contains(summary, want) {
			t.Errorf("token summary is missing %q: %q", want, summary)
		}
	}
	for _, secret := range []string{"linear-secret-value", "workspace-secret-value"} {
		if strings.Contains(summary, secret) {
			t.Errorf("token summary printed a value: %q", summary)
		}
	}
	// The old output: a bare epoch that an agent read as the token.
	for _, line := range strings.Split(summary, "\n") {
		if line == "2000000000000" {
			t.Errorf("token summary still prints a bare expiry line: %q", summary)
		}
	}
}

func TestListNamesProvidersAndVariablesButNeverValues(t *testing.T) {
	stateDir := t.TempDir()
	envDir := workspace.EnvironmentDir(stateDir)
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatal(err)
	}
	fragments := map[string]string{
		workspace.WorkspaceEnvironmentFile: "export WORKSPACE_VAR='workspace-secret-value'\n",
		"github.sh":                        "export GH_TOKEN='github-secret-value'\n",
		"linear.sh":                        "export LINEAR_API_KEY='linear-secret-value'\nunset OLD_LINEAR_TOKEN\n",
	}
	for name, content := range fragments {
		if err := os.WriteFile(filepath.Join(envDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("BLITZ_STATE_DIR", stateDir)

	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	listing := output.String()
	for _, want := range []string{"github: GH_TOKEN", "linear: LINEAR_API_KEY", "WORKSPACE_VAR", "not a connection"} {
		if !strings.Contains(listing, want) {
			t.Errorf("list is missing %q: %q", want, listing)
		}
	}
	for _, secret := range []string{"github-secret-value", "linear-secret-value", "workspace-secret-value"} {
		if strings.Contains(listing, secret) {
			t.Errorf("list printed a value: %q", listing)
		}
	}
	if strings.Contains(listing, "nothing connected yet") {
		t.Errorf("list called two providers nothing: %q", listing)
	}
}

func TestListWithoutCredentialsSaysNothingIsConnected(t *testing.T) {
	t.Setenv("BLITZ_STATE_DIR", t.TempDir())
	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "nothing connected yet\n" {
		t.Fatalf("list output = %q", output.String())
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
