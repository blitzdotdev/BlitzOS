package workspace

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func workspaceEnvironmentFixtures(t *testing.T, kind string) []string {
	t.Helper()
	directory := filepath.Join("..", "..", "..", "schema", "fixtures", "workspace-environment", kind)
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
	return fixtures
}

func TestWorkspaceEnvironmentFixtures(t *testing.T) {
	for _, path := range workspaceEnvironmentFixtures(t, "valid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeWorkspaceEnvironment(data); err != nil {
			t.Errorf("valid fixture %s: %v", filepath.Base(path), err)
		}
	}
	for _, path := range workspaceEnvironmentFixtures(t, "invalid") {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := decodeWorkspaceEnvironment(data); err == nil {
			t.Errorf("invalid fixture %s was accepted", filepath.Base(path))
		}
	}
}

func TestEnvironmentTickStoresConfigAndRunsStartupOnce(t *testing.T) {
	stateDir := t.TempDir()
	workspaceDir := t.TempDir()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/workspaces/self/environment" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		response := WorkspaceEnvironment{
			Env: map[string]string{
				"GREETING": "it's $HOME\nnext",
				"ORDERED":  "yes",
			},
			StartupScript: func() *string {
				script := "printf '%s\\n' \"$GREETING\"\nprintf run >> runs.txt\n"
				return &script
			}(),
			FilesReady: requests.Add(1) > 1,
		}
		if err := json.NewEncoder(writer).Encode(response); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	if err := store.SaveCredential(stateDir, store.Credential{
		BoxID: "box", AccessToken: "access", RefreshToken: "refresh",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}

	ready, err := environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
	if err != nil || ready {
		t.Fatalf("first tick ready=%v err=%v", ready, err)
	}
	envDir := filepath.Join(stateDir, workspaceEnvironmentDirectory)
	fragment, err := os.ReadFile(filepath.Join(envDir, workspaceEnvironmentShell))
	if err != nil {
		t.Fatal(err)
	}
	if string(fragment) != "export GREETING='it'\"'\"'s $HOME\nnext'\nexport ORDERED='yes'\n" {
		t.Fatalf("environment fragment = %q", fragment)
	}
	if _, err := os.Stat(filepath.Join(envDir, startupDoneFile)); !os.IsNotExist(err) {
		t.Fatal("startup marker exists before files are ready")
	}

	ready, err = environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
	if err != nil || !ready {
		t.Fatalf("second tick ready=%v err=%v", ready, err)
	}
	ready, err = environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
	if err != nil || !ready {
		t.Fatalf("third tick ready=%v err=%v", ready, err)
	}
	runs, err := os.ReadFile(filepath.Join(workspaceDir, "runs.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(runs) != "run" {
		t.Fatalf("startup runs = %q", runs)
	}
	log, err := os.Open(filepath.Join(envDir, startupLogFile))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	logged, err := io.ReadAll(log)
	if err != nil {
		t.Fatal(err)
	}
	if string(logged) != "it's $HOME\nnext\n" {
		t.Fatalf("startup log = %q", logged)
	}
	for _, name := range []string{workspaceEnvironmentState, workspaceEnvironmentShell, startupDoneFile, startupLogFile} {
		info, err := os.Stat(filepath.Join(envDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o", name, info.Mode().Perm())
		}
	}
}
