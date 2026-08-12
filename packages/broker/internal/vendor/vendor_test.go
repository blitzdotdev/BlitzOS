package vendor

import (
	"encoding/base64"
	"fmt"
	"testing"
	"time"
)

func TestClaudeAndCodexRealCredentialLayouts(t *testing.T) {
	expiry := time.Unix(2_000_000_000, 0)
	claude := []byte(fmt.Sprintf(`{"claudeAiOauth":{"accessToken":"claude-token","refreshToken":"refresh","expiresAt":%d}}`, expiry.UnixMilli()))
	token, expires, err := Claude.ReadToken(claude)
	if err != nil {
		t.Fatal(err)
	}
	if token != "claude-token" || !expires.Equal(expiry) {
		t.Fatalf("Claude token=%q expiry=%v", token, expires)
	}

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":2000000000}`))
	codex := []byte(fmt.Sprintf(`{"auth_mode":"chatgpt","tokens":{"access_token":"x.%s.y","refresh_token":"refresh"}}`, payload))
	token, expires, err = Codex.ReadToken(codex)
	if err != nil {
		t.Fatal(err)
	}
	if token != "x."+payload+".y" || !expires.Equal(expiry) {
		t.Fatalf("Codex token=%q expiry=%v", token, expires)
	}
}
