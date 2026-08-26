package workspace

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

// gitGlobal reads a value back out of the isolated HOME the test installed.
func gitGlobal(t *testing.T, key string) string {
	t.Helper()
	out, err := exec.Command("git", "config", "--global", "--get", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// isolateGit gives the test its own HOME so `git config --global` cannot touch
// the machine running it.
func isolateGit(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv("GIT_CONFIG_GLOBAL", home+"/.gitconfig")
}

func userServer(t *testing.T, body string, status int, calls *int) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls++
		if got := r.Header.Get("Authorization"); got != "Bearer ghu_member" {
			t.Errorf("authorization header = %q", got)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

// redirectClient points the fixed GitHub URL at the test server without
// letting the production constant become a variable for its own sake.
func redirectClient(server *httptest.Server) *http.Client {
	return &http.Client{Transport: rewriteTransport{target: server.URL}}
}

type rewriteTransport struct{ target string }

func (t rewriteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	replacement, err := http.NewRequestWithContext(
		request.Context(), request.Method, t.target, nil,
	)
	if err != nil {
		return nil, err
	}
	replacement.Header = request.Header
	return http.DefaultTransport.RoundTrip(replacement)
}

func TestApplyGitIdentitySetsTheAccountTheTokenBelongsTo(t *testing.T) {
	isolateGit(t)
	calls := 0
	server := userServer(t, `{"login":"octocat","id":583231}`, http.StatusOK, &calls)
	state := t.TempDir()

	ApplyGitIdentity(context.Background(), state, "github", "ghu_member", redirectClient(server))

	if got := gitGlobal(t, "user.name"); got != "octocat" {
		t.Fatalf("user.name = %q, want octocat", got)
	}
	// The noreply address is the only one GitHub links without a verified
	// email on the account.
	want := "583231+octocat@users.noreply.github.com"
	if got := gitGlobal(t, "user.email"); got != want {
		t.Fatalf("user.email = %q, want %q", got, want)
	}

	// Same token again: answered from state, so GitHub is asked once per token
	// rather than once per credential pull.
	ApplyGitIdentity(context.Background(), state, "github", "ghu_member", redirectClient(server))
	if calls != 1 {
		t.Fatalf("github called %d times, want 1", calls)
	}
}

func TestApplyGitIdentityLeavesTheIdentityAloneOnFailure(t *testing.T) {
	isolateGit(t)
	if err := exec.Command("git", "config", "--global", "user.name", "existing").Run(); err != nil {
		t.Fatalf("seeding git config: %v", err)
	}
	calls := 0
	server := userServer(t, `{"message":"Bad credentials"}`, http.StatusUnauthorized, &calls)

	ApplyGitIdentity(context.Background(), t.TempDir(), "github", "ghu_member", redirectClient(server))

	// A wrong byline is worse than a missing one, so a refused lookup must not
	// overwrite what is already there.
	if got := gitGlobal(t, "user.name"); got != "existing" {
		t.Fatalf("user.name = %q, want it untouched", got)
	}
}

func TestApplyGitIdentityIgnoresOtherProviders(t *testing.T) {
	isolateGit(t)
	calls := 0
	server := userServer(t, `{"login":"octocat","id":1}`, http.StatusOK, &calls)

	ApplyGitIdentity(context.Background(), t.TempDir(), "linear", "ghu_member", redirectClient(server))

	if calls != 0 {
		t.Fatalf("github called %d times for a non-github connection", calls)
	}
	if got := gitGlobal(t, "user.name"); got != "" {
		t.Fatalf("user.name = %q, want unset", got)
	}
}

func TestApplyGitIdentityRefusesAMalformedLogin(t *testing.T) {
	isolateGit(t)
	calls := 0
	// A login carrying a leading dash would reach `git config` as a flag, and
	// one carrying spaces would not be a GitHub login at all.
	server := userServer(t, `{"login":"--global","id":7}`, http.StatusOK, &calls)

	ApplyGitIdentity(context.Background(), t.TempDir(), "github", "ghu_member", redirectClient(server))

	if got := gitGlobal(t, "user.name"); got != "" {
		t.Fatalf("user.name = %q, want unset", got)
	}
}

func TestApplyGitIdentityReresolvesWhenTheTokenChanges(t *testing.T) {
	isolateGit(t)
	state := t.TempDir()
	firstCalls := 0
	first := userServer(t, `{"login":"octocat","id":1}`, http.StatusOK, &firstCalls)
	ApplyGitIdentity(context.Background(), state, "github", "ghu_member", redirectClient(first))

	// A member who reconnects as a different account gets a different token,
	// and the identity has to follow it rather than stay on the old account.
	secondCalls := 0
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondCalls++
		_, _ = w.Write([]byte(`{"login":"hubot","id":42}`))
	}))
	t.Cleanup(second.Close)
	ApplyGitIdentity(context.Background(), state, "github", "ghu_other", redirectClient(second))

	if got := gitGlobal(t, "user.name"); got != "hubot" {
		t.Fatalf("user.name = %q, want hubot", got)
	}
	if secondCalls != 1 {
		t.Fatalf("second token resolved %d times, want 1", secondCalls)
	}
}
