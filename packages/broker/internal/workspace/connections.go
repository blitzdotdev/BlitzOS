package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

// Credentials are pulled, never delivered. The box keeps no copy of a
// connection secret: it asks the control plane at the moment of use, prints
// the answer, and forgets it. The control plane checks the workspace manifest
// on every one of these calls, so a Disconnect in the panel takes effect on
// the next pull rather than at some sync cadence.

// connectionNamePattern is what a provider name may contain. The name goes
// into a URL path segment, so this is checked before the request is built
// rather than trusting the caller's argument.
var connectionNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// TokenHeader is the header shape the vendor expects. It is not always
// `Bearer`: Discord wants `Bot `, and a Linear personal key goes in a bare
// `Authorization` header. Guessing wrong reads as an authentication failure,
// so the control plane states it and `blitz-cred env` prints it.
type TokenHeader struct {
	Name   string
	Prefix string
}

// ConnectionEnv is one environment name the provider's own tooling reads.
// `gh` looks for GH_TOKEN and no other name, so the names travel with the
// token instead of being guessed inside the box.
type ConnectionEnv struct {
	Name  string
	Value string
}

type ConnectionToken struct {
	Connection string
	Mode       string
	Token      string
	Env        []ConnectionEnv
	Header     TokenHeader
	ExpiresAt  int64
}

// ListConnections answers what this workspace is allowed to pull. It is a live
// read of the workspace manifest, not a cache.
func ListConnections(ctx context.Context, stateDir string, httpClient *http.Client) ([]string, error) {
	client, err := connectionsClient(stateDir, httpClient)
	if err != nil {
		return nil, err
	}
	response, err := client.GetWorkspaceConnections(ctx)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("connection list failed (HTTP %d)", response.StatusCode)
	}
	data, err := readCredentialBody(response.Body)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Connections []string `json:"connections"`
	}
	if err := decodeCredentialJSON(data, &raw); err != nil || raw.Connections == nil {
		return nil, errors.New("invalid connection list response")
	}
	for _, name := range raw.Connections {
		if !connectionNamePattern.MatchString(name) {
			return nil, errors.New("invalid connection list response")
		}
	}
	return raw.Connections, nil
}

// MintConnectionToken pulls one credential. A refusal keeps its cause so the
// CLI can say what the person has to do about it, and carries the request id
// the control plane filed so the panel's inbox and the message agree.
func MintConnectionToken(ctx context.Context, stateDir, name string, httpClient *http.Client) (ConnectionToken, error) {
	if !connectionNamePattern.MatchString(name) {
		return ConnectionToken{}, errors.New("invalid connection name")
	}
	client, err := connectionsClient(stateDir, httpClient)
	if err != nil {
		return ConnectionToken{}, err
	}
	response, err := client.PostWorkspaceConnectionToken(ctx, name)
	if err != nil {
		return ConnectionToken{}, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return ConnectionToken{}, mintResponseError(response.Body, ErrCredentialDenied)
	case http.StatusNotFound:
		return ConnectionToken{}, mintResponseError(response.Body, ErrConnectionNotConfigured)
	default:
		return ConnectionToken{}, fmt.Errorf("credential mint failed (HTTP %d)", response.StatusCode)
	}
	data, err := readCredentialBody(response.Body)
	if err != nil {
		return ConnectionToken{}, err
	}
	token, err := decodeConnectionToken(data)
	if err != nil {
		return ConnectionToken{}, err
	}
	if token.Connection != name {
		return ConnectionToken{}, errors.New("credential mint response changed connection name")
	}
	return token, nil
}

type wireConnectionToken struct {
	Connection string `json:"connection"`
	Mode       string `json:"mode"`
	Token      string `json:"token"`
	Env        []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"env"`
	Header struct {
		Name   string `json:"name"`
		Prefix string `json:"prefix"`
	} `json:"header"`
	ExpiresAt int64 `json:"expiresAt"`
}

// decodeConnectionToken refuses anything it cannot print safely. A token with
// a newline in it would end an export line early and leave the rest of the
// value on stdout as if it were a separate statement, and a header name with
// one would let a response forge a second line of `blitz-cred env` output.
func decodeConnectionToken(data []byte) (ConnectionToken, error) {
	var raw wireConnectionToken
	if err := decodeCredentialJSON(data, &raw); err != nil {
		return ConnectionToken{}, errors.New("invalid credential mint response")
	}
	if !connectionNamePattern.MatchString(raw.Connection) ||
		(raw.Mode != "inject" && raw.Mode != "proxy") ||
		raw.Token == "" || strings.ContainsAny(raw.Token, "\r\n\x00") ||
		raw.Env == nil || raw.ExpiresAt <= 0 ||
		raw.Header.Name == "" || strings.ContainsAny(raw.Header.Name, "\r\n\x00") ||
		strings.ContainsAny(raw.Header.Prefix, "\r\n\x00") {
		return ConnectionToken{}, errors.New("invalid credential mint response")
	}
	token := ConnectionToken{
		Connection: raw.Connection,
		Mode:       raw.Mode,
		Token:      raw.Token,
		Header:     TokenHeader{Name: raw.Header.Name, Prefix: raw.Header.Prefix},
		ExpiresAt:  raw.ExpiresAt,
		Env:        make([]ConnectionEnv, 0, len(raw.Env)),
	}
	for _, entry := range raw.Env {
		if !environmentNamePattern.MatchString(entry.Name) ||
			strings.ContainsAny(entry.Value, "\r\n\x00") {
			return ConnectionToken{}, errors.New("invalid credential mint response")
		}
		token.Env = append(token.Env, ConnectionEnv{Name: entry.Name, Value: entry.Value})
	}
	return token, nil
}

func connectionsClient(stateDir string, httpClient *http.Client) (*controlplane.Client, error) {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return nil, err
	}
	return controlplane.New(origin, stateDir, httpClient)
}

func readCredentialBody(body io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, credentialMaxSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > credentialMaxSize {
		return nil, errors.New("credential mint response is too large")
	}
	return data, nil
}

func decodeCredentialJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values")
	}
	return nil
}
