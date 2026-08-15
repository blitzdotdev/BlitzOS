package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type runnerCall struct {
	name string
	args []string
}

type iptablesRunner struct {
	calls []runnerCall
	rules map[string]bool
}

func (r *iptablesRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, runnerCall{name: name, args: append([]string(nil), args...)})
	if len(args) < 5 || args[0] != "iptables" || args[1] != "-t" {
		return nil, errors.New("unexpected command")
	}

	key := strings.Join(append([]string{args[2]}, args[4:]...), "\x00")
	switch args[3] {
	case "-C":
		if !r.rules[key] {
			return nil, errors.New("rule does not exist")
		}
	case "-A":
		if r.rules[key] {
			return nil, errors.New("duplicate rule")
		}
		r.rules[key] = true
	case "-D":
		if !r.rules[key] {
			return nil, errors.New("rule does not exist")
		}
		delete(r.rules, key)
	default:
		return nil, errors.New("unexpected iptables operation")
	}
	return nil, nil
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
	runner := &iptablesRunner{rules: make(map[string]bool)}
	b := NewLinuxBackend(cfg)
	b.runner = runner
	vm := &VM{Slot: 1}
	rules := expectedRulesForSlotOne()

	if err := b.addRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if len(runner.rules) != len(rules) {
		t.Fatalf("first add installed %d rules; want %d", len(runner.rules), len(rules))
	}
	assertRuleCalls(t, runner.calls, cfg.SudoWrapper, rules, "-C", "-A")

	runner.calls = nil
	if err := b.addRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if len(runner.rules) != len(rules) {
		t.Fatalf("second add left %d rules; want %d", len(runner.rules), len(rules))
	}
	assertRuleCalls(t, runner.calls, cfg.SudoWrapper, rules, "-C")

	runner.calls = nil
	if err := b.removeRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if len(runner.rules) != 0 {
		t.Fatalf("first remove left %d rules; want 0", len(runner.rules))
	}
	assertRuleCalls(t, runner.calls, cfg.SudoWrapper, rules, "-C", "-D")

	runner.calls = nil
	if err := b.removeRules(context.Background(), vm); err != nil {
		t.Fatal(err)
	}
	if len(runner.rules) != 0 {
		t.Fatalf("second remove left %d rules; want 0", len(runner.rules))
	}
	assertRuleCalls(t, runner.calls, cfg.SudoWrapper, rules, "-C")
}

func assertRuleCalls(t *testing.T, got []runnerCall, wrapper string, rules []iptablesRule, operations ...string) {
	t.Helper()
	want := make([]runnerCall, 0, len(rules)*len(operations))
	for _, rule := range rules {
		for _, operation := range operations {
			args := append([]string{"iptables", "-t", rule.table, operation}, rule.args...)
			want = append(want, runnerCall{name: wrapper, args: args})
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runner calls = %#v; want %#v", got, want)
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
	write := strings.Index(script, "'nameserver 1.1.1.1' \\\n  'nameserver 8.8.8.8' \\\n  'options timeout:1 attempts:2' \\\n  > /mnt/root/etc/resolv.conf")
	enroll := strings.Index(script, "/usr/local/libexec/blitz-microvm-enroll.js")
	if remove < 0 || write < 0 || enroll < 0 {
		t.Fatalf("resolver replacement or enrollment command missing from guest init")
	}
	if remove >= write || write >= enroll {
		t.Fatalf("resolver replacement must occur before enrollment: remove=%d write=%d enroll=%d", remove, write, enroll)
	}
}

func TestMicroVMEnrollmentPokesRegisterAfterAtomicWrites(t *testing.T) {
	contents, err := os.ReadFile(filepath.Join("guest", "blitz-microvm-enroll.js"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(contents)
	credential := strings.Index(script, "atomicWrite(path.join(stateDir, 'box-credential.json')")
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
		"const registerTimeoutMs = 30000",
		"const registerKillGraceMs = 5000",
		"...process.env",
		"BLITZ_STATE_DIR: stateDir",
		"HOME: '/var/lib/blitz/home'",
		"USER: 'blitz'",
		"blitz-cred",
		"register",
		"timer = setTimeout(",
		"killGraceTimer = setTimeout(",
		"process.kill(-child.pid, 'SIGKILL')",
		"child.once('error'",
		"child.once('close'",
		"stdio: ['ignore', 'inherit', 'inherit']",
		"uid: 1000",
		"gid: 1000",
		"detached: true",
		"if (settled) return",
		"settled = true",
		"register timeout",
		"register failed",
		"register complete",
	} {
		if !strings.Contains(script, required) {
			t.Fatalf("guest enrollment is missing bounded/logged register behavior %q", required)
		}
	}
	for _, forbidden := range []string{
		"spawn('/usr/bin/env'",
		"child.kill('SIGKILL')",
		"child.unref()",
	} {
		if strings.Contains(script, forbidden) {
			t.Fatalf("guest enrollment contains unsafe register behavior %q", forbidden)
		}
	}
	timeout := strings.Index(script, "timer = setTimeout(")
	groupKill := strings.Index(script, "process.kill(-child.pid, 'SIGKILL')")
	killGrace := strings.Index(script, "killGraceTimer = setTimeout(")
	if timeout < 0 || groupKill <= timeout || killGrace <= groupKill {
		t.Fatalf("register timeout must kill the process group before starting bounded close grace: timeout=%d kill=%d grace=%d", timeout, groupKill, killGrace)
	}
	initContents, err := os.ReadFile(filepath.Join("guest", "microvm-init"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(initContents), ">/mnt/root/run/blitz/microvm-enroll.log 2>&1 &") {
		t.Fatal("guest init does not capture enrollment and register output")
	}
}
