package workspace

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strconv"
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
	stateDir := seedBrokerWiring(t)
	// The fake broker records each deposited blob off its stdin — the deposit
	// wire — asserts the forced command names the right harness, lands a
	// fresher login mid-first-deposit, and ACKs.
	record := t.TempDir()
	fakeSSH(t, `for last in "$@"; do :; done
[ "$last" = claude ] || { printf 'wrong harness %s\n' "$last" >&2; exit 9; }
n=$(cat `+strconv.Quote(filepath.Join(record, "count"))+` 2>/dev/null || printf 0)
n=$((n+1))
printf %s "$n" > `+strconv.Quote(filepath.Join(record, "count"))+`
cat > "`+record+`/deposit.$n"
if [ "$n" = 1 ]; then printf 'fresher-login' > `+strconv.Quote(path)+`; fi
printf 'ok\n'
`)

	watcher := NewWatcher(home, stateDir)
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := watcher.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	count, err := os.ReadFile(filepath.Join(record, "count"))
	if err != nil || string(count) != "2" {
		t.Fatalf("deposit count = %q, %v; want 2", count, err)
	}
	first, err := os.ReadFile(filepath.Join(record, "deposit.1"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(filepath.Join(record, "deposit.2"))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != "old-login" || string(second) != "fresher-login" {
		t.Fatalf("deposits = %q, %q", first, second)
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
	if err := Register(context.Background(), stateDir); err != nil {
		t.Fatal(err)
	}
	mintBefore, err := os.ReadFile(filepath.Join(stateDir, MintKeyFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := Register(context.Background(), stateDir); err != nil {
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

func TestApplyMintResultWritesQuotedEnvironmentAndFilePlacements(t *testing.T) {
	stateDir := t.TempDir()
	filePath := filepath.Join(t.TempDir(), "nested", "credential.json")
	mode := os.FileMode(0o640)
	result := MintResult{
		Integration: "example",
		Mode:        "inject",
		ExpiresAt:   2_000_000,
		Placements: []Placement{
			{Kind: "unset-env", Name: "OLD_TOKEN"},
			{Kind: "env", Name: "API_TOKEN", Value: "it's $HOME"},
			{Kind: "file", Path: filePath, Value: "file-secret", Mode: &mode},
		},
	}
	if err := applyMintResult(stateDir, result); err != nil {
		t.Fatal(err)
	}
	environmentPath := filepath.Join(stateDir, credentialsDirectory, environmentDirectory, "example.sh")
	environment, err := os.ReadFile(environmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(environment) != "export API_TOKEN='it'\"'\"'s $HOME'\nunset OLD_TOKEN\n" {
		t.Fatalf("environment file = %q", environment)
	}
	assertFileMode(t, environmentPath, 0o600)
	file, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(file) != "file-secret" {
		t.Fatalf("file placement = %q", file)
	}
	assertFileMode(t, filePath, mode)
}

func TestApplySyncReplacesEnvironmentDirectoryAndWritesMinimumExpiry(t *testing.T) {
	stateDir := t.TempDir()
	envDir := filepath.Join(stateDir, credentialsDirectory, environmentDirectory)
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(envDir, "stale.sh"), []byte("export STALE='yes'\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	results := []MintResult{
		{Integration: "one", Mode: "inject", ExpiresAt: 900_000, Placements: []Placement{{Kind: "env", Name: "ONE", Value: "1"}}},
		{Integration: "two", Mode: "proxy", ExpiresAt: 800_000, Placements: []Placement{{Kind: "unset-env", Name: "TWO"}}},
	}
	if err := applySync(stateDir, results, 123_456); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(envDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, []string{"one.sh", "two.sh"}) {
		t.Fatalf("env.d entries = %q", names)
	}
	statePath := filepath.Join(stateDir, credentialsDirectory, syncStateFile)
	state, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(state) != "{\"synced_at\":123456,\"expires_at\":800000}\n" {
		t.Fatalf("sync state = %q", state)
	}
	assertFileMode(t, statePath, 0o600)
}

func TestEmptySyncUsesZeroExpiry(t *testing.T) {
	stateDir := t.TempDir()
	if err := applySync(stateDir, []MintResult{}, 123_456); err != nil {
		t.Fatal(err)
	}
	state, err := os.ReadFile(filepath.Join(stateDir, credentialsDirectory, syncStateFile))
	if err != nil {
		t.Fatal(err)
	}
	if string(state) != "{\"synced_at\":123456,\"expires_at\":0}\n" {
		t.Fatalf("sync state = %q", state)
	}
}

func TestSyncMintsAllOnce(t *testing.T) {
	stateDir := t.TempDir()
	if err := store.SaveCredential(stateDir, store.Credential{BoxID: "box", AccessToken: "access", RefreshToken: "refresh"}); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "credential")
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		if request.Method != http.MethodPost || request.URL.Path != "/workspaces/self/credentials" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer access" {
			t.Errorf("Authorization = %q", request.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(request.Body)
		if string(body) != "{}" {
			t.Errorf("body = %q", body)
		}
		fmt.Fprintf(writer, `[{"integration":"example","mode":"inject","placements":[{"kind":"file","path":%q,"value":"secret"}],"expiresAt":2000000000000}]`, filePath)
	}))
	defer server.Close()
	if err := store.SaveOrigin(stateDir, server.URL); err != nil {
		t.Fatal(err)
	}
	if err := Sync(context.Background(), stateDir); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("mint-all calls = %d", calls)
	}
	file, err := os.ReadFile(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(file) != "secret" {
		t.Fatalf("file placement = %q", file)
	}
	assertFileMode(t, filePath, 0o600)
}

func assertFileMode(t *testing.T, path string, expected os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != expected {
		t.Errorf("%s mode = %o, want %o", path, info.Mode().Perm(), expected)
	}
}
