package workspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
)

const sshTimeout = 60 * time.Second

func Token(ctx context.Context, stateDir, harness string) ([]byte, error) {
	if !feed.ValidHarness(harness) {
		return nil, errors.New("invalid token request")
	}
	return runSSH(ctx, stateDir, "mint", harness, nil)
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
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("broker SSH request timed out")
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
