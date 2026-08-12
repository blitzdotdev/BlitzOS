package vendor

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var Codex = Definition{
	Name:           "codex",
	Command:        "codex",
	CredentialPath: ".codex/auth.json",
	RefreshArgs:    []string{"debug", "models"},
	VerifyArgs:     []string{"debug", "models"},
	ReadToken:      readCodexToken,
}

func readCodexToken(data []byte) (string, time.Time, error) {
	var credential struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			AccessToken string `json:"access_token"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(data, &credential); err != nil {
		return "", time.Time{}, errors.New("invalid Codex credential")
	}
	if credential.AuthMode != "chatgpt" || credential.Tokens.AccessToken == "" {
		return "", time.Time{}, errors.New("Codex credential is not ChatGPT OAuth")
	}
	parts := strings.Split(credential.Tokens.AccessToken, ".")
	if len(parts) != 3 {
		return "", time.Time{}, errors.New("invalid Codex access token")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, errors.New("invalid Codex access token")
	}
	var claims struct {
		Expires int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Expires <= 0 {
		return "", time.Time{}, errors.New("invalid Codex access token")
	}
	return credential.Tokens.AccessToken, time.Unix(claims.Expires, 0), nil
}
