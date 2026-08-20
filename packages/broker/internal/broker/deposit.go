package broker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

// eventsFile records credential swaps, by fingerprint only.
const eventsFile = ".blitz-broker-events"

// Deposit stages an incoming credential, verifies it under a staging HOME,
// stores the result, and only then lets the caller ACK.
//
// EVERY failure path returns before the stored credential is touched. That is
// the property the whole verb is built around: the workspace deletes its own
// copy on ACK, so a deposit that half-succeeded would destroy the credential
// from both ends at once.
//
// Cross-account replacement is allowed — nothing here compares account
// identity — but it is recorded, so a swap is visible after the fact.
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
		previous, _ := readCredential(target)
		if err := atomicfile.Write(target, verified, 0o600); err != nil {
			return err
		}
		return recordDeposit(home, definition.Name, previous, verified)
	})
}

// recordDeposit appends one line to the member's own record so a credential
// swap — including a swap to a different account — is visible after the fact.
// The fingerprints are truncated SHA-256 digests, never the credential: a
// change shows up as a different fingerprint without any secret reaching the
// file.
func recordDeposit(home, harness string, previous, replacement []byte) error {
	line := fmt.Sprintf(
		"%s deposit harness=%s previous=%s replacement=%s\n",
		time.Now().UTC().Format(time.RFC3339),
		harness,
		fingerprint(previous),
		fingerprint(replacement),
	)
	file, err := os.OpenFile(filepath.Join(home, eventsFile), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(line)
	return err
}

func fingerprint(blob []byte) string {
	if len(blob) == 0 {
		return "none"
	}
	digest := sha256.Sum256(blob)
	return hex.EncodeToString(digest[:])[:12]
}
