package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/store"
)

func TestHelpListsOnlyAPIToken(t *testing.T) {
	var output strings.Builder
	if err := run([]string{"help"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != usageText+"\n" {
		t.Fatalf("help output = %q", output.String())
	}
	for _, removed := range []string{"register", "token", "watch", "enroll"} {
		if strings.Contains(output.String(), "\n  "+removed+" ") {
			t.Errorf("help names removed verb %q", removed)
		}
		if err := run([]string{removed}, io.Discard); err == nil {
			t.Errorf("removed verb %q succeeded", removed)
		}
	}
}

func TestAPITokenStdoutContainsOnlyTokenAndOneNewline(t *testing.T) {
	stateDir := t.TempDir()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/agent/api" {
			http.NotFound(writer, request)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	writeState(t, stateDir, server.URL)
	t.Setenv("BLITZ_STATE_DIR", stateDir)

	var output strings.Builder
	if err := run([]string{"api-token"}, &output); err != nil {
		t.Fatal(err)
	}
	if output.String() != "access\n" {
		t.Fatalf("api-token output = %q", output.String())
	}
}

func writeState(t *testing.T, stateDir, origin string) {
	t.Helper()
	credential := store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}
	if err := store.SaveCredential(stateDir, credential); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, store.OriginFile), []byte(origin+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
