package vendor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// TriggerTimeout bounds one vendor CLI run — the path that makes the CLI go
// and FETCH a new token. That is a real network round trip.
//
// The danger of a tight bound here is NOT a slow mint. exec.CommandContext
// KILLS the child, so a deadline that lands mid-refresh kills the vendor CLI
// while it is rewriting the ONLY copy of the credential. That is exactly how
// the 2026-08-07 production incident left `accessToken: ""` and
// `refreshToken: ""` on disk, on a box with no backup by design. The measured
// cost of these commands on that host was 6.4 s (claude) and 4.8 s (codex);
// 60 s is ~9x that and still bounds a CLI that hangs forever.
//
// Every caller passes this, and Run applies it itself, so no caller can
// accidentally hand the vendor a shorter deadline.
const TriggerTimeout = 60 * time.Second

type Runner func(context.Context, string, []string, string) error

type Definition struct {
	Name           string
	Command        string
	CredentialPath string
	RefreshArgs    []string
	VerifyArgs     []string
	ReadToken      func([]byte) (string, time.Time, error)

	// ReadRefreshExpiry reports when the REFRESH token dies, for the harnesses
	// that publish one. Nil, or a zero time, means the harness publishes none
	// and the caller must not infer anything from that.
	//
	// It exists because verifying a deposit proves the ACCESS token works now
	// and says nothing about the refresh chain behind it. A blob whose access
	// token is live but whose refresh token is already dead would pass
	// verification and then die at the first refresh — up to ten days later,
	// on the only copy. Where a harness announces the deadline, Deposit reads
	// it and refuses; where it does not, that residual stands.
	ReadRefreshExpiry func([]byte) (time.Time, error)
}

func Lookup(name string) (Definition, error) {
	switch name {
	case Claude.Name:
		return Claude, nil
	case Codex.Name:
		return Codex, nil
	default:
		return Definition{}, fmt.Errorf("unsupported harness %q", name)
	}
}

// Run executes one vendor CLI invocation. Notes on what is deliberate:
//
//   - exec.CommandContext, not a shell: no word splitting, no interpolation,
//     and argv comes from the compile-time Definition table only.
//   - stdin is nil, so the child reads /dev/null and can never be handed the
//     caller's stdin — the deposited blob included.
//   - HOME is the only thing that decides which credential the CLI touches,
//     which is how Deposit stages a blob without going near the stored one.
//   - stderr is DISCARDED. A vendor CLI is free to print a token in a
//     diagnostic, and forwarding that would put a secret in a log line.
//   - the deadline is TriggerTimeout, applied HERE. See the constant.
func Run(ctx context.Context, command string, args []string, home string) error {
	ctx, cancel := context.WithTimeout(ctx, TriggerTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = homeEnvironment(home)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errors.New("vendor CLI timed out")
		}
		return errors.New("vendor CLI rejected the credential")
	}
	return nil
}

func homeEnvironment(home string) []string {
	environment := make([]string, 0, len(os.Environ())+2)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "HOME=") && !strings.HasPrefix(item, "CODEX_HOME=") &&
			!strings.HasPrefix(item, "CLAUDE_CONFIG_DIR=") && !strings.HasPrefix(item, "DISABLE_AUTOUPDATER=") {
			environment = append(environment, item)
		}
	}
	// A self-updating vendor CLI silently un-pins the image. It matters more
	// here than anywhere else on the box: THIS process is what refreshes an
	// expired credential, and that refresh rewrites the only copy. A version
	// that moves the credential format or the CLI flags under a refresh does
	// not fail cleanly — it can blank the one credential the member has.
	return append(environment, "HOME="+home, "DISABLE_AUTOUPDATER=1")
}
