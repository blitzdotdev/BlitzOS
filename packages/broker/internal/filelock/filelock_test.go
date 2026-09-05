package filelock

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestWithLocksCriticalSectionAsCurrentUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.lock")
	holder, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	if err := With(context.Background(), path, 10*time.Millisecond, func() error {
		t.Fatal("contended critical section ran")
		return nil
	}); !errors.Is(err, ErrBusy) {
		t.Fatalf("contended lock error = %v, want ErrBusy", err)
	}
	if err := syscall.Flock(int(holder.Fd()), syscall.LOCK_UN); err != nil {
		t.Fatal(err)
	}

	called := false
	err = With(context.Background(), path, time.Second, func() error {
		called = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("critical section did not run")
	}
}

func TestWithCreatedLockUsesDirectoryOwnership(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root")
	}
	directory := t.TempDir()
	if err := os.Chown(directory, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "box-credential.lock")
	if err := With(context.Background(), path, time.Second, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// SAFETY: os.Stat returns syscall.Stat_t on every platform supported by the
	// broker's Unix-only file ownership contract.
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("unexpected stat type %T", info.Sys())
	}
	if got := [2]uint32{stat.Uid, stat.Gid}; got != [2]uint32{1000, 1000} {
		t.Fatalf("ownership = %v, want [1000 1000]", got)
	}
}
