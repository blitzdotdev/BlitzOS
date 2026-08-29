package workspace

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// ErrNotWorkspaceAdmin means the control plane refused the import because
// this machine's member does not administer the workspace. The gate is the
// same one the credentials tab enforces, so the fix is a person, not a retry.
var ErrNotWorkspaceAdmin = errors.New("only a workspace admin can import credentials")

// credentialImportMaxBytes caps the dotenv text this box will upload. The
// control plane holds the real ceiling; this one exists so a mistyped path to
// a tarball fails here with a size, not there with a 400.
const credentialImportMaxBytes = 512 * 1024

// CredentialImportResult is one line's outcome, in the store's vocabulary:
// stored, rotated, unchanged, or refused with a reason. No value ever comes
// back — the response names keys and outcomes only.
type CredentialImportResult struct {
	Name    string
	Line    int
	Outcome string
	Reason  string
}

type CredentialImport struct {
	Results   []CredentialImportResult
	LinesRead int
}

var importOutcomes = map[string]bool{
	"stored": true, "rotated": true, "unchanged": true, "refused": true,
}

// ImportCredentials sends dotenv text to the control plane, which parses it
// and stores each KEY=value line as a workspace credential. `check` is the
// server's dry run: the same parse and the same outcomes, no writes.
func ImportCredentials(
	ctx context.Context,
	stateDir, text, label string,
	check bool,
	httpClient *http.Client,
) (CredentialImport, error) {
	if len(text) > credentialImportMaxBytes {
		return CredentialImport{}, fmt.Errorf(
			"env text is larger than %d bytes; that is not an env file", credentialImportMaxBytes,
		)
	}
	client, err := connectionsClient(stateDir, httpClient)
	if err != nil {
		return CredentialImport{}, err
	}
	request := struct {
		Text   string `json:"text"`
		Label  string `json:"label,omitempty"`
		DryRun bool   `json:"dryRun,omitempty"`
	}{Text: text, Label: label, DryRun: check}
	body, err := json.Marshal(request)
	if err != nil {
		return CredentialImport{}, err
	}
	response, err := client.PostWorkspaceCredentialImport(ctx, body)
	if err != nil {
		return CredentialImport{}, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return CredentialImport{}, ErrNotWorkspaceAdmin
	default:
		return CredentialImport{}, fmt.Errorf("credential import failed (HTTP %d)", response.StatusCode)
	}
	data, err := readCredentialBody(response.Body)
	if err != nil {
		return CredentialImport{}, err
	}
	var raw struct {
		Results []struct {
			Name    string `json:"name"`
			Line    int    `json:"line"`
			Outcome string `json:"outcome"`
			Reason  string `json:"reason,omitempty"`
		} `json:"results"`
		LinesRead int `json:"linesRead"`
	}
	if err := decodeCredentialJSON(data, &raw); err != nil || raw.Results == nil || raw.LinesRead < 0 {
		return CredentialImport{}, errors.New("invalid credential import response")
	}
	result := CredentialImport{
		LinesRead: raw.LinesRead,
		Results:   make([]CredentialImportResult, 0, len(raw.Results)),
	}
	// The names and reasons go to stdout, so the printability rule that guards
	// every other blitz-cred line guards these: a name with a newline could
	// forge a second result row.
	for _, entry := range raw.Results {
		if !importOutcomes[entry.Outcome] ||
			strings.ContainsAny(entry.Name, "\r\n\x00") ||
			strings.ContainsAny(entry.Reason, "\r\n\x00") {
			return CredentialImport{}, errors.New("invalid credential import response")
		}
		result.Results = append(result.Results, CredentialImportResult{
			Name:    entry.Name,
			Line:    entry.Line,
			Outcome: entry.Outcome,
			Reason:  entry.Reason,
		})
	}
	return result, nil
}
