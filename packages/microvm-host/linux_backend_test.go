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
