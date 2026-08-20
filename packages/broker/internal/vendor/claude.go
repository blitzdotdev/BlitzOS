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
	// The only one of the two harnesses that publishes a refresh-token
	// deadline. Codex stores an opaque refresh token and announces nothing,
	// so for codex the residual documented on Definition stands unnarrowed.
	ReadRefreshExpiry: readClaudeRefreshExpiry,
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

// readClaudeRefreshExpiry reads `refreshTokenExpiresAt`. Absent is FINE and
// returns the zero time — older credential files simply do not carry the
// field, and refusing them would refuse every login written before it existed.
// Present-but-nonsense is not fine: a negative or zero value means the file no
// longer holds what this code thinks it holds, and guessing would be how a
// dead credential gets stored as the only copy.
func readClaudeRefreshExpiry(data []byte) (time.Time, error) {
	var credential struct {
		OAuth struct {
			RefreshExpiresAt *int64 `json:"refreshTokenExpiresAt"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal(data, &credential); err != nil {
		return time.Time{}, errors.New("invalid Claude credential")
	}
	if credential.OAuth.RefreshExpiresAt == nil {
		return time.Time{}, nil
	}
	if *credential.OAuth.RefreshExpiresAt <= 0 {
		return time.Time{}, errors.New("invalid Claude refresh-token expiry")
	}
	return time.UnixMilli(*credential.OAuth.RefreshExpiresAt), nil
}
