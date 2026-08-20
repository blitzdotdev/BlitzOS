package workspace

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

// TestRegisterTreatsNoBrokerCapacityAsACleanSkip is the resilience property the
// whole boot path depends on: the broker is OPTIONAL. Zero enrolled brokers is
// how the feature is turned off, and every broker being full is the same
// answer. Neither may leave a workspace that failed to start — a signed-out
// workspace is one a human can fix from inside, and a workspace whose services
// refused to run is not.
func TestRegisterTreatsNoBrokerCapacityAsACleanSkip(t *testing.T) {
	stateDir := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedBox(t, stateDir)

	// Wiring from a previous, successful registration.
	writeFile(t, filepath.Join(stateDir, BrokerFile), `{"host":"old.example","port":22,"member":"m-0123456789ab"}`)
	writeFile(t, filepath.Join(stateDir, KnownHostsFile), "old.example ssh-ed25519 AAAA\n")
	writeFile(t, filepath.Join(home, codexConfigPath), codexHead+"\nmodel = \"gpt-5\"\n"+codexTail+"\n")

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"error":"no_broker_capacity","retryAction":null}`))
	}))
	defer server.Close()
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}

	if err := Register(context.Background(), stateDir, server.Client()); err != nil {
		t.Fatalf("Register failed on a capacity refusal instead of skipping: %v", err)
	}

	// The stale wiring is GONE. Leaving it would point every mint at a box
	// that has no account for this member, failing slowly instead of clearly.
	for _, name := range []string{BrokerFile, KnownHostsFile} {
		if _, err := os.Stat(filepath.Join(stateDir, name)); !os.IsNotExist(err) {
			t.Errorf("%s survived a capacity refusal", name)
		}
	}
	// The member's own codex settings survive; only our block goes.
	config, err := os.ReadFile(filepath.Join(home, codexConfigPath))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(config), codexAuthCommand) {
		t.Errorf("the codex broker block survived a capacity refusal: %q", config)
	}
	if !strings.Contains(string(config), `model = "gpt-5"`) {
		t.Errorf("the member's own codex settings were destroyed: %q", config)
	}
	// The keypairs stay: they are this workspace's identity, and churning them
	// every boot would invalidate lines a broker may already hold.
	if _, err := os.Stat(filepath.Join(stateDir, MintKeyFile)); err != nil {
		t.Errorf("the workspace keypair was discarded: %v", err)
	}
}

// TestRegisterRetriesATransientFailure covers the boot race: a workspace
// registers at the moment its own network is coming up, and nothing retries
// afterwards, so one attempt turns a lost half-second into a box with no
// broker for its entire life.
func TestRegisterRetriesATransientFailure(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	seedBox(t, stateDir)
	previous := registerRetryDelay
	registerRetryDelay = time.Millisecond
	defer func() { registerRetryDelay = previous }()

	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls++
		if calls < registerAttempts {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = writer.Write([]byte(`{"memberUnixName":"m-0123456789ab","broker":{"host":"broker.example","port":22,"sshHostPublicKey":"ssh-ed25519 AAAA"}}`))
	}))
	defer server.Close()
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}

	if err := Register(context.Background(), stateDir, server.Client()); err != nil {
		t.Fatal(err)
	}
	if calls != registerAttempts {
		t.Fatalf("registration attempts = %d, want %d", calls, registerAttempts)
	}
	if _, err := os.Stat(filepath.Join(stateDir, BrokerFile)); err != nil {
		t.Fatalf("a successful retry wrote no broker config: %v", err)
	}
}

// TestRegisterWritesTheCodexPullHookInTwoRegions pins the shape codex needs.
// TOML is position-sensitive: a bare key after a [table] header belongs to that
// table, so the bare `model_provider` has to sit above the member's own content
// and the provider tables below it. One region would swallow whatever is
// between them.
func TestRegisterWritesTheCodexPullHookInTwoRegions(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, codexConfigPath)
	writeFile(t, path, "model_provider = \"mine\"\nmodel = \"gpt-5\"\n\n[tui]\nnotifications = true\n")

	if err := wireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	rendered, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := string(rendered)

	headAt := strings.Index(config, codexHeadBegin)
	ownAt := strings.Index(config, "[tui]")
	tailAt := strings.Index(config, codexTailBegin)
	if headAt < 0 || ownAt < 0 || tailAt < 0 || !(headAt < ownAt && ownAt < tailAt) {
		t.Fatalf("regions are out of order: %q", config)
	}
	if !strings.Contains(config, "refresh_interval_ms = 300000") {
		t.Errorf("the pull hook has no refresh interval: %q", config)
	}
	if !strings.Contains(config, `command = "`+codexAuthCommand+`"`) {
		t.Errorf("the pull hook does not call the broker: %q", config)
	}
	// The member's own top-level model_provider must be gone: a second one is
	// a duplicate-key parse error and codex would refuse the whole file.
	if strings.Contains(config, `model_provider = "mine"`) {
		t.Errorf("a duplicate top-level model_provider survived: %q", config)
	}
	if !strings.Contains(config, `model = "gpt-5"`) || !strings.Contains(config, "notifications = true") {
		t.Errorf("the member's own settings were lost: %q", config)
	}

	// Re-registering replaces exactly our lines and is otherwise a no-op.
	if err := wireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	again, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != config {
		t.Fatalf("re-registering changed the file:\nfirst:  %q\nsecond: %q", config, again)
	}
	if strings.Count(string(again), codexHeadBegin) != 1 || strings.Count(string(again), codexTailBegin) != 1 {
		t.Fatalf("re-registering duplicated a region: %q", again)
	}
}

// TestWatcherDeletesTheWorkspaceCopyOnAck is "single copy by construction". The
// broker is the only thing that refreshes a credential and the only place a
// second workspace can get one; a workspace that kept its copy would be an
// unmanaged, never-refreshed replica sitting on a disposable VM.
func TestWatcherDeletesTheWorkspaceCopyOnAck(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	writeFile(t, path, "a-login")

	var deposits int
	watcher := NewWatcher(home, func(context.Context, string, []byte) error {
		deposits++
		return nil
	})
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the workspace kept its copy after the broker ACKed: %v", err)
	}

	// A later login producing byte-identical content is still a login. The
	// remembered digest must not suppress it.
	writeFile(t, path, "a-login")
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if deposits != 2 {
		t.Fatalf("deposits = %d, want 2", deposits)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the second copy was not removed")
	}
}

// TestWatcherKeepsACopyTheBrokerNeverReceived is the other half. A login that
// lands DURING a deposit leaves different bytes on disk; deleting those would
// destroy a credential the broker never got, from the only two places it
// exists at once.
func TestWatcherKeepsACopyTheBrokerNeverReceived(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	writeFile(t, path, "old-login")

	watcher := NewWatcher(home, func(context.Context, string, []byte) error {
		writeFile(t, path, "fresher-login")
		return nil
	})
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("a login that raced the deposit was deleted: %v", err)
	}
	if string(got) != "fresher-login" {
		t.Fatalf("credential = %q, want the fresher login", got)
	}
}

// TestWatcherReportsACopyItCouldNotRemove: the broker has it and so does this
// workspace, which is exactly the state the design forbids. It has to be
// audible, and it must not turn into a deposit every second.
func TestWatcherReportsACopyItCouldNotRemove(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	writeFile(t, path, "a-login")
	if err := os.Chmod(filepath.Dir(path), 0o500); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Dir(path), 0o700)

	var deposits int
	watcher := NewWatcher(home, func(context.Context, string, []byte) error {
		deposits++
		return nil
	})
	if err := watcher.Tick(context.Background()); err == nil {
		t.Fatal("an unremovable workspace copy was reported as success")
	}
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatalf("the second tick re-reported a copy it had already deposited: %v", err)
	}
	if deposits != 1 {
		t.Fatalf("deposits = %d, want 1 — the watcher hammered the broker", deposits)
	}
}

func TestRemoveIfUnchangedLeavesAFileThatMovedOn(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credential")
	writeFile(t, path, "new")
	removed, err := removeIfUnchanged(path, sha256.Sum256([]byte("old")))
	if err != nil {
		t.Fatal(err)
	}
	if removed {
		t.Fatal("removeIfUnchanged deleted a file whose contents had changed")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("the file is gone: %v", err)
	}
}

func seedBox(t *testing.T, stateDir string) {
	t.Helper()
	if err := store.SaveCredential(stateDir, store.Credential{
		BoxID: "box", AccessToken: "access", RefreshToken: "refresh",
	}); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
