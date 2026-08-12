package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

type Depositor func(context.Context, string, []byte) error

type Watcher struct {
	Home      string
	Deposit   Depositor
	deposited map[string][sha256.Size]byte
}

func NewWatcher(home string, deposit Depositor) *Watcher {
	return &Watcher{Home: home, Deposit: deposit, deposited: make(map[string][sha256.Size]byte)}
}

func (watcher *Watcher) Tick(ctx context.Context) error {
	var failures []error
	for _, definition := range []vendor.Definition{vendor.Claude, vendor.Codex} {
		blob, err := readWatchedFile(filepath.Join(watcher.Home, filepath.FromSlash(definition.CredentialPath)))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		digest := sha256.Sum256(blob)
		if previous, ok := watcher.deposited[definition.Name]; ok && previous == digest {
			continue
		}
		if err := watcher.Deposit(ctx, definition.Name, blob); err != nil {
			failures = append(failures, err)
			continue
		}
		// Record the bytes sent, not a post-ACK reread. A concurrent login is sent next tick.
		watcher.deposited[definition.Name] = digest
	}
	return errors.Join(failures...)
}

func Watch(ctx context.Context, stateDir, home string) error {
	watcher := NewWatcher(home, func(callContext context.Context, harness string, blob []byte) error {
		return Deposit(callContext, stateDir, harness, blob)
	})
	for {
		_ = watcher.Tick(ctx)
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func readWatchedFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, credentialMaxSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > credentialMaxSize {
		return nil, errors.New("vendor credential exceeds 1 MiB")
	}
	return data, nil
}
