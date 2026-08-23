package workspace

import (
	"context"
	"encoding/json"
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

	ready, err := environmentTick(context.Background(), stateDir, workspaceDir)
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

	ready, err = environmentTick(context.Background(), stateDir, workspaceDir)
	if err != nil || !ready {
		t.Fatalf("second tick ready=%v err=%v", ready, err)
	}
	// The script runs detached; its exit is observable only through its
	// effects, so poll for them the way the box's own readers would.
	waitForFileContent(t, filepath.Join(workspaceDir, "runs.txt"), "run")
	waitForFileContent(t, filepath.Join(envDir, startupLogFile), "it's $HOME\nnext\n")
	ready, err = environmentTick(context.Background(), stateDir, workspaceDir)
	if err != nil || !ready {
		t.Fatalf("third tick ready=%v err=%v", ready, err)
	}
	// The once-only marker was claimed on the second tick, so the third must
	// not have started the script again.
	runs, err := os.ReadFile(filepath.Join(workspaceDir, "runs.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(runs) != "run" {
		t.Fatalf("startup runs = %q", runs)
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

// waitForFileContent polls until path holds exactly want. The startup script
// runs detached from every caller, so its effects are the only way to observe
// it — the same way the box's own readers see it.
func waitForFileContent(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		got, err := os.ReadFile(path)
		if err == nil && string(got) == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s = %q, %v; want %q", path, got, err, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
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
	// An empty home: the watcher finds no credentials, so its ticks are pure
	// loop turns — exactly what must keep happening while the script runs.
	watcher := NewWatcher(t.TempDir(), t.TempDir())
	ticks := make(chan struct{})
	go func() {
		defer close(ticks)
		if err := startStartupOnce(ctx, stateDir, workspaceDir, WorkspaceEnvironment{
			Env: map[string]string{}, StartupScript: &script,
		}); err != nil {
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
	waitForFileContent(t, filepath.Join(workspaceDir, "started.txt"), "started")
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

// TestStartupScriptStopsAtItsDeadline drives the kill-and-say-so path. The
// production deadline is startupScriptTimeout (10 minutes) — far too long for
// a test to sit out — so the test supplies the deadline through the caller's
// context, which reaches the script through exactly the same
// context.WithTimeout + CommandContext chain and takes the same
// DeadlineExceeded branch.
func TestStartupScriptStopsAtItsDeadline(t *testing.T) {
	stateDir := t.TempDir()
	workspaceDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(stateDir, workspaceEnvironmentDirectory), 0o700); err != nil {
		t.Fatal(err)
	}
	// A script that backgrounds work and then never returns. Only the deadline
	// may end this.
	script := "(sleep 120 &) \nwhile true; do sleep 1; done\n"
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := startStartupOnce(ctx, stateDir, workspaceDir, WorkspaceEnvironment{
		Env: map[string]string{}, StartupScript: &script,
	}); err != nil {
		t.Fatal(err)
	}
	// The author has to be able to see why their script stopped. The exit is
	// observable only through the log, so poll for the line.
	logPath := filepath.Join(stateDir, workspaceEnvironmentDirectory, startupLogFile)
	deadline := time.Now().Add(30 * time.Second)
	for {
		logged, err := os.ReadFile(logPath)
		if err == nil && strings.Contains(string(logged), "stopped after") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a non-exiting startup script outlived its deadline: log=%q err=%v", logged, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("startup script ran for %s", elapsed)
	}
}
