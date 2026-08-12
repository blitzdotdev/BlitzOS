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
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const responseMaxBytes = 1_048_576

type Client struct {
	origin   string
	stateDir string
	http     *http.Client
	refresh  sync.Mutex
}

type Broker struct {
	Host             string `json:"host"`
	Port             int    `json:"port"`
	SSHHostPublicKey string `json:"sshHostPublicKey"`
}

type KeyRegistration struct {
	Broker
	MemberUnixName string
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

func (c *Client) RegisterBroker(ctx context.Context, host string, port int, hostKey string) error {
	if !validHost(host) || port < 1 || port > 65535 || !feed.ValidPublicKey(hostKey) {
		return errors.New("invalid broker registration")
	}
	body, err := json.Marshal(Broker{Host: host, Port: port, SSHHostPublicKey: hostKey})
	if err != nil {
		return err
	}
	response, err := c.authenticated(ctx, http.MethodPut, func(boxID string) string {
		return "/boxes/" + url.PathEscape(boxID) + "/broker"
	}, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return statusError(response.StatusCode, "broker registration failed")
	}
	return nil
}

func (c *Client) RegisterKeys(ctx context.Context, keys []feed.Key) (KeyRegistration, error) {
	if len(keys) == 0 {
		return KeyRegistration{}, errors.New("at least one key is required")
	}
	for _, key := range keys {
		if !feed.ValidPublicKey(key.Pubkey) || (key.Op != "mint" && key.Op != "deposit") {
			return KeyRegistration{}, errors.New("invalid broker key")
		}
	}
	body, err := json.Marshal(struct {
		Keys []feed.Key `json:"keys"`
	}{Keys: keys})
	if err != nil {
		return KeyRegistration{}, err
	}
	response, err := c.authenticated(ctx, http.MethodPost, func(boxID string) string {
		return "/boxes/" + url.PathEscape(boxID) + "/keys"
	}, body)
	if err != nil {
		return KeyRegistration{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return KeyRegistration{}, statusError(response.StatusCode, "key registration failed")
	}
	data, err := readLimited(response.Body, responseMaxBytes)
	if err != nil {
		return KeyRegistration{}, err
	}
	var result struct {
		Broker         Broker `json:"broker"`
		MemberUnixName string `json:"memberUnixName"`
	}
	if err := decodeStrict(data, &result); err != nil {
		return KeyRegistration{}, errors.New("invalid key registration response")
	}
	if !validHost(result.Broker.Host) || result.Broker.Port < 1 || result.Broker.Port > 65535 || !feed.ValidPublicKey(result.Broker.SSHHostPublicKey) || !feed.ValidUnixName(result.MemberUnixName) {
		return KeyRegistration{}, errors.New("invalid broker response")
	}
	return KeyRegistration{Broker: result.Broker, MemberUnixName: result.MemberUnixName}, nil
}

func (c *Client) FetchFeed(ctx context.Context, etag string) ([]byte, string, bool, error) {
	credential, err := store.LoadCredential(c.stateDir)
	if err != nil {
		return nil, "", false, err
	}
	path := "/boxes/" + url.PathEscape(credential.BoxID) + "/feed"
	request := func(access string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.origin+path, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+access)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		return c.http.Do(req)
	}
	response, err := request(credential.AccessToken)
	if err != nil {
		return nil, "", false, err
	}
	if response.StatusCode == http.StatusUnauthorized {
		response.Body.Close()
		credential, err = c.refreshCredential(ctx, credential.AccessToken)
		if err != nil {
			return nil, "", false, err
		}
		response, err = request(credential.AccessToken)
		if err != nil {
			return nil, "", false, err
		}
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		return nil, etag, true, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", false, statusError(response.StatusCode, "feed request failed")
	}
	responseETag := response.Header.Get("ETag")
	if responseETag == "" {
		return nil, "", false, errors.New("feed response is missing ETag")
	}
	body, err := readLimited(response.Body, feed.MaxBytes)
	if err != nil {
		return nil, "", false, err
	}
	return body, responseETag, false, nil
}

func (c *Client) authenticated(ctx context.Context, method string, path func(string) string, body []byte) (*http.Response, error) {
	credential, err := store.LoadCredential(c.stateDir)
	if err != nil {
		return nil, err
	}
	request := func(current store.Credential) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, c.origin+path(current.BoxID), bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+current.AccessToken)
		req.Header.Set("Content-Type", "application/json")
		return c.http.Do(req)
	}
	response, err := request(credential)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusUnauthorized {
		return response, nil
	}
	response.Body.Close()
	credential, err = c.refreshCredential(ctx, credential.AccessToken)
	if err != nil {
		return nil, err
	}
	response, err = request(credential)
	return response, err
}

func (c *Client) refreshCredential(ctx context.Context, staleAccess string) (store.Credential, error) {
	c.refresh.Lock()
	defer c.refresh.Unlock()
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
	rotated := store.Credential{BoxID: issued.BoxID, AccessToken: issued.AccessToken, RefreshToken: issued.RefreshToken}
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

func validHost(host string) bool {
	return host != "" && !strings.ContainsFunc(host, unicode.IsSpace)
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
