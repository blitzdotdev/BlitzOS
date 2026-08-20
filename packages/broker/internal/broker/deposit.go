package broker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

// Deposit stages an incoming credential, verifies it under a staging HOME,
// stores the result, and only then lets the caller ACK.
//
// EVERY failure path returns before the stored credential is touched. That is
// the property the whole verb is built around: the workspace deletes its own
// copy on ACK, so a deposit that half-succeeded would destroy the credential
// from both ends at once.
//
// Cross-account replacement is allowed and is NOT recorded. Deposit is verify,
// store, ACK, and nothing else (packages/broker/TODO.md, founder 2026-08-11).
// The log used to be the last write on the success path, which put an
// unbounded append between a stored credential and the ACK the workspace waits
// for: a full disk or a bad mode turned a deposit that had already succeeded
// into a failure, the watcher kept its copy, and it re-deposited every second
// — a real vendor round trip per tick, forever.
func Deposit(ctx context.Context, home string, definition vendor.Definition, input io.Reader, runner vendor.Runner) error {
	blob, err := io.ReadAll(io.LimitReader(input, FeedMaxBytes+1))
	if err != nil {
		return errors.New("could not read deposited credential")
	}
	if len(blob) > FeedMaxBytes {
		return errors.New("deposited credential exceeds 1 MiB")
	}
	if runner == nil {
		runner = vendor.Run
	}
	return withMemberLock(ctx, home, func() error {
		stage, err := os.MkdirTemp(home, ".deposit-*")
		if err != nil {
			return err
		}
		defer os.RemoveAll(stage)
		stagedPath := filepath.Join(stage, filepath.FromSlash(definition.CredentialPath))
		if err := os.MkdirAll(filepath.Dir(stagedPath), 0o700); err != nil {
			return err
		}
		if err := atomicfile.Write(stagedPath, blob, 0o600); err != nil {
			return err
		}

		// Refuse a blob that announces its own death before spending a vendor
		// round trip on it. Verification proves the ACCESS token works right
		// now and says nothing about the refresh chain behind it, so a
		// credential with a live access token and a dead refresh token would
		// verify, replace the working one, and fail at the next refresh — days
		// later, with no copy left anywhere.
		if definition.ReadRefreshExpiry != nil {
			refreshExpiry, err := definition.ReadRefreshExpiry(blob)
			if err != nil {
				return fmt.Errorf("the incoming credential is unusable; stored credential unchanged: %w", err)
			}
			if !refreshExpiry.IsZero() && !refreshExpiry.After(time.Now()) {
				return errors.New("the incoming credential's refresh token has already expired; stored credential unchanged")
			}
		}

		// HOME points at the staging tree, so the vendor CLI rotates the
		// STAGED copy and never reaches the stored one. A failure here returns
		// before any write to the stored path.
		if err := runner(ctx, definition.Command, definition.VerifyArgs, stage); err != nil {
			return fmt.Errorf("verification failed; stored credential unchanged: %w", err)
		}
		verified, err := readCredential(stagedPath)
		if err != nil {
			return errors.New("verification left no usable credential; stored credential unchanged")
		}
		if len(verified) == 0 {
			return errors.New("verification blanked the credential; stored credential unchanged")
		}
		// Read it back the way Mint will. A blob that verified but that Mint
		// cannot parse would fail closed on every later mint; refuse it now,
		// while the working credential is still on disk.
		_, expiry, err := definition.ReadToken(verified)
		if err != nil || !expiry.After(time.Now()) {
			return errors.New("verification did not produce a valid credential; stored credential unchanged")
		}

		target := filepath.Join(home, filepath.FromSlash(definition.CredentialPath))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.Chmod(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		// The last write on the success path, so the ACK the caller sends next
		// means exactly "the stored credential is the one you handed me".
		return atomicfile.Write(target, verified, 0o600)
	})
}
