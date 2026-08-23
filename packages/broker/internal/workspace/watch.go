package workspace

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

type Watcher struct {
	Home      string
	StateDir  string
	deposited map[string][sha256.Size]byte
}

func NewWatcher(home, stateDir string) *Watcher {
	return &Watcher{Home: home, StateDir: stateDir, deposited: make(map[string][sha256.Size]byte)}
}

// Tick deposits any credential that changed since the last pass and then
// DELETES the workspace's copy.
//
// The delete is the point, not housekeeping. The broker is meant to hold the
// only copy of a member's refresh token: it is the only thing that refreshes,
// the only thing that can blank one, and the only place a second workspace can
// get one from. A workspace that kept its copy would be a second, unmanaged,
// never-refreshed replica of the credential on a disposable VM.
//
// The copy is removed only when the file still holds exactly the bytes that
// were ACKed. A login that lands DURING the deposit leaves different bytes on
// disk, and deleting those would destroy a credential the broker never
// received; the next tick deposits it instead.
func (watcher *Watcher) Tick(ctx context.Context) error {
	var failures []error
	// The credential paths come off the vendor Definition table, not a config
	// file: the broker's mint, the broker's deposit and this watcher then read
	// one field, and the list cannot go missing or drift out from under them.
	for _, definition := range vendor.Definitions {
		path := filepath.Join(watcher.Home, filepath.FromSlash(definition.CredentialPath))
		blob, err := readWatchedFile(path)
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
		if err := Deposit(ctx, watcher.StateDir, definition.Name, blob); err != nil {
			failures = append(failures, err)
			continue
		}
		// Record the bytes sent, not a post-ACK reread. A concurrent login is
		// sent next tick.
		watcher.deposited[definition.Name] = digest

		removed, err := removeIfUnchanged(path, digest)
		if err != nil {
			// The broker has it; this workspace also still has it. Say so
			// rather than re-depositing every second, which would tell the
			// broker nothing new and hammer it.
			failures = append(failures, fmt.Errorf("could not remove the workspace copy of the %s credential: %w", definition.Name, err))
			continue
		}
		if removed {
			// Forget the digest with the file. A later login that happens to
			// produce byte-identical content is still a login, and it must be
			// deposited rather than skipped as already-seen.
			delete(watcher.deposited, definition.Name)
		}
	}
	return errors.Join(failures...)
}

// removeIfUnchanged deletes path only if it still hashes to digest. Reporting
// false without an error means the file moved on under us and the caller must
// leave it alone.
func removeIfUnchanged(path string, digest [sha256.Size]byte) (bool, error) {
	current, err := readWatchedFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if sha256.Sum256(current) != digest {
		return false, nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return true, nil
}

func Watch(ctx context.Context, stateDir, home string) error {
	watcher := NewWatcher(home, stateDir)
	environmentReady := false
	for {
		if !environmentReady {
			// The startup script it may launch runs detached, so this call
			// never holds up the credential deposits below.
			ready, _ := environmentTick(ctx, stateDir, "/workspace")
			environmentReady = ready
		}
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
