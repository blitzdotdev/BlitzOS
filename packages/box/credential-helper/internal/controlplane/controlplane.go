package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/filelock"
	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/store"
)

const (
	agentAPIProbePath = "/agent/api"
	responseMaxBytes  = 1_048_576
	refreshLockWait   = 30 * time.Second
	RefreshLockFile   = "box-credential.lock"
)

type Client struct {
	origin   string
	stateDir string
	http     *http.Client
	refresh  sync.Mutex
}

func ValidateOrigin(raw string) (string, error) {
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("origin must be an absolute URL without a path")
	}
	if parsed.Scheme != "https" {
		if parsed.Scheme != "http" || !isLocalhost(parsed.Hostname()) {
			return "", errors.New("origin must use HTTPS (HTTP is allowed only for localhost)")
		}
	}
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

func New(origin, stateDir string, httpClient *http.Client) (*Client, error) {
	validated, err := ValidateOrigin(origin)
	if err != nil {
		return nil, err
	}
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{origin: validated, stateDir: stateDir, http: httpClient}, nil
}

// ValidAccessToken probes the stored bearer. Only HTTP 401 starts a refresh.
// The box cannot inspect the expiry because the control plane owns it.
// A network error returns the stored token because the caller will expose that failure.
func (c *Client) ValidAccessToken(ctx context.Context) (string, error) {
	credential, err := store.LoadCredential(c.stateDir)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.origin+agentAPIProbePath, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken)
	response, err := c.http.Do(request)
	if err != nil {
		return credential.AccessToken, nil
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		return credential.AccessToken, nil
	}
	rotated, err := c.refreshCredential(ctx, credential.AccessToken)
	if err != nil {
		return "", err
	}
	return rotated.AccessToken, nil
}

func (c *Client) refreshCredential(ctx context.Context, staleAccess string) (store.Credential, error) {
	c.refresh.Lock()
	defer c.refresh.Unlock()
	if err := store.EnsureDir(c.stateDir); err != nil {
		return store.Credential{}, err
	}
	var rotated store.Credential
	err := filelock.With(
		ctx,
		filepath.Join(c.stateDir, RefreshLockFile),
		refreshLockWait,
		func() error {
			credential, err := c.refreshLocked(ctx, staleAccess)
			rotated = credential
			return err
		},
	)
	if err != nil {
		return store.Credential{}, err
	}
	return rotated, nil
}

// refreshLocked reads again after taking the separate lock inode.
// Another process can rotate the single-use token while this process waits.
func (c *Client) refreshLocked(ctx context.Context, staleAccess string) (store.Credential, error) {
	credential, err := store.LoadCredential(c.stateDir)
	if err != nil {
		return store.Credential{}, err
	}
	if credential.AccessToken != staleAccess {
		return credential, nil
	}
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {credential.RefreshToken},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return store.Credential{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := c.http.Do(request)
	if err != nil {
		return store.Credential{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return store.Credential{}, statusError(response.StatusCode, "token refresh failed")
	}
	data, err := readLimited(response.Body, responseMaxBytes)
	if err != nil {
		return store.Credential{}, err
	}
	issued, err := decodeIssued(data)
	if err != nil {
		return store.Credential{}, err
	}
	if issued.BoxID != credential.BoxID {
		return store.Credential{}, errors.New("token refresh changed box identity")
	}
	rotated := store.Credential{
		BoxID: issued.BoxID, AccessToken: issued.AccessToken, RefreshToken: issued.RefreshToken,
	}
	if err := store.SaveCredential(c.stateDir, rotated); err != nil {
		return store.Credential{}, err
	}
	return rotated, nil
}

type issuedTokens struct {
	BoxID        string `json:"box_id"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

func decodeIssued(data []byte) (issuedTokens, error) {
	var issued issuedTokens
	if err := decodeStrict(data, &issued); err != nil || issued.BoxID == "" || issued.AccessToken == "" || issued.RefreshToken == "" || !strings.EqualFold(issued.TokenType, "Bearer") || issued.ExpiresIn <= 0 {
		return issuedTokens{}, errors.New("invalid token response")
	}
	return issued, nil
}

func isLocalhost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

func statusError(status int, message string) error {
	return fmt.Errorf("%s (HTTP %s)", message, strconv.Itoa(status))
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("control plane response is too large")
	}
	return data, nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
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
