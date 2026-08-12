package broker

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

func TestDepositVerifyFailureLeavesCredentialUntouched(t *testing.T) {
	home := t.TempDir()
	definition := vendor.Claude
	path := filepath.Join(home, filepath.FromSlash(definition.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	old := []byte(`{"claudeAiOauth":{"accessToken":"old","refreshToken":"old-refresh","expiresAt":4102444800000}}`)
	if err := os.WriteFile(path, old, 0o600); err != nil {
		t.Fatal(err)
	}

	err := Deposit(context.Background(), home, definition, strings.NewReader(`{"claudeAiOauth":{"accessToken":"new"}}`), func(context.Context, string, []string, string) error {
		return errors.New("verification failed")
	})
	if err == nil {
		t.Fatal("Deposit succeeded after vendor verification failed")
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != string(old) {
		t.Fatalf("credential changed after failed verification: %q", got)
	}
}

func TestDecodeFeedRejectsPoisonedEntriesWithoutDroppingValidEntry(t *testing.T) {
	body := `{
  "version":"opaque",
  "members":[
    {"unixName":"alice","harnesses":["claude"],"keys":[]},
    {"unixName":"../root","harnesses":["claude"],"keys":[]},
    {"unixName":"bob","harnesses":["unknown"],"keys":[]}
  ]
}`
	feed, err := DecodeFeed(strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if len(feed.Members) != 1 || feed.Members[0].UnixName != "alice" {
		t.Fatalf("valid members = %#v, want only alice", feed.Members)
	}
	if feed.Rejected != 2 {
		t.Fatalf("rejected = %d, want 2", feed.Rejected)
	}
	if !feed.Preserve["bob"] {
		t.Fatal("existing bob state would be removed because of a poisoned harness")
	}
}

func TestDecodeFeedRequiresVersion(t *testing.T) {
	if _, err := DecodeFeed(strings.NewReader(`{"members":[]}`)); err == nil {
		t.Fatal("DecodeFeed accepted a feed without its required version")
	}
}

func TestMintRefusesHarnessOutsideMemberList(t *testing.T) {
	called := false
	_, err := Mint(context.Background(), t.TempDir(), []string{"claude"}, "codex", vendor.Codex, func(context.Context, string, []string, string) error {
		called = true
		return nil
	})
	if err == nil {
		t.Fatal("Mint accepted a harness outside the member allowlist")
	}
	if called {
		t.Fatal("vendor CLI ran before the harness gate")
	}
}

func TestAuthorizedKeysUsesRootOwnedPathAndModes(t *testing.T) {
	if AuthorizedKeysDir != "/etc/blitz-broker/authorized_keys" {
		t.Fatalf("AuthorizedKeysDir = %q", AuthorizedKeysDir)
	}
	root := t.TempDir()
	path, err := RenderAuthorizedKeys(root, Member{
		UnixName:  "alice",
		Harnesses: []string{"claude"},
		Keys:      []Key{{Pubkey: "ssh-ed25519 AAAAalice", Op: "mint"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(root, "alice") {
		t.Fatalf("path = %q", path)
	}
	dirInfo, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o755 {
		t.Fatalf("authorized_keys dir mode = %o", got)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fileInfo.Mode().Perm(); got != 0o644 {
		t.Fatalf("authorized_keys mode = %o", got)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "expiry") || strings.Contains(string(content), "expires") {
		t.Fatalf("authorized_keys contains expiry text: %q", content)
	}
	if !strings.HasPrefix(string(content), `restrict,command="/usr/local/bin/blitz-broker mint alice claude" `) {
		t.Fatalf("unexpected authorized_keys line: %q", content)
	}
}

func TestDepositCapsInput(t *testing.T) {
	blob := io.LimitReader(strings.NewReader(strings.Repeat("x", FeedMaxBytes+1)), FeedMaxBytes+1)
	err := Deposit(context.Background(), t.TempDir(), vendor.Claude, blob, func(context.Context, string, []string, string) error {
		return nil
	})
	if err == nil {
		t.Fatal("Deposit accepted a blob over 1 MiB")
	}
}

func TestConcurrentMintsRunOneVendorRefresh(t *testing.T) {
	home := t.TempDir()
	credentialPath := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(credentialPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(credentialPath, []byte(`{"claudeAiOauth":{"accessToken":"expired","refreshToken":"refresh","expiresAt":1}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	countPath := filepath.Join(t.TempDir(), "refresh-count")
	script := "#!/bin/sh\nset -eu\n" +
		"count=0\n" +
		"if [ -f " + strconv.Quote(countPath) + " ]; then count=$(sed -n '1p' " + strconv.Quote(countPath) + "); fi\n" +
		"count=$((count + 1))\n" +
		"printf '%s\\n' \"$count\" > " + strconv.Quote(countPath) + "\n" +
		"tmp=$HOME/.claude/.credentials.json.tmp\n" +
		"printf '%s\\n' '{\"claudeAiOauth\":{\"accessToken\":\"fresh\",\"refreshToken\":\"refresh\",\"expiresAt\":4102444800000}}' > \"$tmp\"\n" +
		"mv \"$tmp\" \"$HOME/.claude/.credentials.json\"\n"
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	const calls = 12
	var wait sync.WaitGroup
	errorsFound := make(chan error, calls)
	for range calls {
		wait.Add(1)
		go func() {
			defer wait.Done()
			token, err := Mint(context.Background(), home, []string{"claude"}, "claude", vendor.Claude, nil)
			if err == nil && token != "fresh" {
				err = errors.New("mint returned the wrong token")
			}
			errorsFound <- err
		}()
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	count, err := os.ReadFile(countPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(count) != "1\n" {
		t.Fatalf("vendor refresh count = %q, want 1", count)
	}
}
