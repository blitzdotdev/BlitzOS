package workspace

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
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
	// Read off the constant, not a copy of its value: the literal used to be
	// written out twice, so tuning codexRefreshInterval moved nothing and no
	// test noticed.
	if !strings.Contains(config, "refresh_interval_ms = "+strconv.Itoa(codexRefreshInterval)) {
		t.Errorf("the pull hook does not carry codexRefreshInterval: %q", config)
	}
	if !strings.Contains(config, `command = "`+codexAuthCommand+`"`) {
		t.Errorf("the pull hook does not call the broker: %q", config)
	}
	// Exactly one LIVE top-level model_provider, and it is ours: a second one
	// is a duplicate-key parse error and codex would refuse the whole file.
	if live := liveModelProviderLines(config); len(live) != 1 || live[0] != `model_provider = "blitz"` {
		t.Errorf("live top-level model_provider lines = %q, want only the broker's: %q", live, config)
	}
	// The member's own value is not destroyed, it is parked in a comment the
	// marked region owns, which is what unwireHarnesses gives back.
	if !strings.Contains(config, codexPreservedPrefix+`model_provider = "mine"`) {
		t.Errorf("the member's own model_provider was deleted with no way back: %q", config)
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
	// The preserved line has to be read back out of the region it lives in on
	// every later wire. Reading it from the wrong place, or emitting it without
	// stripping the previous one, shows up here as two.
	if strings.Count(string(again), codexPreservedPrefix) != 1 {
		t.Fatalf("re-registering did not keep exactly one preserved model_provider: %q", again)
	}
}

// TestUnwireGivesTheMemberBackTheirOwnModelProvider is the recovery path for a
// box that later lands in no_broker_capacity. Wiring MUST delete the member's
// top-level model_provider, because a second one is a duplicate-key parse error
// that makes codex refuse the whole file; unwiring without putting it back
// leaves codex on its default provider, with the member's own choice gone from
// the only place it was written down and nothing on the box able to say what it
// had been.
func TestUnwireGivesTheMemberBackTheirOwnModelProvider(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, codexConfigPath)
	writeFile(t, path, "model_provider = \"mine\"\nmodel = \"gpt-5\"\n\n[tui]\nnotifications = true\n")

	if err := wireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	if err := unwireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := string(restored)
	// Top-level again, above every [table] header: a bare key below one belongs
	// to that table and would configure something else entirely.
	if got := topLevelModelProvider(config); got != `model_provider = "mine"` {
		t.Fatalf("restored top-level model_provider = %q, want the member's own: %q", got, config)
	}
	if strings.Contains(config, codexAuthCommand) || strings.Contains(config, codexPreservedPrefix) {
		t.Errorf("unwiring left the broker's own lines behind: %q", config)
	}
	if !strings.Contains(config, `model = "gpt-5"`) || !strings.Contains(config, "notifications = true") {
		t.Errorf("the member's other settings were lost: %q", config)
	}
}

// TestWireInventsNoModelProviderTheMemberNeverSet keeps the preserved line a
// record of something the member wrote rather than a default. A file with no
// top-level model_provider that came back from an unwire carrying one would be
// configured by this code for a provider nobody chose.
func TestWireInventsNoModelProviderTheMemberNeverSet(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, codexConfigPath)
	const own = "model = \"gpt-5\"\n"
	writeFile(t, path, own)

	if err := wireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	wired, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wired), codexPreservedPrefix) {
		t.Fatalf("wiring invented a preserved model_provider: %q", wired)
	}
	if err := unwireHarnesses(home); err != nil {
		t.Fatal(err)
	}
	unwired, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(unwired) != own {
		t.Fatalf("unwiring a file with nothing preserved changed it: %q, want %q", unwired, own)
	}
}

// TestTokenStripsTheMintReplysLineTerminator pins the Go half of the
// trailing-newline chain. `blitz-broker mint` ends its reply with fmt.Fprintln,
// and everything downstream copies these bytes into CLAUDE_CODE_OAUTH_TOKEN
// verbatim — including callers that set the variable directly, where a newline
// reaches the vendor inside an Authorization header and is rejected with an
// error naming nothing on this box. The terminal shim only ever survived
// because $(...) strips it by accident.
func TestTokenStripsTheMintReplysLineTerminator(t *testing.T) {
	stateDir := seedBrokerWiring(t)
	fakeSSH(t, "printf '%s\\n' 'sk-ant-oat01-live'\n")

	token, err := Token(context.Background(), stateDir, "claude")
	if err != nil {
		t.Fatal(err)
	}
	if string(token) != "sk-ant-oat01-live" {
		t.Fatalf("token = %q, want it stripped of the line terminator", token)
	}
}

// TestTokenRefusesAReplyThatHoldsOnlyATerminator covers what trimming exposes:
// a reply of one newline is not empty on the wire, so the length check inside
// runSSH lets it through, and the caller would set CLAUDE_CODE_OAUTH_TOKEN to
// the empty string — a workspace that looks signed in and fails every call.
func TestTokenRefusesAReplyThatHoldsOnlyATerminator(t *testing.T) {
	stateDir := seedBrokerWiring(t)
	fakeSSH(t, "printf '\\n'\n")

	if _, err := Token(context.Background(), stateDir, "claude"); err == nil {
		t.Fatal("Token accepted a mint reply that carried no token")
	}
}

// seedBrokerWiring writes the state a mint needs to reach the ssh binary: a
// broker to dial and a key to dial it with.
func seedBrokerWiring(t *testing.T) string {
	t.Helper()
	stateDir := t.TempDir()
	writeFile(t, filepath.Join(stateDir, BrokerFile), `{"host":"broker.example","port":22,"member":"m-0123456789ab"}`)
	writeFile(t, filepath.Join(stateDir, KnownHostsFile), "broker.example ssh-ed25519 AAAA\n")
	writeFile(t, filepath.Join(stateDir, MintKeyFile), "private")
	return stateDir
}

// fakeSSH puts a script named `ssh` first on PATH. runSSH resolves the binary
// by name, so this is the seam that lets a test drive the real reply-parsing
// path instead of a re-implementation of it.
func fakeSSH(t *testing.T, body string) {
	t.Helper()
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// liveModelProviderLines returns every model_provider assignment codex would
// parse as a real key, comments excluded.
func liveModelProviderLines(config string) []string {
	var live []string
	for _, line := range strings.Split(config, "\n") {
		if isModelProviderAssignment(strings.TrimLeft(line, " \t")) {
			live = append(live, line)
		}
	}
	return live
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
