package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestListCredentialsReadsNamesAndComments(t *testing.T) {
	var calls []string
	stateDir, client := seedConnectionsBox(t, answerWith(
		t,
		http.StatusOK,
		`{"credentials":[{"name":"CF_TOKEN","comment":"canary token"},{"name":"PLAIN_KEY"}]}`,
		&calls,
	))
	credentials, err := ListCredentials(context.Background(), stateDir, client)
	if err != nil {
		t.Fatal(err)
	}
	if len(credentials) != 2 || credentials[0].Comment != "canary token" || credentials[1].Comment != "" {
		t.Fatalf("credentials = %+v", credentials)
	}
	if len(calls) != 1 || calls[0] != "GET /workspaces/self/credentials" {
		t.Fatalf("control-plane calls = %q", calls)
	}
}

func TestPutCredentialSendsTheCommentAndNamesTheAdminGate(t *testing.T) {
	var request struct {
		Name    string `json:"name"`
		Value   string `json:"value"`
		Label   string `json:"label"`
		Comment string `json:"comment"`
	}
	var method string
	stateDir, client := seedConnectionsBox(t, func(writer http.ResponseWriter, incoming *http.Request) {
		method = incoming.Method + " " + incoming.URL.Path
		body, err := io.ReadAll(incoming.Body)
		if err != nil {
			t.Error(err)
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		writer.WriteHeader(http.StatusCreated)
	})
	err := PutCredential(
		context.Background(), stateDir,
		"STRIPE_API_KEY", "sk_test", "", "test-mode key, safe for CI",
		client,
	)
	if err != nil {
		t.Fatal(err)
	}
	if method != "PUT /workspaces/self/credentials" {
		t.Fatalf("method = %q", method)
	}
	if request.Name != "STRIPE_API_KEY" || request.Value != "sk_test" ||
		request.Comment != "test-mode key, safe for CI" {
		t.Fatalf("request = %+v", request)
	}

	refusedDir, refusedClient := seedConnectionsBox(t, answerWith(
		t, http.StatusForbidden, `{"error":"workspace admin required"}`, nil,
	))
	err = PutCredential(context.Background(), refusedDir, "A_KEY", "v", "", "", refusedClient)
	if !errors.Is(err, ErrNotWorkspaceAdmin) {
		t.Fatalf("err = %v", err)
	}
}

// A multi-line value or comment is refused before any request leaves the box:
// the wire would refuse it anyway, and the local error is a sentence.
func TestPutCredentialRefusesWhatItCannotPrint(t *testing.T) {
	stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusCreated, "", nil))
	for _, test := range []struct{ name, value, comment string }{
		{"bad name", "v", ""},
		{"A_KEY", "", ""},
		{"A_KEY", "line one\nline two", ""},
		{"A_KEY", "v", "two\nlines"},
	} {
		err := PutCredential(context.Background(), stateDir, test.name, test.value, "", test.comment, client)
		if err == nil {
			t.Errorf("%+v: accepted", test)
		}
	}
}

func TestCredentialListFixtures(t *testing.T) {
	for _, path := range sharedFixtures(t, "credential-list", "valid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, string(data), nil))
		if _, err := ListCredentials(context.Background(), stateDir, client); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
	for _, path := range sharedFixtures(t, "credential-list", "invalid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, string(data), nil))
		if _, err := ListCredentials(context.Background(), stateDir, client); err == nil ||
			!strings.Contains(err.Error(), "invalid credential list response") {
			t.Errorf("%s: err = %v", path, err)
		}
	}
}
