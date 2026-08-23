package broker

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

const refreshWindow = 5 * time.Minute

// Mint serves the member's access token for one harness, refreshing it through
// the vendor CLI when it is near expiry. Which harnesses the member may mint
// is decided by the forced command that calls this (cmd/blitz-broker), the
// only production entry point: it resolves the definition from the allowlist
// baked into authorized_keys before any credential is touched.
func Mint(ctx context.Context, home string, definition vendor.Definition) (string, error) {
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
			if err := vendor.Run(ctx, definition.Command, definition.RefreshArgs, home); err != nil {
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
		// A token is what the vendor CLI put in the credential file, and this
		// process does not get to clean it up: the mint reply is one line, so
		// whitespace inside the token is indistinguishable from the terminator
		// and every consumer would silently disagree about where the token ends.
		// The shim strips it, the actor does not, and the vendor rejects an
		// Authorization header carrying a newline. Refusing here fails the mint
		// loudly, at the one place that can still name the harness, instead of
		// handing out a token that half the box will corrupt.
		if current != strings.TrimSpace(current) {
			return errors.New("vendor CLI produced an access token carrying whitespace")
		}
		token = current
		return nil
	})
	return token, err
}
