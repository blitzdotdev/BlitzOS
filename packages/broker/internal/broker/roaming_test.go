package broker

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

const liveClaudeCredential = `{"claudeAiOauth":{"accessToken":"live","refreshToken":"refresh","expiresAt":4102444800000}}`

// TestLockWaitOutlastsTheVendorTrigger is the runtime half of the invariant
// lock.go proves at compile time. Both halves are cheap and neither subsumes
// the other: the constant assertion cannot survive someone turning LockWait
// into a var, and this cannot survive being deleted.
//
// If a waiter gave up sooner than the holder's own deadline it would report
// busy for a refresh that was about to succeed, and its retry would find the
// same lock still held — a member with an expired token would then never mint.
func TestLockWaitOutlastsTheVendorTrigger(t *testing.T) {
	if LockWait <= vendor.TriggerTimeout {
		t.Fatalf("LockWait %s must exceed vendor.TriggerTimeout %s", LockWait, vendor.TriggerTimeout)
	}
}

// TestMemberLockRefusesAConcurrentOperationAsBusy proves the second caller is
// told it is busy rather than being let through to touch the same credential,
// and that it is told in a form callers can retry on.
func TestMemberLockRefusesAConcurrentOperationAsBusy(t *testing.T) {
	home := t.TempDir()
	previous := lockWait
	lockWait = 50 * time.Millisecond
	defer func() { lockWait = previous }()

	held := make(chan struct{})
	release := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		_ = withMemberLock(context.Background(), home, func() error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held

	err := withMemberLock(context.Background(), home, func() error {
		t.Error("the second operation entered the critical section")
		return nil
	})
	close(release)
	wait.Wait()

	if err == nil {
		t.Fatal("a contended lock reported success")
	}
	if !strings.Contains(err.Error(), "lock") {
		t.Fatalf("busy error = %v, want it to name the lock", err)
	}
}

// TestMintKilledMidRefreshLeavesTheStoredCredentialIntact is the 2026-08-07
// incident, as a test. A vendor CLI that is rewriting the only copy of a
// credential when its deadline lands gets killed mid-write; what must NOT
// happen is that the member is left holding a blank file.
//
// The fake vendor sleeps past the caller's deadline, so exec kills it exactly
// where the incident killed the real one.
func TestMintKilledMidRefreshLeavesTheStoredCredentialIntact(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// Expired, so Mint runs the refresh path rather than serving the file.
	expired := []byte(`{"claudeAiOauth":{"accessToken":"expired","refreshToken":"refresh","expiresAt":1}}`)
	if err := os.WriteFile(path, expired, 0o600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	slept := make(chan struct{})
	_, err := Mint(ctx, home, []string{"claude"}, "claude", vendor.Claude,
		func(runContext context.Context, _ string, _ []string, _ string) error {
			close(slept)
			<-runContext.Done()
			return runContext.Err()
		})
	<-slept
	if err == nil {
		t.Fatal("Mint returned a token after its vendor run was killed")
	}

	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("the stored credential is gone: %v", readErr)
	}
	if string(got) != string(expired) {
		t.Fatalf("stored credential changed after a killed refresh: %q", got)
	}
}

// TestDepositRefusesACredentialWhoseRefreshTokenIsAlreadyDead closes the gap
// verification cannot: a live access token proves nothing about the refresh
// chain behind it, and storing a dead one replaces a working credential with
// one that fails days later, on the only copy.
func TestDepositRefusesACredentialWhoseRefreshTokenIsAlreadyDead(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(liveClaudeCredential), 0o600); err != nil {
		t.Fatal(err)
	}

	dead := `{"claudeAiOauth":{"accessToken":"new","refreshToken":"spent","expiresAt":4102444800000,"refreshTokenExpiresAt":1}}`
	ran := false
	err := Deposit(context.Background(), home, vendor.Claude, strings.NewReader(dead),
		func(context.Context, string, []string, string) error {
			ran = true
			return nil
		})
	if err == nil {
		t.Fatal("Deposit stored a credential whose refresh token had already expired")
	}
	if ran {
		t.Error("the vendor CLI was run for a credential that was refused on its face")
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != liveClaudeCredential {
		t.Fatalf("stored credential changed after a refused deposit: %q", got)
	}
}

// TestDepositRecordsAFingerprintTrail proves a credential swap is visible
// after the fact — including a swap to a different account — and that nothing
// from the credential itself reaches the record.
func TestDepositRecordsAFingerprintTrail(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(liveClaudeCredential), 0o600); err != nil {
		t.Fatal(err)
	}

	replacement := `{"claudeAiOauth":{"accessToken":"other-account","refreshToken":"other","expiresAt":4102444800000}}`
	if err := Deposit(context.Background(), home, vendor.Claude, strings.NewReader(replacement),
		func(context.Context, string, []string, string) error { return nil }); err != nil {
		t.Fatal(err)
	}

	record, err := os.ReadFile(filepath.Join(home, eventsFile))
	if err != nil {
		t.Fatal(err)
	}
	line := string(record)
	if !strings.Contains(line, "deposit harness=claude") {
		t.Fatalf("event line = %q", line)
	}
	if strings.Contains(line, "other-account") || strings.Contains(line, "other") {
		t.Fatalf("the event record leaked credential material: %q", line)
	}
	if strings.Contains(line, "previous=none") {
		t.Fatalf("event line lost the replaced credential's fingerprint: %q", line)
	}
}

// TestUnixNameGateRefusesEveryNameOutsideTheDerivedShape covers the CREATE
// half. The name reaches useradd argv and becomes a path, so anything the
// control plane did not derive must not get through — the shared `blitz`
// login most of all, because it would put every member's only credential copy
// in one home.
func TestUnixNameGateRefusesEveryNameOutsideTheDerivedShape(t *testing.T) {
	for _, name := range []string{
		"m-0123456789ab",
		"m-ffffffffffff",
	} {
		if !feed.ValidUnixName(name) {
			t.Errorf("derived name %q was refused", name)
		}
	}
	for _, name := range []string{
		"blitz", "root", "operator", "alice",
		"m-0123456789a", "m-0123456789abc", "m-0123456789ag",
		"M-0123456789AB", "../root", "m-", "", "m-0123456789ab ",
	} {
		if feed.ValidUnixName(name) {
			t.Errorf("name %q got past the gate", name)
		}
	}
}

// TestReconcileNeverDeletesAHomeItDidNotCreate covers the DELETE half — the
// half that runs as root and removes directories. The sweep is gated on the
// SAME pattern as creation, so an account the broker never made can never be
// swept, whatever the feed says.
func TestReconcileNeverDeletesAHomeItDidNotCreate(t *testing.T) {
	stateDir := t.TempDir()
	members := filepath.Join(stateDir, "members")
	if err := os.MkdirAll(members, 0o755); err != nil {
		t.Fatal(err)
	}
	unmanaged := []string{"blitz", "root", "operator"}
	stale := "m-dddddddddddd"
	for _, name := range append(append([]string{}, unmanaged...), stale) {
		if err := os.MkdirAll(filepath.Join(members, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	accounts := &recordingAccounts{}
	reconciler := Reconciler{
		StateDir:          stateDir,
		AuthorizedKeysDir: filepath.Join(t.TempDir(), "authorized_keys"),
		Accounts:          accounts,
	}
	// An empty feed: every existing home is now unwanted.
	if err := reconciler.Reconcile(Feed{Version: "v", Preserve: map[string]bool{}}); err != nil {
		t.Fatal(err)
	}

	if len(accounts.deprovisioned) != 1 || accounts.deprovisioned[0] != stale {
		t.Fatalf("deprovisioned = %#v, want only %q", accounts.deprovisioned, stale)
	}
	for _, name := range unmanaged {
		if _, err := os.Stat(filepath.Join(members, name)); err != nil {
			t.Errorf("unmanaged home %q was swept: %v", name, err)
		}
	}
}

type recordingAccounts struct {
	deprovisioned []string
}

func (accounts *recordingAccounts) Ensure(string, string) error { return nil }

func (accounts *recordingAccounts) Deprovision(name, home string) error {
	accounts.deprovisioned = append(accounts.deprovisioned, name)
	return os.RemoveAll(home)
}

// TestVendorRunsWithTheAutoUpdaterDisabled: a self-updating vendor CLI is what
// un-pins the image, and this process is the one that rewrites the only copy
// of a credential. A version that moves the file format under a refresh does
// not fail cleanly.
func TestVendorRunsWithTheAutoUpdaterDisabled(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"claudeAiOauth":{"accessToken":"expired","refreshToken":"r","expiresAt":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	seen := filepath.Join(t.TempDir(), "env")
	bin := t.TempDir()
	script := "#!/bin/sh\nset -eu\n" +
		"printf '%s\\n' \"${DISABLE_AUTOUPDATER-unset}\" > " + strconv.Quote(seen) + "\n" +
		"printf '%s\\n' '" + liveClaudeCredential + "' > \"$HOME/.claude/.credentials.json\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("DISABLE_AUTOUPDATER", "0")

	if _, err := Mint(context.Background(), home, []string{"claude"}, "claude", vendor.Claude, nil); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(seen)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(got)) != "1" {
		t.Fatalf("DISABLE_AUTOUPDATER seen by the vendor CLI = %q, want 1", got)
	}
}
