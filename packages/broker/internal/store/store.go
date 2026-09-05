package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
)

const (
	CredentialFile = "box-credential.json"
	OriginFile     = "origin"
)

type Credential struct {
	BoxID        string `json:"box_id"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func EnsureDir(dir string) error {
	return os.MkdirAll(dir, 0o700)
}

func CredentialPath(dir string) string {
	return filepath.Join(dir, CredentialFile)
}

func OriginPath(dir string) string {
	return filepath.Join(dir, OriginFile)
}

func LoadCredential(dir string) (Credential, error) {
	data, err := os.ReadFile(CredentialPath(dir))
	if err != nil {
		return Credential{}, err
	}
	var credential Credential
	if err := decodeCredential(data, &credential); err != nil {
		return Credential{}, fmt.Errorf("invalid box credential: %w", err)
	}
	if credential.BoxID == "" || credential.AccessToken == "" || credential.RefreshToken == "" {
		return Credential{}, errors.New("invalid box credential")
	}
	return credential, nil
}

func SaveCredential(dir string, credential Credential) error {
	if credential.BoxID == "" || credential.AccessToken == "" || credential.RefreshToken == "" {
		return errors.New("refusing to write an incomplete box credential")
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicfile.WritePreservingOwnership(CredentialPath(dir), data, 0o600)
}

func LoadOrigin(dir string) (string, error) {
	data, err := os.ReadFile(OriginPath(dir))
	if err != nil {
		return "", err
	}
	origin := strings.TrimSpace(string(data))
	if origin == "" || strings.ContainsAny(origin, "\r\n") {
		return "", errors.New("invalid stored origin")
	}
	return origin, nil
}

func SaveOrigin(dir, origin string) error {
	if origin == "" || strings.ContainsAny(origin, "\r\n") {
		return errors.New("invalid origin")
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	return atomicfile.WritePreservingOwnership(OriginPath(dir), []byte(origin+"\n"), 0o644)
}

func decodeCredential(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
