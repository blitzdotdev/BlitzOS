package vendor

import (
	"encoding/json"
	"errors"
	"time"
)

var Claude = Definition{
	Name:           "claude",
	Command:        "claude",
	CredentialPath: ".claude/.credentials.json",
	RefreshArgs:    []string{"auth", "status", "--json"},
	VerifyArgs:     []string{"auth", "status", "--json"},
	ReadToken:      readClaudeToken,
}

func readClaudeToken(data []byte) (string, time.Time, error) {
	var credential struct {
		OAuth struct {
			AccessToken string `json:"accessToken"`
			ExpiresAt   int64  `json:"expiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &credential); err != nil {
		return "", time.Time{}, errors.New("invalid Claude credential")
	}
	if credential.OAuth.AccessToken == "" || credential.OAuth.ExpiresAt <= 0 {
		return "", time.Time{}, errors.New("incomplete Claude credential")
	}
	return credential.OAuth.AccessToken, time.UnixMilli(credential.OAuth.ExpiresAt), nil
}
