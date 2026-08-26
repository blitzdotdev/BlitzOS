package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// A commit is attributed by its author email, not by the credential that
// pushed it. Nothing in the box used to set a git identity at all, so agent
// commits carried git's fallback and linked to nobody — even when the token
// was a member's own GitHub App user token.
//
// The identity is derived from the token in hand rather than delivered
// alongside it. Exactly one live grant exists per person per provider, so a
// member who reconnects as a different GitHub account would leave any stored
// copy pointing at the old one while the token is the new one; commits would
// then attribute to the wrong account, silently. Asking GitHub who this token
// belongs to cannot go stale, and it covers a pasted personal token as well as
// an OAuth grant without a second code path.
//
// This is attribution, not a security boundary: `git config --global` stays
// writable, so a member can still author as anyone locally.

const (
	githubUserURL      = "https://api.github.com/user"
	identityStateFile  = "git-identity.json"
	identityHTTPBudget = 10 * time.Second
)

// loginPattern is GitHub's own vocabulary for a login: alphanumerics and
// hyphens. It gates what reaches a git config value and an email local part,
// because both are written by exec and neither should carry whatever a
// compromised or misbehaving API returned.
var loginPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,39}$`)

type githubUser struct {
	Login string `json:"login"`
	ID    int64  `json:"id"`
}

// identityState records which token an identity was resolved from, so the
// GitHub call happens once per token rather than once per credential pull.
// `ghu_` tokens rotate roughly every eight hours, which is how often this
// re-resolves, and is also the longest a switched account stays unnoticed.
type identityState struct {
	TokenHash string `json:"tokenHash"`
	Login     string `json:"login"`
	Email     string `json:"email"`
}

func tokenFingerprint(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ApplyGitIdentity points git at the GitHub account a token belongs to.
//
// It never returns an error to its caller's caller: a missing byline is a
// smaller harm than a failed clone or a refused credential, and a wrong byline
// is a larger one than either. Every failure path leaves whatever identity was
// already configured alone.
func ApplyGitIdentity(ctx context.Context, stateDir, connection, token string, httpClient *http.Client) {
	if connection != "github" || token == "" {
		return
	}
	fingerprint := tokenFingerprint(token)
	if current, err := readIdentityState(stateDir); err == nil && current.TokenHash == fingerprint {
		return
	}
	user, err := fetchGithubUser(ctx, token, httpClient)
	if err != nil {
		return
	}
	if !loginPattern.MatchString(user.Login) || user.ID <= 0 {
		return
	}
	// The noreply address is the one GitHub always links to an account. A
	// member's BlitzOS email is a Google address that is usually not verified
	// on their GitHub, so it would render as unlinked plain text — right name,
	// no account, and no way to tell from looking.
	email := fmt.Sprintf("%d+%s@users.noreply.github.com", user.ID, user.Login)
	if err := writeGitConfig(ctx, "user.name", user.Login); err != nil {
		return
	}
	if err := writeGitConfig(ctx, "user.email", email); err != nil {
		return
	}
	_ = writeIdentityState(stateDir, identityState{
		TokenHash: fingerprint,
		Login:     user.Login,
		Email:     email,
	})
}

func fetchGithubUser(ctx context.Context, token string, httpClient *http.Client) (githubUser, error) {
	client := httpClient
	if client == nil {
		client = &http.Client{Timeout: identityHTTPBudget}
	}
	ctx, cancel := context.WithTimeout(ctx, identityHTTPBudget)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, githubUserURL, nil)
	if err != nil {
		return githubUser{}, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "blitz-cred")
	response, err := client.Do(request)
	if err != nil {
		return githubUser{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return githubUser{}, fmt.Errorf("github user lookup returned %d", response.StatusCode)
	}
	// Bounded because this body is vendor input on a path that must not be a
	// way to exhaust the box's memory.
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return githubUser{}, err
	}
	var user githubUser
	if err := json.Unmarshal(body, &user); err != nil {
		return githubUser{}, err
	}
	return user, nil
}

func writeGitConfig(ctx context.Context, key, value string) error {
	if strings.HasPrefix(value, "-") {
		return errors.New("refusing a git config value that reads as a flag")
	}
	command := exec.CommandContext(ctx, "git", "config", "--global", key, value)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	return command.Run()
}

func identityStatePath(stateDir string) string {
	return filepath.Join(stateDir, identityStateFile)
}

func readIdentityState(stateDir string) (identityState, error) {
	raw, err := os.ReadFile(identityStatePath(stateDir))
	if err != nil {
		return identityState{}, err
	}
	var state identityState
	if err := json.Unmarshal(raw, &state); err != nil {
		return identityState{}, err
	}
	return state, nil
}

func writeIdentityState(stateDir string, state identityState) error {
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	// 0600: the fingerprint is a hash, not the token, but the file still names
	// which GitHub account this box is acting as.
	return os.WriteFile(identityStatePath(stateDir), raw, 0o600)
}
