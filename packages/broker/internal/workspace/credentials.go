package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// credentialNamePattern is the store's own name rule, narrower than a
// provider name: an environment variable, starting with a letter.
var credentialNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,127}$`)

// WorkspaceCredential is one entry of the workspace credential store as an
// agent sees it: the name to ask for, and the comment that says what the key
// is for. Never a value.
type WorkspaceCredential struct {
	Name    string
	Comment string
}

// ListCredentials reads the workspace credential store, live. `blitz-cred
// list` merges this with the connection allow-list and prints a credential's
// comment after a `#`.
func ListCredentials(ctx context.Context, stateDir string, httpClient *http.Client) ([]WorkspaceCredential, error) {
	client, err := connectionsClient(stateDir, httpClient)
	if err != nil {
		return nil, err
	}
	response, err := client.GetWorkspaceCredentials(ctx)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("credential list failed (HTTP %d)", response.StatusCode)
	}
	data, err := readCredentialBody(response.Body)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Credentials []struct {
			Name    string `json:"name"`
			Comment string `json:"comment,omitempty"`
		} `json:"credentials"`
	}
	if err := decodeCredentialJSON(data, &raw); err != nil || raw.Credentials == nil {
		return nil, errors.New("invalid credential list response")
	}
	credentials := make([]WorkspaceCredential, 0, len(raw.Credentials))
	// Names and comments go to stdout, so they obey the printability rule
	// every other blitz-cred output line does: a comment with a newline could
	// forge a second list line.
	for _, entry := range raw.Credentials {
		if !credentialNamePattern.MatchString(entry.Name) ||
			strings.ContainsAny(entry.Comment, "\r\n\x00") {
			return nil, errors.New("invalid credential list response")
		}
		credentials = append(credentials, WorkspaceCredential{Name: entry.Name, Comment: entry.Comment})
	}
	return credentials, nil
}

// PutCredential stores one workspace credential, with the comment that
// explains it. The control plane enforces the workspace-admin gate; the
// checks here exist only to refuse locally what the wire would refuse anyway,
// with a sentence instead of a 400.
func PutCredential(
	ctx context.Context,
	stateDir, name, value, label, comment string,
	httpClient *http.Client,
) error {
	if !credentialNamePattern.MatchString(name) {
		return errors.New("the name must be an environment variable name")
	}
	if value == "" {
		return errors.New("the value is empty")
	}
	if strings.ContainsAny(value, "\r\n\x00") {
		return errors.New("the value spans more than one line; base64-encode it first")
	}
	if strings.ContainsAny(comment, "\r\n\x00") {
		return errors.New("the comment must be a single line")
	}
	client, err := connectionsClient(stateDir, httpClient)
	if err != nil {
		return err
	}
	request := struct {
		Name    string `json:"name"`
		Value   string `json:"value"`
		Label   string `json:"label,omitempty"`
		Comment string `json:"comment,omitempty"`
	}{Name: name, Value: value, Label: label, Comment: comment}
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	response, err := client.PutWorkspaceCredential(ctx, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusCreated:
		return nil
	case http.StatusForbidden:
		return ErrNotWorkspaceAdmin
	default:
		return fmt.Errorf("credential store failed (HTTP %d)", response.StatusCode)
	}
}
