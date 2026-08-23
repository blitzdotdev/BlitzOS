package broker

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const pollInterval = time.Second

// feedAppliedPrefix is matched as a literal by
// packages/broker/deploy/verify-broker-box.sh. Changing the text breaks the
// provisioning gate silently — it would go on finding nothing and reporting a
// box that never reached the control plane.
const feedAppliedPrefix = "broker feed applied; members: "

// feedHeartbeatInterval bounds how stale the positive line may get on a box
// that is working.
//
// The line used to be printed only when the feed CHANGED. After the first apply
// the ETag makes every later poll `unchanged`, so on a long-lived box it was
// never printed again, and any gate that reads a window of log had to treat
// SILENCE as success — which is also what a box whose route to the control
// plane is blackholed produces. Re-stating it on a cadence is what turns the
// line into something a bounded window can require. It sits inside the gate's
// 45 s window (verify-broker-box.sh check 6) with room to spare, so a box that
// is reaching the plane always lands at least one line in it.
const feedHeartbeatInterval = 30 * time.Second

// feedHeartbeatDue decides whether the positive line is owed again. Split out
// of the loop because Sync refuses to run as anything but root, so this is the
// only part of the cadence a test can reach.
func feedHeartbeatDue(lastStated, now time.Time) bool {
	return lastStated.IsZero() || !now.Before(lastStated.Add(feedHeartbeatInterval))
}

func Sync(ctx context.Context, stateDir string) error {
	if os.Geteuid() != 0 {
		return errors.New("sync must run as root")
	}
	reconciler := Reconciler{
		StateDir:          stateDir,
		AuthorizedKeysDir: AuthorizedKeysDir,
		Accounts:          SystemAccounts{},
	}
	etag := ""
	members := 0
	var lastStated time.Time
	for {
		restate := false
		origin, originErr := store.LoadOrigin(stateDir)
		_, credentialErr := store.LoadCredential(stateDir)
		if originErr == nil && credentialErr == nil {
			client, err := controlplane.New(origin, stateDir)
			if err == nil {
				body, nextETag, unchanged, fetchErr := client.FetchFeed(ctx, etag)
				switch {
				case fetchErr != nil:
					log.Print("broker feed unavailable; keeping rendered state")
				case unchanged:
					// A 304 is the control plane answering, with the same
					// authentication a 200 needs. It is the steady state of a
					// working box, so it carries the heartbeat.
					restate = feedHeartbeatDue(lastStated, time.Now())
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
						members = len(current.Members)
						etag = nextETag
						restate = true
					}
				}
			}
		} else if !errors.Is(originErr, os.ErrNotExist) && !errors.Is(credentialErr, os.ErrNotExist) {
			log.Print("broker enrollment state is invalid")
		}
		if restate {
			// The one POSITIVE line this loop prints. It says exactly this: at
			// this moment the control plane answered a request carrying this
			// box's bearer token, and the member list this box has rendered is
			// the one the plane last sent. It is printed on every apply and
			// re-printed every feedHeartbeatInterval while the plane keeps
			// answering, so a reader may conclude from its ABSENCE across a
			// window longer than that interval that this box is not talking to
			// the control plane — whether it is unenrolled, unauthorised or
			// blackholed. Absence over a SHORTER window means nothing.
			// packages/broker/deploy/verify-broker-box.sh is the reader.
			log.Printf("%s%d", feedAppliedPrefix, members)
			lastStated = time.Now()
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
