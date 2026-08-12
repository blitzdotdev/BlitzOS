package broker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

const lockWait = 30 * time.Second

func withMemberLock(ctx context.Context, home string, fn func() error) error {
	lock, err := os.OpenFile(filepath.Join(home, ".blitz-credential.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	deadline := time.NewTimer(lockWait)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
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
			return errors.New("member credential lock timed out")
		case <-ticker.C:
		}
	}
}
