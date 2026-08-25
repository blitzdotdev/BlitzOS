package workspace

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
)

const sshTimeout = 60 * time.Second

func Token(ctx context.Context, stateDir, harness string) ([]byte, error) {
	if !feed.ValidHarness(harness) {
		return nil, errors.New("invalid token request")
	}
	output, err := runSSH(ctx, stateDir, "mint", harness, nil)
	if err != nil {
		return nil, err
	}
	token := trimMintedToken(output)
	if len(token) == 0 {
		return nil, errors.New("broker minted an empty access token")
	}
	return token, nil
}

func HarnessStatus(ctx context.Context, stateDir, harness string) (bool, error) {
	if !feed.ValidHarness(harness) {
		return false, errors.New("invalid status request")
	}
	output, err := runSSH(ctx, stateDir, "mint", "status "+harness, nil)
	if err != nil {
		return false, err
	}
	switch string(output) {
	case "signed-in\n":
		return true, nil
	case "signed-out\n":
		return false, nil
	default:
		return false, errors.New("broker returned an invalid harness status")
	}
}

// trimMintedToken strips the mint reply's line terminator, and any other
// surrounding whitespace, off the bytes the broker wrote to stdout.
//
// The mint reply is line-oriented: `blitz-broker mint` ends the token with
// fmt.Fprintln (cmd/blitz-broker/main.go), so the newline is the terminator and
// is never part of the token. Everything downstream of this function copies
// these bytes VERBATIM into CLAUDE_CODE_OAUTH_TOKEN, and only one of those
// consumers strips anything by accident: the PATH shim substitutes the helper
// with $(...), which eats trailing newlines, while the actor sets the value
// straight into options.env. A token with a trailing newline reaches the vendor
// as an Authorization header value containing a newline — rejected, with an
// error that names nothing on this box.
//
// Trimming here rather than at each consumer is what makes that impossible to
// reintroduce: this is the single point every workspace-side caller of the mint
// verb goes through. Deposit's ACK is deliberately NOT trimmed — "ok\n" is an
// exact wire contract with the broker, not a payload.
func trimMintedToken(output []byte) []byte {
	return bytes.TrimSpace(output)
}

func Deposit(ctx context.Context, stateDir, harness string, blob []byte) error {
	if !feed.ValidHarness(harness) || len(blob) > credentialMaxSize {
		return errors.New("invalid deposit request")
	}
	output, err := runSSH(ctx, stateDir, "deposit", harness, bytes.NewReader(blob))
	if err != nil {
		return err
	}
	if string(output) != "ok\n" {
		return errors.New("broker returned an invalid deposit acknowledgement")
	}
	return nil
}

func runSSH(parent context.Context, stateDir, operation, remoteCommand string, input io.Reader) ([]byte, error) {
	broker, err := LoadBroker(stateDir)
	if err != nil {
		return nil, err
	}
	identity, err := keyPath(stateDir, operation)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parent, sshTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", sshArguments(stateDir, identity, broker, remoteCommand)...)
	cmd.Stdin = input
	var output cappedBuffer
	var diagnostic cappedBuffer
	cmd.Stdout = &output
	// The broker's stderr, kept. Without it every broker-side refusal —
	// "requested harness is not allowed", "the credential lock timed out",
	// "the incoming credential's refresh token has already expired" — arrived
	// here as the single word "failed", and the box had no way to tell a
	// member who must log in again from a box wired to the wrong harness.
	//
	// It is a DIAGNOSTIC channel, not a credential one: the token only ever
	// travels on stdout, so nothing minted can be routed here, and the buffer
	// is capped like stdout so a chatty remote cannot make this process
	// allocate without bound.
	cmd.Stderr = &diagnostic
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("broker SSH request timed out")
		}
		if reason := brokerReason(diagnostic); reason != "" {
			return nil, fmt.Errorf("broker SSH request failed: %s", reason)
		}
		return nil, errors.New("broker SSH request failed")
	}
	if output.exceeded {
		return nil, errors.New("broker SSH response is too large")
	}
	if len(output.Bytes()) == 0 {
		return nil, errors.New("broker SSH response is empty")
	}
	return output.Bytes(), nil
}

// brokerReason turns the remote's stderr into one short line fit for a log.
//
// The LAST non-empty line, because ssh writes its own connection chatter first
// and the broker's own message is what a reader needs. Bounded and stripped of
// control characters so a hostile remote cannot forge log lines or repaint a
// terminal through this path.
func brokerReason(diagnostic cappedBuffer) string {
	const maxReason = 200
	var reason string
	for _, line := range strings.Split(diagnostic.String(), "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			reason = trimmed
		}
	}
	reason = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, reason)
	if len(reason) > maxReason {
		reason = reason[:maxReason] + "…"
	}
	return reason
}

func sshArguments(stateDir, identity string, broker BrokerConfig, remoteCommand string) []string {
	return []string{
		"-T",
		"-i", identity,
		"-o", "IdentitiesOnly=yes",
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile=" + filepath.Join(stateDir, KnownHostsFile),
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "PasswordAuthentication=no",
		"-o", "ConnectTimeout=55",
		"-p", strconv.Itoa(broker.Port),
		broker.Member + "@" + broker.Host,
		remoteCommand,
	}
}

type cappedBuffer struct {
	bytes.Buffer
	exceeded bool
}

func (buffer *cappedBuffer) Write(data []byte) (int, error) {
	original := len(data)
	remaining := credentialMaxSize + 1 - buffer.Len()
	if remaining <= 0 {
		buffer.exceeded = true
		return original, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		buffer.exceeded = true
	}
	_, _ = buffer.Buffer.Write(data)
	return original, nil
}
