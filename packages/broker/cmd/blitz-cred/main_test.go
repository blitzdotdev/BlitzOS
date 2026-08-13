package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

func TestEnrollAcceptsCredentialWithAdditionalFields(t *testing.T) {
	stateDir := t.TempDir()
	credential := []byte(`{
  "box_id": "box",
  "access_token": "access",
  "refresh_token": "refresh",
  "token_type": "Bearer",
  "expires_in": 900
}`)
	if err := os.WriteFile(filepath.Join(stateDir, store.CredentialFile), credential, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BLITZ_STATE_DIR", stateDir)

	if err := run([]string{"enroll", "--origin", "https://cp.example"}, io.Discard); err != nil {
		t.Fatalf("blitz-cred rejected a credential with additional fields: %v", err)
	}
}
