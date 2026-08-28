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
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

func TestWatcherRedepositsLoginThatChangesDuringDeposit(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, filepath.FromSlash(vendor.Claude.CredentialPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old-login"), 0o600); err != nil {
		t.Fatal(err)
	}
	var deposits [][]byte
	watcher := NewWatcher(home, func(_ context.Context, harness string, blob []byte) error {
		if harness != "claude" {
			t.Fatalf("harness = %q", harness)
		}
		deposits = append(deposits, append([]byte(nil), blob...))
		if len(deposits) == 1 {
			if err := os.WriteFile(path, []byte("fresher-login"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return nil
	})
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(deposits) != 2 || string(deposits[0]) != "old-login" || string(deposits[1]) != "fresher-login" {
		t.Fatalf("deposits = %q", deposits)
	}
}

func TestSSHArgumentsPinOnlyTheRegisteredHostKey(t *testing.T) {
	args := sshArguments("/state", "/state/mint_key", BrokerConfig{Host: "broker.example", Port: 2222, Member: "m-0123456789ab"}, "claude")
	for _, required := range []string{
		"StrictHostKeyChecking=yes",
		"UserKnownHostsFile=/state/known_hosts",
		"GlobalKnownHostsFile=/dev/null",
		"IdentitiesOnly=yes",
		"ConnectTimeout=55",
	} {
		if !slices.Contains(args, required) {
			t.Errorf("SSH args missing %q: %#v", required, args)
		}
	}
	if args[len(args)-2] != "m-0123456789ab@broker.example" || args[len(args)-1] != "claude" {
		t.Fatalf("SSH target/command = %#v", args[len(args)-2:])
	}
}

func TestRegisterCreatesIdempotentKeysAndPinnedBrokerFiles(t *testing.T) {
	stateDir := t.TempDir()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/boxes/box/keys" || request.Method != http.MethodPost {
			http.NotFound(writer, request)
			return
		}
		calls++
		if request.Header.Get("Authorization") != "Bearer access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		var body struct {
			Keys []feed.Key `json:"keys"`
		}
		data, _ := io.ReadAll(request.Body)
		if err := json.Unmarshal(data, &body); err != nil {
			t.Error(err)
		}
		if len(body.Keys) != 2 || body.Keys[0].Op != "mint" || body.Keys[1].Op != "deposit" || !feed.ValidPublicKey(body.Keys[0].Pubkey) || !feed.ValidPublicKey(body.Keys[1].Pubkey) {
			t.Errorf("keys = %#v", body.Keys)
		}
		io.WriteString(writer, `{"memberUnixName":"m-0123456789ab","broker":{"host":"broker.example","port":2222,"sshHostPublicKey":"ssh-ed25519 AAAA"}}`)
	}))
	defer server.Close()
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}
	if err := Register(context.Background(), stateDir, server.Client()); err != nil {
		t.Fatal(err)
	}
	mintBefore, err := os.ReadFile(filepath.Join(stateDir, MintKeyFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := Register(context.Background(), stateDir, server.Client()); err != nil {
		t.Fatal(err)
	}
	mintAfter, err := os.ReadFile(filepath.Join(stateDir, MintKeyFile))
	if err != nil {
		t.Fatal(err)
	}
	if string(mintBefore) != string(mintAfter) || calls != 2 {
		t.Fatalf("registration was not idempotent: calls=%d", calls)
	}
	for _, name := range []string{MintKeyFile, MintKeyFile + ".pub", DepositKeyFile, DepositKeyFile + ".pub"} {
		info, err := os.Stat(filepath.Join(stateDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("%s mode = %o", name, info.Mode().Perm())
		}
	}
	knownHosts, err := os.ReadFile(filepath.Join(stateDir, KnownHostsFile))
	if err != nil {
		t.Fatal(err)
	}
	if string(knownHosts) != "[broker.example]:2222 ssh-ed25519 AAAA\n" {
		t.Fatalf("known_hosts = %q", knownHosts)
	}
	config, err := LoadBroker(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if config != (BrokerConfig{Host: "broker.example", Port: 2222, Member: "m-0123456789ab"}) {
		t.Fatalf("broker config = %#v", config)
	}
}

func TestLoadBrokerRejectsMissingMember(t *testing.T) {
	stateDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(stateDir, BrokerFile), []byte(`{"host":"broker.example","port":22}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadBroker(stateDir); err == nil {
		t.Fatal("broker config without member was accepted")
	}
}
