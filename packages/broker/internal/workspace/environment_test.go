package workspace

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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

	ready, _, err := environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
	if err != nil || ready {
		t.Fatalf("first tick ready=%v err=%v", ready, err)
	}
	envDir := filepath.Join(stateDir, workspaceEnvironmentDirectory)
	// The workspace variables ride the credential env.d pipeline, in the entry
	// that blitz-creds.sh sources before any integration file.
	credsEnvDir := filepath.Join(stateDir, credentialsDirectory, environmentDirectory)
	fragment, err := os.ReadFile(filepath.Join(credsEnvDir, workspaceEnvironmentEntry))
	if err != nil {
		t.Fatal(err)
	}
	if string(fragment) != "export GREETING='it'\"'\"'s $HOME\nnext'\nexport ORDERED='yes'\n" {
		t.Fatalf("environment fragment = %q", fragment)
	}
	if _, err := os.Stat(filepath.Join(envDir, startupDoneFile)); !os.IsNotExist(err) {
		t.Fatal("startup marker exists before files are ready")
	}

	ready, started, err := environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
	if err != nil || !ready {
		t.Fatalf("second tick ready=%v err=%v", ready, err)
	}
	<-started
	ready, _, err = environmentTick(context.Background(), stateDir, workspaceDir, server.Client())
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
	for _, name := range []string{workspaceEnvironmentState, startupDoneFile, startupLogFile} {
		info, err := os.Stat(filepath.Join(envDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o", name, info.Mode().Perm())
		}
	}
	assertFileMode(t, filepath.Join(credsEnvDir, workspaceEnvironmentEntry), 0o600)
}

// A startup script that never exits is a legitimate thing to ask for (a dev
// server). It must not stop the watch loop, which is also the credential
// deposit path.
func TestStartupScriptNeverBlocksTheWatchLoop(t *testing.T) {
	stateDir := t.TempDir()
	workspaceDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, workspaceEnvironmentDirectory), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	script := "printf started > started.txt\nwhile true; do sleep 1; done\n"
	deposits := make(chan struct{}, 4)
	watcher := NewWatcher(t.TempDir(), func(context.Context, string, []byte) error {
		return nil
	})
	ticks := make(chan struct{})
	go func() {
		defer close(ticks)
		if _, err := startStartupOnce(ctx, stateDir, workspaceDir, WorkspaceEnvironment{
			Env: map[string]string{}, StartupScript: &script,
		}, startupScriptTimeout); err != nil {
			t.Error(err)
		}
		// The watch loop keeps depositing while the script above still runs.
		for range cap(deposits) {
			_ = watcher.Tick(ctx)
			deposits <- struct{}{}
		}
	}()
	select {
	case <-ticks:
	case <-time.After(20 * time.Second):
		t.Fatal("startup script blocked the deposit path")
	}
	if len(deposits) != cap(deposits) {
		t.Fatalf("deposit ticks = %d", len(deposits))
	}
	// The script is still running; it only had to start, not finish.
	deadline := time.Now().Add(20 * time.Second)
	for {
		started, err := os.ReadFile(filepath.Join(workspaceDir, "started.txt"))
		if err == nil && string(started) == "started" {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("startup script did not run: %q %v", started, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A credential sync rebuilds creds/env.d from scratch. The workspace entry has
// to survive that, and must lose to a credential of the same name.
func TestCredentialSyncKeepsWorkspaceEnvironmentAndWinsCollisions(t *testing.T) {
	stateDir := t.TempDir()
	if err := storeWorkspaceEnvironment(stateDir, WorkspaceEnvironment{
		Env:        map[string]string{"SHARED": "workspace", "WORKSPACE_ONLY": "yes"},
		FilesReady: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := applySync(stateDir, []MintResult{{
		Integration: "github",
		ExpiresAt:   900_000,
		Placements:  []Placement{{Kind: "env", Name: "SHARED", Value: "credential"}},
	}}, 123_456); err != nil {
		t.Fatal(err)
	}
	envDir := filepath.Join(stateDir, credentialsDirectory, environmentDirectory)
	entries, err := os.ReadDir(envDir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	// Sorted order is the shell glob order, so the credential file is sourced
	// last and its SHARED export wins.
	if !slices.Equal(names, []string{workspaceEnvironmentEntry, "github.sh"}) {
		t.Fatalf("env.d entries = %q", names)
	}
	workspaceEntry, err := os.ReadFile(filepath.Join(envDir, workspaceEnvironmentEntry))
	if err != nil {
		t.Fatal(err)
	}
	if string(workspaceEntry) != "export SHARED='workspace'\nexport WORKSPACE_ONLY='yes'\n" {
		t.Fatalf("workspace entry = %q", workspaceEntry)
	}
}

func TestStartupScriptStopsAtItsDeadline(t *testing.T) {
	stateDir := t.TempDir()
	workspaceDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, workspaceEnvironmentDirectory), 0o700); err != nil {
		t.Fatal(err)
	}
	// A script that backgrounds work and then never returns. The parent context
	// stays live for the whole test: only the deadline may end this.
	script := "(sleep 120 &) \nwhile true; do sleep 1; done\n"
	started := time.Now()
	done, err := startStartupOnce(context.Background(), stateDir, workspaceDir, WorkspaceEnvironment{
		Env: map[string]string{}, StartupScript: &script,
	}, 200*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("a non-exiting startup script outlived its deadline")
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("startup script ran for %s", elapsed)
	}
	logged, err := os.ReadFile(filepath.Join(stateDir, workspaceEnvironmentDirectory, startupLogFile))
	if err != nil {
		t.Fatal(err)
	}
	// The author has to be able to see why their script stopped.
	if !strings.Contains(string(logged), "stopped after 200ms") {
		t.Fatalf("startup log = %q", logged)
	}
}
