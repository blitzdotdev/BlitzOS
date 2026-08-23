package main

import (
	"strings"
	"testing"
)

// TestForcedCommandRefusesHarnessOutsideAllowlist pins the ONE gate on which
// harness a member may mint or deposit. The allowlist arrives on the
// authorized_keys forced-command line and the request in SSH_ORIGINAL_COMMAND;
// broker.Mint and broker.Deposit trust this gate, so a harness outside the
// list must be refused here, before any account lookup or vendor CLI run.
func TestForcedCommandRefusesHarnessOutsideAllowlist(t *testing.T) {
	t.Setenv("SSH_CONNECTION", "203.0.113.7 50000 203.0.113.1 22")
	t.Setenv("SSH_ORIGINAL_COMMAND", "codex")

	if _, _, err := forcedCommand([]string{"m-0123456789ab", "claude"}); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("harness outside the allowlist = %v, want a refusal", err)
	}
	// An empty allowlist ("-") admits nothing.
	if _, _, err := forcedCommand([]string{"m-0123456789ab", "-"}); err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("harness against the empty allowlist = %v, want a refusal", err)
	}
	// An allowed harness passes the gate and fails LATER, on the Unix user
	// identity — proof the allowlist is checked before any account state.
	t.Setenv("SSH_ORIGINAL_COMMAND", "claude")
	if _, _, err := forcedCommand([]string{"m-0123456789ab", "claude"}); err == nil || !strings.Contains(err.Error(), "user mismatch") {
		t.Fatalf("allowed harness = %v, want to reach the user identity check", err)
	}
}

func TestForcedCommandRequiresSSH(t *testing.T) {
	t.Setenv("SSH_CONNECTION", "")
	if _, _, err := forcedCommand([]string{"m-0123456789ab", "claude"}); err == nil {
		t.Fatal("forcedCommand ran outside a forced-command SSH session")
	}
}

func TestParseAllowlist(t *testing.T) {
	if allowed, err := parseAllowlist("-"); err != nil || len(allowed) != 0 {
		t.Fatalf(`parseAllowlist("-") = %v, %v`, allowed, err)
	}
	if allowed, err := parseAllowlist("claude,codex"); err != nil || len(allowed) != 2 {
		t.Fatalf(`parseAllowlist("claude,codex") = %v, %v`, allowed, err)
	}
	for _, invalid := range []string{"", "claude,claude", "bash", "claude,"} {
		if _, err := parseAllowlist(invalid); err == nil {
			t.Errorf("parseAllowlist(%q) accepted an invalid allowlist", invalid)
		}
	}
}
