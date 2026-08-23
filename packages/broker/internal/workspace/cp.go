package workspace

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const (
	credentialsDirectory = "creds"
	environmentDirectory = "env.d"
	syncStateFile        = "sync-state.json"
	syncLockFile         = ".lock"
	// The workspace's own variables share creds/env.d so the box has exactly
	// one environment pipeline. The name sorts ahead of every integration file
	// (blitz-creds.sh sources the glob in order), so a minted credential always
	// wins a collision with a user-supplied variable of the same name.
	workspaceEnvironmentEntry = "00-workspace.sh"
)

var (
	ErrCredentialDenied         = errors.New("credential access denied by workspace policy")
	ErrIntegrationNotConfigured = errors.New("integration is not configured")
	environmentNamePattern      = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	requestIDPattern            = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
)

type CredentialRequestError struct {
	Cause     error
	RequestID string
}

func (err *CredentialRequestError) Error() string { return err.Cause.Error() }
func (err *CredentialRequestError) Unwrap() error { return err.Cause }

func AccessRequestID(err error) string {
	var requested *CredentialRequestError
	if !errors.As(err, &requested) {
		return ""
	}
	return requested.RequestID
}

type Placement struct {
	Kind  string
	Name  string
	Value string
	Path  string
	Mode  *os.FileMode
}

type MintResult struct {
	Integration string
	Mode        string
	Placements  []Placement
	ExpiresAt   int64
}

// SyncState is what applySync records for the box's shell to read. The
// freshness decision itself lives in the consumer,
// packages/box/rootfs/etc/profile.d/blitz-creds.sh, which parses expires_at
// and applies its own 60 s margin; nothing on the Go side re-implements it.
type SyncState struct {
	SyncedAt  int64 `json:"synced_at"`
	ExpiresAt int64 `json:"expires_at"`
}

func MintIntegration(ctx context.Context, stateDir, integration string) (MintResult, error) {
	if !validIntegrationName(integration) {
		return MintResult{}, errors.New("invalid integration name")
	}
	body, err := json.Marshal(struct {
		Integration string `json:"integration"`
	}{Integration: integration})
	if err != nil {
		return MintResult{}, err
	}
	data, err := mintRequest(ctx, stateDir, body)
	if err != nil {
		return MintResult{}, err
	}
	result, err := decodeMintResult(data)
	if err != nil {
		return MintResult{}, err
	}
	if result.Integration != integration {
		return MintResult{}, errors.New("credential mint response changed integration name")
	}
	if err := applyMintResult(stateDir, result); err != nil {
		return MintResult{}, err
	}
	return result, nil
}

// withCredentialsLock serializes every writer of creds/env.d. A credential
// sync replaces the whole directory, so the workspace environment file has to
// be written under the same lock or a concurrent sync would drop it.
func withCredentialsLock(stateDir string, run func(credsDir string) error) error {
	credsDir := filepath.Join(stateDir, credentialsDirectory)
	if err := os.MkdirAll(credsDir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(credsDir, syncLockFile), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return run(credsDir)
}

func Sync(ctx context.Context, stateDir string) error {
	return withCredentialsLock(stateDir, func(string) error {
		data, err := mintRequest(ctx, stateDir, []byte("{}"))
		if err != nil {
			return err
		}
		results, err := decodeMintResults(data)
		if err != nil {
			return err
		}
		return applySync(stateDir, results, time.Now().UnixMilli())
	})
}

func GitHelper(ctx context.Context, stateDir, action string, input io.Reader, output io.Writer) error {
	if err := readCredentialInput(input); err != nil {
		return err
	}
	if action != "get" {
		return nil
	}
	result, err := MintIntegration(ctx, stateDir, "github")
	if errors.Is(err, ErrIntegrationNotConfigured) {
		if AccessRequestID(err) != "" {
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	for _, placement := range result.Placements {
		if placement.Kind == "env" && placement.Name == "GH_TOKEN" {
			if strings.ContainsAny(placement.Value, "\r\n") {
				return errors.New("github credential response contains an invalid GH_TOKEN")
			}
			_, err := fmt.Fprintf(output, "username=x-access-token\npassword=%s\n\n", placement.Value)
			return err
		}
	}
	return errors.New("github credential response is missing GH_TOKEN")
}

func readCredentialInput(input io.Reader) error {
	scanner := bufio.NewScanner(io.LimitReader(input, credentialMaxSize+1))
	buffer := make([]byte, 4096)
	scanner.Buffer(buffer, credentialMaxSize)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		key, _, ok := strings.Cut(line, "=")
		if !ok || key == "" {
			return errors.New("invalid git credential input")
		}
	}
	if err := scanner.Err(); err != nil {
		return errors.New("invalid git credential input")
	}
	return nil
}

func mintRequest(ctx context.Context, stateDir string, body []byte) ([]byte, error) {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return nil, err
	}
	client, err := controlplane.New(origin, stateDir)
	if err != nil {
		return nil, err
	}
	response, err := client.PostWorkspaceCredentials(ctx, body)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusForbidden:
		return nil, mintResponseError(response.Body, ErrCredentialDenied)
	case http.StatusNotFound:
		return nil, mintResponseError(response.Body, ErrIntegrationNotConfigured)
	default:
		return nil, fmt.Errorf("credential mint failed (HTTP %d)", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, credentialMaxSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > credentialMaxSize {
		return nil, errors.New("credential mint response is too large")
	}
	return data, nil
}

func mintResponseError(body io.Reader, cause error) error {
	data, err := io.ReadAll(io.LimitReader(body, credentialMaxSize+1))
	if err != nil || len(data) > credentialMaxSize {
		return cause
	}
	var response struct {
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(data, &response) != nil || !requestIDPattern.MatchString(response.RequestID) {
		return cause
	}
	return &CredentialRequestError{Cause: cause, RequestID: response.RequestID}
}

func decodeMintResult(data []byte) (MintResult, error) {
	var raw wireMintResult
	if err := decodeCredentialJSON(data, &raw); err != nil {
		return MintResult{}, errors.New("invalid credential mint response")
	}
	return raw.validate()
}

func decodeMintResults(data []byte) ([]MintResult, error) {
	var raw []json.RawMessage
	if err := decodeCredentialJSON(data, &raw); err != nil || raw == nil {
		return nil, errors.New("invalid credential sync response")
	}
	results := make([]MintResult, 0, len(raw))
	seen := make(map[string]bool)
	for _, item := range raw {
		result, err := decodeMintResult(item)
		if err != nil || seen[result.Integration] {
			return nil, errors.New("invalid credential sync response")
		}
		seen[result.Integration] = true
		results = append(results, result)
	}
	return results, nil
}

type wireMintResult struct {
	Integration string            `json:"integration"`
	Mode        string            `json:"mode"`
	Placements  []json.RawMessage `json:"placements"`
	ExpiresAt   int64             `json:"expiresAt"`
}

func (raw wireMintResult) validate() (MintResult, error) {
	if !validIntegrationName(raw.Integration) || (raw.Mode != "inject" && raw.Mode != "proxy") || raw.Placements == nil || raw.ExpiresAt <= 0 {
		return MintResult{}, errors.New("invalid credential mint response")
	}
	result := MintResult{Integration: raw.Integration, Mode: raw.Mode, ExpiresAt: raw.ExpiresAt}
	result.Placements = make([]Placement, 0, len(raw.Placements))
	for _, item := range raw.Placements {
		placement, err := decodePlacement(item)
		if err != nil {
			return MintResult{}, errors.New("invalid credential mint response")
		}
		result.Placements = append(result.Placements, placement)
	}
	return result, nil
}

type wirePlacement struct {
	Kind  string  `json:"kind"`
	Name  *string `json:"name,omitempty"`
	Value *string `json:"value,omitempty"`
	Path  *string `json:"path,omitempty"`
	Mode  *uint32 `json:"mode,omitempty"`
}

func decodePlacement(data []byte) (Placement, error) {
	var raw wirePlacement
	if err := decodeCredentialJSON(data, &raw); err != nil {
		return Placement{}, err
	}
	switch raw.Kind {
	case "env":
		if raw.Name == nil || raw.Value == nil || raw.Path != nil || raw.Mode != nil || !environmentNamePattern.MatchString(*raw.Name) || strings.ContainsRune(*raw.Value, 0) {
			return Placement{}, errors.New("invalid env placement")
		}
		return Placement{Kind: raw.Kind, Name: *raw.Name, Value: *raw.Value}, nil
	case "unset-env":
		if raw.Name == nil || raw.Value != nil || raw.Path != nil || raw.Mode != nil || !environmentNamePattern.MatchString(*raw.Name) {
			return Placement{}, errors.New("invalid unset-env placement")
		}
		return Placement{Kind: raw.Kind, Name: *raw.Name}, nil
	case "file":
		if raw.Name != nil || raw.Value == nil || raw.Path == nil || *raw.Path == "" || strings.ContainsRune(*raw.Path, 0) || (raw.Mode != nil && *raw.Mode > 0o777) {
			return Placement{}, errors.New("invalid file placement")
		}
		mode := os.FileMode(0o600)
		if raw.Mode != nil {
			mode = os.FileMode(*raw.Mode)
		}
		return Placement{Kind: raw.Kind, Path: *raw.Path, Value: *raw.Value, Mode: &mode}, nil
	default:
		return Placement{}, errors.New("invalid placement kind")
	}
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

func applyMintResult(stateDir string, result MintResult) error {
	credsDir := filepath.Join(stateDir, credentialsDirectory)
	envDir := filepath.Join(credsDir, environmentDirectory)
	if err := os.MkdirAll(envDir, 0o700); err != nil {
		return err
	}
	if err := applyFilePlacements(result); err != nil {
		return err
	}
	content := environmentFile(result.Placements)
	path := filepath.Join(envDir, result.Integration+".sh")
	if len(content) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return atomicfile.Write(path, content, 0o600)
}

func applySync(stateDir string, results []MintResult, nowMS int64) error {
	credsDir := filepath.Join(stateDir, credentialsDirectory)
	if err := os.MkdirAll(credsDir, 0o700); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(credsDir, ".env.d-new-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	expiresAt := int64(0)
	for index, result := range results {
		if index == 0 || result.ExpiresAt < expiresAt {
			expiresAt = result.ExpiresAt
		}
		if err := applyFilePlacements(result); err != nil {
			return err
		}
		content := environmentFile(result.Placements)
		if len(content) > 0 {
			if err := atomicfile.Write(filepath.Join(stage, result.Integration+".sh"), content, 0o600); err != nil {
				return err
			}
		}
	}
	// The rebuild discards whatever env.d held, so the workspace variables are
	// re-emitted from their stored state rather than carried over.
	if err := stageWorkspaceEnvironment(stateDir, stage); err != nil {
		return err
	}
	if err := replaceEnvironmentDirectory(filepath.Join(credsDir, environmentDirectory), stage); err != nil {
		return err
	}
	stage = ""
	state, err := json.Marshal(SyncState{SyncedAt: nowMS, ExpiresAt: expiresAt})
	if err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(credsDir, syncStateFile), append(state, '\n'), 0o600)
}

func applyFilePlacements(result MintResult) error {
	for _, placement := range result.Placements {
		if placement.Kind != "file" {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(placement.Path), 0o700); err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if placement.Mode != nil {
			mode = *placement.Mode
		}
		if err := atomicfile.Write(placement.Path, []byte(placement.Value), mode); err != nil {
			return err
		}
	}
	return nil
}

func replaceEnvironmentDirectory(path, stage string) error {
	info, err := os.Lstat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !info.IsDir() {
		return errors.New("credential environment path is not a directory")
	}
	if errors.Is(err, os.ErrNotExist) {
		return os.Rename(stage, path)
	}
	backup, err := os.MkdirTemp(filepath.Dir(path), ".env.d-old-*")
	if err != nil {
		return err
	}
	if err := os.Remove(backup); err != nil {
		return err
	}
	if err := os.Rename(path, backup); err != nil {
		return err
	}
	if err := os.Rename(stage, path); err != nil {
		_ = os.Rename(backup, path)
		return err
	}
	return os.RemoveAll(backup)
}

func environmentFile(placements []Placement) []byte {
	var content strings.Builder
	for _, placement := range placements {
		if placement.Kind == "env" {
			fmt.Fprintf(&content, "export %s=%s\n", placement.Name, shellQuote(placement.Value))
		}
	}
	for _, placement := range placements {
		if placement.Kind == "unset-env" {
			fmt.Fprintf(&content, "unset %s\n", placement.Name)
		}
	}
	return []byte(content.String())
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func validIntegrationName(name string) bool {
	return name != "" && len(name) <= 252 && name[0] != '.' && !strings.ContainsAny(name, "/\\\x00\r\n")
}
