package workspace

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

// validTokenBody is the mint reply the control plane sends today. The rejection
// tables below change one field of it at a time, so the field under test is the
// only difference between an accepted body and a refused one.
const validTokenBody = `{"connection":"github","mode":"inject","token":"ghs-live",` +
	`"env":[{"name":"GH_TOKEN","value":"ghs-live"}],` +
	`"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000}`

// seedConnectionsBox writes the state a pull reads before it builds a request:
// the control-plane origin and this box's access token. Without both, every
// test below fails in the loader instead of in the code it aims at.
func seedConnectionsBox(t *testing.T, handler http.HandlerFunc) (string, *http.Client) {
	t.Helper()
	stateDir := t.TempDir()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	if err := store.SaveCredential(stateDir, store.Credential{
		BoxID: "box", AccessToken: "access", RefreshToken: "refresh",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}
	return stateDir, server.Client()
}

// answerWith serves one canned status and body, and records what it was asked.
func answerWith(t *testing.T, status int, body string, calls *[]string) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		if calls != nil {
			*calls = append(*calls, request.Method+" "+request.URL.Path)
		}
		writer.WriteHeader(status)
		if _, err := io.WriteString(writer, body); err != nil {
			t.Error(err)
		}
	}
}

func TestListConnectionsReadsTheWorkspaceAllowList(t *testing.T) {
	var calls []string
	stateDir, client := seedConnectionsBox(t, answerWith(
		t, http.StatusOK, `{"connections":["github","linear"]}`, &calls,
	))
	names, err := ListConnections(context.Background(), stateDir, client)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(names, []string{"github", "linear"}) {
		t.Fatalf("connections = %q", names)
	}
	if !slices.Equal(calls, []string{"GET /workspaces/self/connections"}) {
		t.Fatalf("control-plane calls = %q", calls)
	}
}

// An allow-list of none is a real answer, not a fault: a workspace nobody has
// connected yet. The CLI turns it into a guidance line, so it must not arrive
// as an error.
func TestListConnectionsAcceptsAnEmptyAllowList(t *testing.T) {
	stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, `{"connections":[]}`, nil))
	names, err := ListConnections(context.Background(), stateDir, client)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("connections = %q", names)
	}
}

func TestListConnectionsRejectsAResponseItCannotUse(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		// A string is not a list. Ranging over it would print the provider one
		// letter per line.
		{name: "connections is not an array", body: `{"connections":"github"}`},
		// The name becomes a URL path segment on the next pull, so a slash in it
		// would send that pull to another route.
		{name: "provider name holds a slash", body: `{"connections":["git/hub"]}`},
		// No field at all is not an empty list. It means the control plane
		// answered something else, and guessing which is how a wrong reply gets
		// read as "nothing is connected".
		{name: "connections is absent", body: `{}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, test.body, nil))
			if _, err := ListConnections(context.Background(), stateDir, client); err == nil {
				t.Fatal("the connection list was accepted")
			}
		})
	}
}

func TestMintConnectionTokenPullsOneCredential(t *testing.T) {
	var calls []string
	stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, validTokenBody, &calls))
	token, err := MintConnectionToken(context.Background(), stateDir, "github", client)
	if err != nil {
		t.Fatal(err)
	}
	want := ConnectionToken{
		Connection: "github",
		Mode:       "inject",
		Token:      "ghs-live",
		Env:        []ConnectionEnv{{Name: "GH_TOKEN", Value: "ghs-live"}},
		Header:     TokenHeader{Name: "Authorization", Prefix: "Bearer "},
		ExpiresAt:  2_000_000_000_000,
	}
	if token.Connection != want.Connection || token.Mode != want.Mode ||
		token.Token != want.Token || token.Header != want.Header ||
		token.ExpiresAt != want.ExpiresAt || !slices.Equal(token.Env, want.Env) {
		t.Fatalf("token = %#v, want %#v", token, want)
	}
	if !slices.Equal(calls, []string{"POST /workspaces/self/connections/github/token"}) {
		t.Fatalf("control-plane calls = %q", calls)
	}
}

func TestMintConnectionTokenRejectsAReplyItCannotPrint(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		// The caller asked for github. A reply naming another provider would
		// hand the agent a credential for a service it never asked about.
		{name: "reply names another connection", body: `{"connection":"linear","mode":"inject",` +
			`"token":"lin-live","env":[{"name":"LINEAR_API_KEY","value":"lin-live"}],` +
			`"header":{"name":"Authorization","prefix":""},"expiresAt":2000000000000}`},
		// `blitz-cred get` prints the token and a newline. A token that already
		// holds one would look like a token plus a second line of output.
		{name: "token holds a newline", body: `{"connection":"github","mode":"inject",` +
			`"token":"ghs-live\nexport EVIL=1","env":[{"name":"GH_TOKEN","value":"ghs-live"}],` +
			`"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000}`},
		// `blitz-cred env` prints NAME='value' for a shell to eval. A name that
		// is not a shell identifier makes that line a command, not a variable.
		{name: "env name is not a shell identifier", body: `{"connection":"github","mode":"inject",` +
			`"token":"ghs-live","env":[{"name":"GH TOKEN","value":"ghs-live"}],` +
			`"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000}`},
		// A field this box does not know is a contract change. Ignoring it would
		// let one side of the wire move alone and stay silent about it.
		{name: "reply carries an unknown field", body: `{"connection":"github","mode":"inject",` +
			`"token":"ghs-live","env":[{"name":"GH_TOKEN","value":"ghs-live"}],` +
			`"header":{"name":"Authorization","prefix":"Bearer "},"expiresAt":2000000000000,` +
			`"refreshToken":"unexpected"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, test.body, nil))
			if _, err := MintConnectionToken(context.Background(), stateDir, "github", client); err == nil {
				t.Fatal("the mint reply was accepted")
			}
		})
	}
}

// A refusal has to keep its cause and the request id. The CLI turns the cause
// into the sentence that names `blitz connections open`, and the id is the
// inbox row the member answers.
func TestMintConnectionTokenRefusalsCarryTheirCauseAndRequestID(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		body      string
		cause     error
		requestID string
	}{
		{
			name:      "workspace is not connected",
			status:    http.StatusForbidden,
			body:      `{"error":"denied","request_id":"request-403"}`,
			cause:     ErrCredentialDenied,
			requestID: "request-403",
		},
		{
			name:      "provider has no credential behind it",
			status:    http.StatusNotFound,
			body:      `{"error":"missing","request_id":"request-404"}`,
			cause:     ErrConnectionNotConfigured,
			requestID: "request-404",
		},
		{
			name:   "refusal filed no request",
			status: http.StatusForbidden,
			body:   `{"error":"denied"}`,
			cause:  ErrCredentialDenied,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			stateDir, client := seedConnectionsBox(t, answerWith(t, test.status, test.body, nil))
			_, err := MintConnectionToken(context.Background(), stateDir, "github", client)
			if !errors.Is(err, test.cause) {
				t.Fatalf("error = %v, want %v", err, test.cause)
			}
			if got := AccessRequestID(err); got != test.requestID {
				t.Fatalf("request id = %q, want %q", got, test.requestID)
			}
		})
	}
}

// connectionPullFixtures reads the corpus both sides of this wire share. The
// control plane produces these bytes and this package consumes them, and the
// two cannot import one module, so the corpus is what keeps them equal.
func connectionPullFixtures(t *testing.T, kind string) []string {
	t.Helper()
	directory := filepath.Join("..", "..", "..", "schema", "fixtures", "connection-pull", kind)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			fixtures = append(fixtures, filepath.Join(directory, entry.Name()))
		}
	}
	if len(fixtures) == 0 {
		t.Fatalf("no %s fixtures found", kind)
	}
	return fixtures
}

func TestConnectionPullFixtures(t *testing.T) {
	for _, path := range connectionPullFixtures(t, "valid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeConnectionToken(data); err != nil {
			t.Errorf("valid fixture %s: %v", filepath.Base(path), err)
		}
	}
	for _, path := range connectionPullFixtures(t, "invalid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeConnectionToken(data); err == nil {
			t.Errorf("invalid fixture %s was accepted", filepath.Base(path))
		}
	}
}
