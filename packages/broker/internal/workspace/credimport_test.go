package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validImportBody = `{"results":[` +
	`{"name":"STRIPE_API_KEY","line":1,"outcome":"stored"},` +
	`{"name":"CF_TOKEN","line":2,"outcome":"rotated"},` +
	`{"name":"GOOGLE_SA_JSON","line":3,"outcome":"refused",` +
	`"reason":"value spans more than one line; base64-encode it first"}],` +
	`"linesRead":4}`

func TestImportCredentialsSendsTextAndReadsOutcomes(t *testing.T) {
	var request struct {
		Text   string `json:"text"`
		Label  string `json:"label"`
		DryRun bool   `json:"dryRun"`
	}
	var path string
	stateDir, client := seedConnectionsBox(t, func(writer http.ResponseWriter, incoming *http.Request) {
		path = incoming.Method + " " + incoming.URL.Path
		body, err := io.ReadAll(incoming.Body)
		if err != nil {
			t.Error(err)
		}
		if err := json.Unmarshal(body, &request); err != nil {
			t.Error(err)
		}
		if _, err := io.WriteString(writer, validImportBody); err != nil {
			t.Error(err)
		}
	})
	result, err := ImportCredentials(
		context.Background(), stateDir, "STRIPE_API_KEY=sk\n", "blitzos.env", true, client,
	)
	if err != nil {
		t.Fatal(err)
	}
	if path != "POST /workspaces/self/credentials/dotenv" {
		t.Fatalf("path = %q", path)
	}
	if request.Text != "STRIPE_API_KEY=sk\n" || request.Label != "blitzos.env" || !request.DryRun {
		t.Fatalf("request = %+v", request)
	}
	if result.LinesRead != 4 || len(result.Results) != 3 {
		t.Fatalf("result = %+v", result)
	}
	if result.Results[1].Outcome != "rotated" || result.Results[2].Reason == "" {
		t.Fatalf("results = %+v", result.Results)
	}
}

func TestImportCredentialsNamesTheAdminGate(t *testing.T) {
	stateDir, client := seedConnectionsBox(t, answerWith(
		t, http.StatusForbidden, `{"error":"workspace admin required"}`, nil,
	))
	_, err := ImportCredentials(context.Background(), stateDir, "A=b\n", "", false, client)
	if !errors.Is(err, ErrNotWorkspaceAdmin) {
		t.Fatalf("err = %v", err)
	}
}

// A response that could forge a stdout line is refused whole: names and
// reasons are printed, so they obey the same printability rule as tokens.
func TestImportCredentialsRefusesUnprintableResponses(t *testing.T) {
	for _, body := range []string{
		`{"results":[{"name":"BAD\nNAME","line":1,"outcome":"stored"}],"linesRead":1}`,
		`{"results":[{"name":"KEY","line":1,"outcome":"minted"}],"linesRead":1}`,
		`{"results":null,"linesRead":1}`,
		`{"results":[],"linesRead":1,"extra":true}`,
	} {
		stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, body, nil))
		_, err := ImportCredentials(context.Background(), stateDir, "A=b\n", "", false, client)
		if err == nil || !strings.Contains(err.Error(), "invalid credential import response") {
			t.Fatalf("body %q: err = %v", body, err)
		}
	}
}

// sharedFixtures reads a corpus both sides of a wire share. The control
// plane produces these bytes and this package prints them, and the two
// cannot import one module, so the corpus is what keeps them equal.
func sharedFixtures(t *testing.T, contract, kind string) []string {
	t.Helper()
	directory := filepath.Join("..", "..", "..", "schema", "fixtures", contract, kind)
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

func TestCredentialImportFixtures(t *testing.T) {
	for _, path := range sharedFixtures(t, "credential-import", "valid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, string(data), nil))
		if _, err := ImportCredentials(context.Background(), stateDir, "A=b\n", "", false, client); err != nil {
			t.Errorf("%s: %v", path, err)
		}
	}
	for _, path := range sharedFixtures(t, "credential-import", "invalid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		stateDir, client := seedConnectionsBox(t, answerWith(t, http.StatusOK, string(data), nil))
		if _, err := ImportCredentials(context.Background(), stateDir, "A=b\n", "", false, client); err == nil {
			t.Errorf("%s: accepted an invalid body", path)
		}
	}
}
