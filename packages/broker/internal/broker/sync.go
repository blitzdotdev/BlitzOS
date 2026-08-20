package broker

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const pollInterval = time.Second

func Sync(ctx context.Context, stateDir string, httpClient *http.Client) error {
	if os.Geteuid() != 0 {
		return errors.New("sync must run as root")
	}
	reconciler := Reconciler{
		StateDir:          stateDir,
		AuthorizedKeysDir: AuthorizedKeysDir,
		Accounts:          SystemAccounts{},
	}
	etag := ""
	for {
		origin, originErr := store.LoadOrigin(stateDir)
		_, credentialErr := store.LoadCredential(stateDir)
		if originErr == nil && credentialErr == nil {
			client, err := controlplane.New(origin, stateDir, httpClient)
			if err == nil {
				body, nextETag, unchanged, fetchErr := client.FetchFeed(ctx, etag)
				switch {
				case fetchErr != nil:
					log.Print("broker feed unavailable; keeping rendered state")
				case unchanged:
				case body != nil:
					current, decodeErr := DecodeFeed(bytes.NewReader(body))
					if decodeErr != nil {
						log.Print("broker feed rejected; keeping rendered state")
					} else if reconcileErr := reconciler.Reconcile(current); reconcileErr != nil {
						log.Print("broker reconciliation incomplete; retrying")
					} else {
						if current.Rejected > 0 {
							log.Printf("broker feed skipped %d invalid member entries", current.Rejected)
						}
						// The one POSITIVE line this loop prints, and the only
						// evidence a provisioning gate can stand on: it is
						// reached solely after the control plane ACCEPTED this
						// box's token and returned a feed this box then
						// rendered. Silence is NOT proof — an unenrolled box
						// is silent too, because the fetch above is skipped
						// when there is no credential. See
						// packages/broker/deploy/verify-broker-box.sh.
						log.Printf("broker feed applied; members: %d", len(current.Members))
						etag = nextETag
					}
				}
			}
		} else if !errors.Is(originErr, os.ErrNotExist) && !errors.Is(credentialErr, os.ErrNotExist) {
			log.Print("broker enrollment state is invalid")
		}
		if err := wait(ctx, pollInterval); err != nil {
			return err
		}
	}
}

func wait(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
