// Package filelock serialises a critical section across processes.
//
// It exists because an in-process mutex is the wrong tool for a box: every
// user of the control-plane credential is a separate short-lived process —
// `blitz-cred api-token`, the boot-time register, the feed watcher — and a
// sync.Mutex in one of them says nothing to the others.
package filelock

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// ErrBusy is reported when the holder outlived the caller's patience. It is a
// retryable refusal, never a critical section that ran anyway.
var ErrBusy = errors.New("another process holds the lock")

// With runs fn while holding an exclusive flock on path, creating the lock
// file if it is absent.
//
// flock(2) locks attach to the open file description, so two opens contend
// whether they come from two processes or two goroutines. The lock is held
// across the WHOLE of fn, which for a token rotation means read, refresh and
// write — the window that matters is the rotation, not the moment of storing.
func With(ctx context.Context, path string, wait time.Duration, fn func() error) error {
	lock, created, err := open(path)
	if err != nil {
		return err
	}
	defer lock.Close()
	if created && os.Geteuid() == 0 {
		if err := chownToDirectoryOwner(lock, path); err != nil {
			return errors.Join(err, removeCreatedLock(lock, path))
		}
	}
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
			return fn()
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return ErrBusy
		case <-ticker.C:
		}
	}
}

func removeCreatedLock(lock *os.File, path string) error {
	created, err := lock.Stat()
	if err != nil {
		return err
	}
	current, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(created, current) {
		return errors.New("created lock path was replaced before cleanup")
	}
	return os.Remove(path)
}

func open(path string) (*os.File, bool, error) {
	for {
		lock, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0o600)
		if err == nil {
			return lock, true, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, false, err
		}
		lock, err = os.OpenFile(path, os.O_RDWR, 0o600)
		if err == nil {
			return lock, false, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, false, err
		}
	}
}

func chownToDirectoryOwner(lock *os.File, path string) error {
	directory, err := os.Stat(filepath.Dir(path))
	if err != nil {
		return fmt.Errorf("stat lock directory: %w", err)
	}
	// SAFETY: os.Stat returns the platform's syscall.Stat_t on supported Unix
	// systems. Refuse to retain the created lock if that invariant fails.
	stat, ok := directory.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("read lock directory ownership: unexpected stat type %T", directory.Sys())
	}
	if err := lock.Chown(int(stat.Uid), int(stat.Gid)); err != nil {
		return fmt.Errorf("chown created lock: %w", err)
	}
	return nil
}
