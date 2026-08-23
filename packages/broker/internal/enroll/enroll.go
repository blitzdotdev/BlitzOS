package enroll

import (
	"context"
	"errors"
	"io"
	"os"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func Run(ctx context.Context, stateDir, origin, clientID string, output io.Writer) (store.Credential, error) {
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
	credential, err = (controlplane.DeviceFlow{}).Enroll(ctx, validated, clientID, output)
	if err != nil {
		return store.Credential{}, err
	}
	if err := store.SaveCredential(stateDir, credential); err != nil {
		return store.Credential{}, err
	}
	return credential, nil
}
