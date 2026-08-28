// Package filelock serialises a critical section across processes.
//
// It exists because an in-process mutex is the wrong tool for a box: every
// user of the control-plane credential is a separate short-lived process —
// `blitz-cred get`, `blitz-cred git-helper`, the boot-time register — and a
// sync.Mutex in one of them says nothing to the others.
package filelock

import (
	"context"
	"errors"
	"os"
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
	lock, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
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
