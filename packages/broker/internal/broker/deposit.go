package broker

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

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
		if err := runner(ctx, definition.Command, definition.VerifyArgs, stage); err != nil {
			return err
		}
		verified, err := readCredential(stagedPath)
		if err != nil {
			return errors.New("vendor verification removed the credential")
		}
		_, expiry, err := definition.ReadToken(verified)
		if err != nil || !expiry.After(time.Now()) {
			return errors.New("vendor verification did not produce a valid credential")
		}
		target := filepath.Join(home, filepath.FromSlash(definition.CredentialPath))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.Chmod(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		return atomicfile.Write(target, verified, 0o600)
	})
}
