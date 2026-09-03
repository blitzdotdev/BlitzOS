package main

import (
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

// The verb list an agent reads when it guesses wrong. `--help` used to print
// "unknown blitz-cred command" and exit 1.
func TestHelpAndNoArgumentsNameEveryVerb(t *testing.T) {
	verbs := []string{"api-token", "enroll", "register", "token", "watch"}
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

// `api-token` feeds a command substitution inside an Authorization header, so
// stdout is the bearer and one newline, nothing else. The box cannot read a
// token's age, so validity is established by use: one authenticated GET
// against the agent API, refresh only on a 401.
func TestAPITokenPrintsAStillValidToken(t *testing.T) {
	stateDir := t.TempDir()
	var probes []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		probes = append(probes, request.Method+" "+request.URL.Path+" "+request.Header.Get("Authorization"))
		io.WriteString(writer, `{"openapi":"3.1.0"}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"api-token"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "access\n" {
		t.Fatalf("api-token output = %q", output.String())
	}
	if len(probes) != 1 || probes[0] != "GET /agent/api Bearer access" {
		t.Fatalf("probes = %v", probes)
	}
}

func TestAPITokenRefreshesOnceOnA401ThenPrintsTheRotatedToken(t *testing.T) {
	stateDir := t.TempDir()
	var refreshes int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/agent/api":
			// The stored access token has expired; only the rotated one passes.
			if request.Header.Get("Authorization") == "Bearer access-2" {
				io.WriteString(writer, `{"openapi":"3.1.0"}`)
				return
			}
			writer.WriteHeader(http.StatusUnauthorized)
		case "/oauth/token":
			refreshes++
			if err := request.ParseForm(); err != nil {
				t.Error(err)
			}
			if request.PostForm.Get("grant_type") != "refresh_token" ||
				request.PostForm.Get("refresh_token") != "refresh" {
				t.Errorf("refresh form = %v", request.PostForm)
			}
			io.WriteString(writer, `{"box_id":"box","access_token":"access-2",`+
				`"refresh_token":"refresh-2","token_type":"Bearer","expires_in":900}`)
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"api-token"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "access-2\n" {
		t.Fatalf("api-token output = %q", output.String())
	}
	if refreshes != 1 {
		t.Fatalf("refresh calls = %d", refreshes)
	}
	// The rotation is durable: the next caller reads the new pair off disk.
	rotated, err := store.LoadCredential(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.AccessToken != "access-2" || rotated.RefreshToken != "refresh-2" {
		t.Fatalf("stored credential = %+v", rotated)
	}
}

// An unreachable control plane still prints the stored token, with exit 0:
// the agent's own curl is about to hit the same network and will surface the
// real error, which beats this helper guessing at one.
func TestAPITokenPrintsTheStoredTokenWhenTheCPIsUnreachable(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	origin := server.URL
	// Close before the run: nothing listens on the port any more.
	server.Close()
	prepareCPState(t, stateDir, origin)

	var output strings.Builder
	if err := run([]string{"api-token"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "access\n" {
		t.Fatalf("api-token output = %q", output.String())
	}
}

// A machine that never enrolled has no origin and no credential to print.
func TestAPITokenWithoutBoxStateFails(t *testing.T) {
	t.Setenv("BLITZ_STATE_DIR", t.TempDir())
	if err := run([]string{"api-token"}, io.Discard); err == nil {
		t.Fatal("api-token without box state returned no error")
	}
}

// The box credential wire is gone: an agent that still runs a deleted verb
// must read a loud refusal, never silence it could mistake for success — and
// the help must have stopped advertising them.
func TestRemovedVerbsAreRejected(t *testing.T) {
	t.Setenv("BLITZ_STATE_DIR", t.TempDir())
	removed := [][]string{
		{"sync"},
		{"token", "github"},
		{"list"},
		{"get", "github"},
		{"env", "github"},
		{"import", ".env"},
		{"put", "STRIPE_API_KEY"},
		{"git-helper", "get"},
	}
	for _, args := range removed {
		if err := run(args, io.Discard); err == nil {
			t.Errorf("blitz-cred %v returned no error", args)
		}
	}
	var help strings.Builder
	if err := run([]string{"--help"}, &help); err != nil {
		t.Fatal(err)
	}
	for _, verb := range []string{"sync", "git-helper", "import", "put", "env"} {
		if strings.Contains(help.String(), verb) {
			t.Errorf("help still advertises %s: %q", verb, help.String())
		}
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
