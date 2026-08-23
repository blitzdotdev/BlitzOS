package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// installFakeIptables writes a real executable at cfg.SudoWrapper — the exact
// path the backend execs — that emulates iptables -C/-A/-D statefulness in a
// rules directory and appends every argv line to a calls file. The backend
// then runs its true exec path end to end; nothing in it is substituted.
func installFakeIptables(t *testing.T, cfg Config) (callsFile, rulesDir string) {
	t.Helper()
	callsFile = filepath.Join(t.TempDir(), "calls")
	rulesDir = t.TempDir()
	script := "#!/bin/sh\nset -eu\n" +
		"printf '%s\\n' \"$*\" >> " + strconv.Quote(callsFile) + "\n" +
		"[ \"$1\" = iptables ] && [ \"$2\" = -t ] || exit 2\n" +
		"table=$3\nop=$4\nshift 4\n" +
		"key=$(printf '%s %s' \"$table\" \"$*\" | cksum | tr -dc 0-9)\n" +
		"case $op in\n" +
		"-C) [ -e \"" + rulesDir + "/$key\" ] || exit 1 ;;\n" +
		"-A) [ ! -e \"" + rulesDir + "/$key\" ] || exit 1\n    : > \"" + rulesDir + "/$key\" ;;\n" +
		"-D) rm \"" + rulesDir + "/$key\" ;;\n" +
		"*) exit 2 ;;\n" +
		"esac\n"
	if err := os.WriteFile(cfg.SudoWrapper, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return callsFile, rulesDir
}

func recordedCalls(t *testing.T, callsFile string) []string {
	t.Helper()
	data, err := os.ReadFile(callsFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

func installedRuleCount(t *testing.T, rulesDir string) int {
	t.Helper()
	entries, err := os.ReadDir(rulesDir)
	if err != nil {
		t.Fatal(err)
	}
	return len(entries)
}

func expectedRulesForSlotOne() []iptablesRule {
	const tag = "blitz-microvm:slot-1"
	return []iptablesRule{
		{"nat", []string{"PREROUTING", "-p", "tcp", "--dport", "22001", "-m", "comment", "--comment", tag, "-j", "DNAT", "--to-destination", "172.30.21.2:22"}},
		{"filter", []string{"FORWARD", "-p", "tcp", "-d", "172.30.21.2", "--dport", "22", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"filter", []string{"FORWARD", "-p", "tcp", "-s", "172.30.21.2", "--sport", "22", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"nat", []string{"POSTROUTING", "-s", "172.30.21.2", "-m", "comment", "--comment", tag, "-j", "MASQUERADE"}},
		{"filter", []string{"FORWARD", "-s", "172.30.21.2", "-m", "conntrack", "--ctstate", "NEW,ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
		{"filter", []string{"FORWARD", "-d", "172.30.21.2", "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", tag, "-j", "ACCEPT"}},
	}
}

func TestLinuxBackendRulesAreCompleteAndTagged(t *testing.T) {
	b := NewLinuxBackend(testConfig(t.TempDir()))
	got := b.rules(&VM{Slot: 1})
	want := expectedRulesForSlotOne()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rules() = %#v; want %#v", got, want)
	}
}

func TestLinuxBackendRuleLifecycleIsIdempotent(t *testing.T) {
	cfg := testConfig(t.TempDir())
	callsFile, rulesDir := installFakeIptables(t, cfg)
	b := NewLinuxBackend(cfg)
	vm := &VM{Slot: 1}
	rules := expectedRulesForSlotOne()
	resetCalls := func() {
		if err := os.Remove(callsFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}

	if err := b.addRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if got := installedRuleCount(t, rulesDir); got != len(rules) {
		t.Fatalf("first add installed %d rules; want %d", got, len(rules))
	}
	assertRuleCalls(t, recordedCalls(t, callsFile), rules, "-C", "-A")

	resetCalls()
	if err := b.addRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if got := installedRuleCount(t, rulesDir); got != len(rules) {
		t.Fatalf("second add left %d rules; want %d", got, len(rules))
	}
	assertRuleCalls(t, recordedCalls(t, callsFile), rules, "-C")

	resetCalls()
	if err := b.removeRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if got := installedRuleCount(t, rulesDir); got != 0 {
		t.Fatalf("first remove left %d rules; want 0", got)
	}
	assertRuleCalls(t, recordedCalls(t, callsFile), rules, "-C", "-D")

	resetCalls()
	if err := b.removeRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if got := installedRuleCount(t, rulesDir); got != 0 {
		t.Fatalf("second remove left %d rules; want 0", got)
	}
	assertRuleCalls(t, recordedCalls(t, callsFile), rules, "-C")
}

func assertRuleCalls(t *testing.T, got []string, rules []iptablesRule, operations ...string) {
	t.Helper()
	want := make([]string, 0, len(rules)*len(operations))
	for _, rule := range rules {
		for _, operation := range operations {
			args := append([]string{"iptables", "-t", rule.table, operation}, rule.args...)
			want = append(want, strings.Join(args, " "))
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("iptables calls = %#v; want %#v", got, want)
	}
}

// TestConcurrentManagerLifecycleOverTheRealBackendIsSerialized is the race
// proof behind LinuxBackend carrying no mutex of its own: Manager.mu is the
// single serializer for every lifecycle call into the backend. It drives
// Create/Delete/Reconcile/List/Capacity from several goroutines against the
// REAL LinuxBackend — boots fail fast on the missing mkfs/sudo binaries, which
// still walks the Boot-prefix, Stop, Cleanup and CleanupOrphans paths — so a
// hole in the manager's serialization shows up under -race as a torn vms map
// or VM field. Run with `go test -race`.
func TestConcurrentManagerLifecycleOverTheRealBackendIsSerialized(t *testing.T) {
	dir := t.TempDir()
	cfg := testConfig(dir)
	// A failing mkfs.ext4 first on PATH: identical fast Boot failures on every
	// platform, instead of depending on which host binaries happen to exist.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "mkfs.ext4"), []byte("#!/bin/sh\nexit 1\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	store := NewStateStore(cfg.StateDir)
	now := time.Now().UTC()
	for slot := 1; slot <= 2; slot++ {
		dead := &VM{VMID: "vm-" + strconv.Itoa(slot) + "-dead", Slot: slot, CPU: 1, MemMB: 256,
			Status: StatusRunning, CreatedAt: now}
		if err := store.Save(dead); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := NewManager(cfg, store, NewLinuxBackend(cfg))
	if err != nil {
		t.Fatal(err)
	}

	var wait sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			for round := 0; round < 3; round++ {
				name := "ws-" + strconv.Itoa(worker) + "-" + strconv.Itoa(round)
				if created, err := manager.Create(context.Background(), validRequest(name, 1, 128)); err == nil {
					_ = manager.Delete(context.Background(), created.VMID)
				}
				// Reconcile's errors are expected here (no /proc net state, no
				// sudo wrapper); the serialization, not the plumbing, is on trial.
				_ = manager.Reconcile(context.Background())
				_ = manager.List()
				_ = manager.Capacity()
			}
		}(worker)
	}
	wait.Wait()

	if vms := manager.List(); len(vms) != 0 {
		t.Fatalf("VMs survived failed boots and reconciles: %#v", vms)
	}
}

func TestAuthorizedKeySeedIsOptional(t *testing.T) {
	imageRoot := t.TempDir()
	if err := os.Mkdir(filepath.Join(imageRoot, "seed"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(imageRoot, "seed", "authorized_key")

	for _, key := range []*string{nil, stringPointer(""), stringPointer(" \t\n ")} {
		if err := writeAuthorizedKeySeed(imageRoot, key); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("keyless seed file stat error = %v; want os.ErrNotExist", err)
		}
	}

	key := stringPointer("  ssh-ed25519 AAAAtest caller  ")
	if err := writeAuthorizedKeySeed(imageRoot, key); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "ssh-ed25519 AAAAtest caller\n" {
		t.Fatalf("authorized key seed = %q", contents)
	}
}

func TestMicroVMInitCopiesAuthorizedKeyOnlyWhenPresent(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("guest", "microvm-init"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	if !strings.Contains(script, "if [ -s /mnt/rw/seed/authorized_key ]; then") ||
		!strings.Contains(script, "install -m 0644 /mnt/rw/seed/authorized_key /mnt/root/run/blitz/authorized_key") {
		t.Fatal("guest init does not conditionally copy the authorized key")
	}
	if strings.Contains(script, "missing vdb seed/authorized_key") {
		t.Fatal("guest init still requires the authorized key seed")
	}
}

func TestMicroVMInitWritesRegularResolvConfBeforeEnrollment(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("guest", "microvm-init"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	remove := strings.Index(script, "rm -f /mnt/root/etc/resolv.conf")
	write := strings.Index(script, "printf 'nameserver %s\\n' \"$nameserver\" >> /mnt/root/etc/resolv.conf")
	enroll := strings.Index(script, "/usr/local/libexec/blitz-microvm-enroll.js")
	if remove < 0 || write < 0 || enroll < 0 {
		t.Fatalf("resolver replacement or enrollment command missing from guest init")
	}
	if remove >= write || write >= enroll {
		t.Fatalf("resolver replacement must occur before enrollment: remove=%d write=%d enroll=%d", remove, write, enroll)
	}
	for _, required := range []string{"blitz_dns=*) guest_dns=", "[ -n \"$guest_dns\" ]", "IFS=,"} {
		if !strings.Contains(script, required) {
			t.Fatalf("guest init is missing configured DNS handling %q", required)
		}
	}
}

// TestMicroVMEnrollmentPokesRegisterAfterAtomicWrites pins the register poke
// contract: after the phone-home reply and the control-plane origin are on
// disk, enrollment awaits the image's own bounded register wrapper
// (/usr/local/libexec/blitz-register) — the SAME oneshot every other box runs
// — rather than rebuilding a private spawn/timeout/kill stack around
// blitz-cred. The wrapper owns the account drop, the state-dir environment and
// the timeout backstop; blitz-cred register carries its own 45 s deadline.
func TestMicroVMEnrollmentPokesRegisterAfterAtomicWrites(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("guest", "blitz-microvm-enroll.js"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	credential := strings.Index(script, "storePhoneHomeResponse(stored)")
	origin := strings.Index(script, "atomicWrite(path.join(stateDir, 'origin')")
	register := strings.Index(script, "await pokeRegister()")
	complete := strings.Index(script, "microvm-enroll: complete")
	if credential < 0 || origin < 0 || register < 0 || complete < 0 {
		t.Fatalf("credential/origin writes, awaited register poke, or completion log missing")
	}
	if credential >= origin || origin >= register || register >= complete {
		t.Fatalf("register poke must be awaited after both writes and before completion: credential=%d origin=%d register=%d complete=%d", credential, origin, register, complete)
	}
	for _, required := range []string{
		"'/usr/local/libexec/blitz-register'",
		"spawn(registerWrapper, [], {stdio: ['ignore', 'inherit', 'inherit']})",
		"child.once('error'",
		"child.once('close'",
		"if (settled) return",
		"settled = true",
		"register failed",
		"register complete",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("guest enrollment is missing register-poke behavior %q", required)
		}
	}
	for _, forbidden := range []string{
		// The wrapper is the one bounded runner; a rebuilt private stack around
		// blitz-cred is exactly what this test exists to keep out.
		"spawn('blitz-cred'",
		"registerTimeoutMs",
		"process.kill(-",
		"detached: true",
		"uid: 1000",
		"spawn('/usr/bin/env'",
		"child.kill('SIGKILL')",
		"child.unref()",
	} {
		if strings.Contains(script, forbidden) {
			t.Fatalf("guest enrollment contains register behavior the wrapper owns: %q", forbidden)
		}
	}
	initContents, err := os.ReadFile(filepath.Join("guest", "microvm-init"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(initContents), ">/mnt/root/run/blitz/microvm-enroll.log 2>&1 &") {
		t.Fatal("guest init does not capture enrollment and register output")
	}
}
