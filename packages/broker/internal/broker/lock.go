package broker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

// LockWait bounds how long a mint or a deposit queues behind another operation
// on the same member.
//
// INVARIANT: LockWait MUST stay greater than vendor.TriggerTimeout. The
// holder's critical section is at most one vendor run plus two small file
// reads, and the longest vendor run is a refresh. A waiter that gave up sooner
// than the holder's own deadline would report "busy" for a refresh that was
// about to succeed, and its retry would arrive to find the same lock still
// held — a member with an expired token would then never mint. Raise
// vendor.TriggerTimeout and you MUST raise this with it; the slack below is
// for the file reads on either side of the vendor run, nothing more.
const LockWait = vendor.TriggerTimeout + 15*time.Second

// Compile-time proof of the invariant above. If LockWait ever stops exceeding
// vendor.TriggerTimeout this is a negative constant, the conversion overflows,
// and the package does not build. There is no runtime path to check on.
const _ uint64 = uint64(LockWait - vendor.TriggerTimeout)

// ErrLockBusy is reported to the caller as a clear, retryable busy exit —
// never as a silent success, and never as a credential operation that skipped
// the lock.
var ErrLockBusy = errors.New("another operation for this member holds the credential lock")

// lockWait is what the loop actually waits, so a test does not have to sit
// through a real 75 seconds to prove the busy path. The constant above is the
// contract; this is the knob.
var lockWait = LockWait

// withMemberLock serialises every operation that touches a member's credential
// directory. Two vendor CLI processes that both read an expired credential
// would POST the same single-use refresh token, and the loser would blank the
// file in place — on a box that holds the only copy.
//
// The lock is held across read, trigger AND re-read, not just the write. The
// window that matters is the whole refresh, not the moment of storing.
//
// flock(2) locks attach to the open file description, so two opens contend
// whether they come from two processes (sshd forks one per connection) or two
// goroutines.
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
			return ErrLockBusy
		case <-ticker.C:
		}
	}
}
