package workspace

import (
	"context"
	"net/http"

	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/store"
)

// APIToken returns a machine bearer. The caller uses it with the control plane's agent API.
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
