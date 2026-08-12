package broker

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

const refreshWindow = 5 * time.Minute

func Mint(ctx context.Context, home string, allowed []string, requested string, definition vendor.Definition, runner vendor.Runner) (string, error) {
	if !contains(allowed, requested) || requested != definition.Name {
		return "", errors.New("requested harness is not allowed")
	}
	if runner == nil {
		runner = vendor.Run
	}
	var token string
	err := withMemberLock(ctx, home, func() error {
		path := filepath.Join(home, filepath.FromSlash(definition.CredentialPath))
		data, err := readCredential(path)
		if err != nil {
			return errors.New("vendor credential is unavailable")
		}
		current, expiry, err := definition.ReadToken(data)
		if err != nil {
			return err
		}
		if !expiry.After(time.Now().Add(refreshWindow)) {
			if err := runner(ctx, definition.Command, definition.RefreshArgs, home); err != nil {
				return err
			}
			data, err = readCredential(path)
			if err != nil {
				return errors.New("refreshed vendor credential is unavailable")
			}
			current, expiry, err = definition.ReadToken(data)
			if err != nil {
				return err
			}
		}
		if !expiry.After(time.Now()) || current == "" {
			return errors.New("vendor CLI did not produce a valid access token")
		}
		token = current
		return nil
	})
	return token, err
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
