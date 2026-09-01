package main

import (
	"bytes"
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

// githubTokenBody is what the control plane answers a GitHub pull with. The
// token and the env value differ from each other on purpose: `get` prints the
// token, `env` prints the env entries, and a shared string would hide a mix-up.
const githubTokenBody = `{"connection":"github","mode":"inject","token":"ghs-live",` +
	`"env":[{"name":"GH_TOKEN","value":"gh-env-value"}],` +
	`"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000}`

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
	verbs := []string{"enroll", "register", "token", "list", "get", "env", "import", "put", "git-helper", "watch"}
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

// `list` is a live read of the workspace allow-list. One name per line, because
// an agent pipes this into a loop.
func TestListPrintsOneProviderPerLine(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		// The comment read rides beside the allow-list read; names come from
		// the allow-list alone.
		if request.URL.Path == "/workspaces/self/credentials" {
			io.WriteString(writer, `{"credentials":[]}`)
			return
		}
		if request.Method != http.MethodGet || request.URL.Path != "/workspaces/self/connections" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		io.WriteString(writer, `{"connections":["github","linear"]}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "github\nlinear\n" {
		t.Fatalf("list output = %q", output.String())
	}
}

// An empty allow-list is a workspace nobody has connected yet. Printing nothing
// reads as a broken command, so the line has to say what to do next.
func TestListWithNoConnectionsPrintsTheConnectGuidance(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		io.WriteString(writer, `{"connections":[]}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "blitz connections open") {
		t.Fatalf("list output = %q", output.String())
	}
}

// A credential that carries a comment prints it after a `#`, so an agent
// picking a key reads what each one is for without a second command.
func TestListPrintsCredentialCommentsAfterAHash(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/workspaces/self/credentials" {
			io.WriteString(writer, `{"credentials":[{"name":"CF_TOKEN","comment":"canary token; deploys the control plane"}]}`)
			return
		}
		io.WriteString(writer, `{"connections":["CF_TOKEN","github"]}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "CF_TOKEN  # canary token; deploys the control plane\ngithub\n" {
		t.Fatalf("list output = %q", output.String())
	}
}

// A control plane too old to serve the credential list costs the comments,
// never the list itself.
func TestListSurvivesAMissingCredentialRoute(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/workspaces/self/credentials" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		io.WriteString(writer, `{"connections":["github"]}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"list"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "github\n" {
		t.Fatalf("list output = %q", output.String())
	}
}

// The value arrives on stdin, never argv: a process list must not hold a
// secret. One trailing newline is the pipe's, not the value's.
func TestPutSendsTheStdinValueWithItsComment(t *testing.T) {
	stateDir := t.TempDir()
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPut || request.URL.Path != "/workspaces/self/credentials" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		data, err := io.ReadAll(request.Body)
		if err != nil {
			t.Error(err)
		}
		body = data
		writer.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	err := runWithInput(
		[]string{"put", "STRIPE_API_KEY", "--comment", "test-mode key, safe for CI"},
		strings.NewReader("sk_test\n"),
		&output,
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"name":"STRIPE_API_KEY","value":"sk_test","comment":"test-mode key, safe for CI"}` {
		t.Fatalf("body = %s", body)
	}
	if output.String() != "stored    STRIPE_API_KEY\n" {
		t.Fatalf("put output = %q", output.String())
	}
}

func TestPutRefusesAMultilineValueWithTheBase64Sentence(t *testing.T) {
	stateDir := t.TempDir()
	prepareCPState(t, stateDir, "https://cp.example")
	err := runWithInput(
		[]string{"put", "GOOGLE_SA_JSON"},
		strings.NewReader("{\n  \"type\": \"service_account\"\n}\n"),
		io.Discard,
	)
	if err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("err = %v", err)
	}
}

// `get` feeds a command substitution. Anything else on stdout — a label, a
// summary — becomes part of the token the caller sends to the vendor.
func TestGetPrintsOnlyTheToken(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/workspaces/self/connections/github/token" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		io.WriteString(writer, githubTokenBody)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"get", "github"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "ghs-live\n" {
		t.Fatalf("get output = %q", output.String())
	}
}

// `env` is eval'd by a shell. The header comment states the vendor's header
// shape, which is not guessable, and every value is quoted because a token is
// an opaque vendor string.
func TestEnvPrintsTheHeaderCommentThenQuotedAssignments(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		io.WriteString(writer, `{"connection":"github","mode":"inject","token":"ghs-live","env":[`+
			`{"name":"GH_TOKEN","value":"ghs-live"},`+
			`{"name":"GH_HOST","value":"it's-github"}`+
			`],"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000}`)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output strings.Builder
	if err := run([]string{"env", "github"}, &output); err != nil {
		t.Fatal(err)
	}
	want := "# send: Authorization: Bearer $GH_TOKEN\n" +
		"GH_TOKEN='ghs-live'\n" +
		"GH_HOST='it'\"'\"'s-github'\n"
	if output.String() != want {
		t.Fatalf("env output = %q, want %q", output.String(), want)
	}
}

func TestGitHelperProtocol(t *testing.T) {
	stateDir := t.TempDir()
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		io.WriteString(writer, githubTokenBody)
	}))
	defer server.Close()
	prepareCPState(t, stateDir, server.URL)

	var output bytes.Buffer
	input := strings.NewReader("protocol=https\nhost=github.com\npath=owner/repo.git\n\n")
	if err := runWithInput([]string{"git-helper", "get"}, input, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "username=x-access-token\npassword=ghs-live\n\n" {
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

// A bare "403" sent agents into retry loops against a workspace that was never
// connected. Every refusal names the command that puts the question in front of
// a person, and quotes the request id when the control plane filed one.
func TestRefusalsNameTheConnectCommandAndTheFiledRequest(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		requestID string
	}{
		{
			name:      "not connected, request filed",
			status:    http.StatusForbidden,
			body:      `{"error":"denied","request_id":"request-403"}`,
			requestID: "request-403",
		},
		{
			name:      "no credential behind it, request filed",
			status:    http.StatusNotFound,
			body:      `{"error":"missing","request_id":"request-404"}`,
			requestID: "request-404",
		},
		{
			name:   "not connected, no request filed",
			status: http.StatusForbidden,
			body:   `{"error":"denied"}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stateDir := t.TempDir()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(test.status)
				io.WriteString(writer, test.body)
			}))
			defer server.Close()
			prepareCPState(t, stateDir, server.URL)

			err := run([]string{"get", "github"}, io.Discard)
			if err == nil {
				t.Fatal("a refused pull was reported as success")
			}
			if !strings.Contains(err.Error(), "blitz connections open github") {
				t.Errorf("refusal does not name the connect command: %q", err.Error())
			}
			if test.requestID != "" && !strings.Contains(err.Error(), test.requestID) {
				t.Errorf("refusal does not quote the filed request: %q", err.Error())
			}
		})
	}
}

// The push model is gone. `sync` delivered credentials into the box, and
// `token PROVIDER` minted one; both must fail loudly, because an agent that
// still runs them would otherwise read silence as success.
func TestRemovedVerbsAreRejected(t *testing.T) {
	t.Setenv("BLITZ_STATE_DIR", t.TempDir())
	for _, args := range [][]string{{"sync"}, {"token", "github"}} {
		if err := run(args, io.Discard); err == nil {
			t.Errorf("blitz-cred %v returned no error", args)
		}
	}
	var help strings.Builder
	if err := run([]string{"--help"}, &help); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(help.String(), "sync") {
		t.Errorf("help still advertises sync: %q", help.String())
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
