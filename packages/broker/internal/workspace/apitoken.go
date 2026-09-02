package workspace

import (
	"context"
	"net/http"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

// APIToken answers `blitz-cred api-token`: a machine bearer the control plane
// currently accepts, for the agent's own curl against the /agent/* API.
//
// This is the one credential-shaped primitive left on the box, and it carries
// zero API schema on purpose. It knows how to keep a bearer fresh — the
// stored pair, the single-use refresh, the cross-process flock — and nothing
// about what the bearer unlocks; the endpoint list lives in the control
// plane's own OpenAPI document at GET /agent/api.
func APIToken(ctx context.Context, stateDir string, httpClient *http.Client) (string, error) {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return "", err
	}
	client, err := controlplane.New(origin, stateDir, httpClient)
	if err != nil {
		return "", err
	}
	return client.ValidAccessToken(ctx)
}
