package enroll

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func Run(ctx context.Context, stateDir, origin, clientID string, output io.Writer, httpClient *http.Client) (store.Credential, error) {
	validated, err := controlplane.ValidateOrigin(origin)
	if err != nil {
		return store.Credential{}, err
	}
	if err := store.SaveOrigin(stateDir, validated); err != nil {
		return store.Credential{}, err
	}
	credential, err := store.LoadCredential(stateDir)
	if err == nil {
		return credential, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return store.Credential{}, err
	}
	credential, err = (controlplane.DeviceFlow{HTTP: httpClient}).Enroll(ctx, validated, clientID, output)
	if err != nil {
		return store.Credential{}, err
	}
	if err := store.SaveCredential(stateDir, credential); err != nil {
		return store.Credential{}, err
	}
	return credential, nil
}
