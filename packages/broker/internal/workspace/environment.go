package workspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
)

const (
	workspaceEnvironmentDirectory = "env"
	workspaceEnvironmentState     = "environment.json"
	workspaceEnvironmentShell     = "user-env.sh"
	startupDoneFile               = ".startup-done"
	startupLogFile                = "startup.log"
	environmentResponseMaxBytes   = 80 * 1024
	environmentMaxKeys            = 50
	environmentMaxBytes           = 8 * 1024
	startupScriptMaxBytes         = 64 * 1024
)

type WorkspaceEnvironment struct {
	Env           map[string]string `json:"env"`
	StartupScript *string           `json:"startupScript"`
	FilesReady    bool              `json:"filesReady"`
}

type wireWorkspaceEnvironment struct {
	Env           json.RawMessage `json:"env"`
	StartupScript json.RawMessage `json:"startupScript"`
	FilesReady    *bool           `json:"filesReady"`
}

func decodeWorkspaceEnvironment(data []byte) (WorkspaceEnvironment, error) {
	var raw wireWorkspaceEnvironment
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&raw); err != nil {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	if len(raw.Env) == 0 || len(raw.StartupScript) == 0 || raw.FilesReady == nil {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	var environment map[string]string
	if err := json.Unmarshal(raw.Env, &environment); err != nil || environment == nil {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	if len(environment) > environmentMaxKeys {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	bytesUsed := 0
	for name, value := range environment {
		if !environmentNamePattern.MatchString(name) || strings.ContainsRune(value, 0) {
			return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
		}
		bytesUsed += len(name) + len(value)
	}
	if bytesUsed > environmentMaxBytes {
		return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
	}
	var startupScript *string
	if string(raw.StartupScript) != "null" {
		var script string
		if err := json.Unmarshal(raw.StartupScript, &script); err != nil || len(script) > startupScriptMaxBytes {
			return WorkspaceEnvironment{}, errors.New("invalid workspace environment response")
		}
		startupScript = &script
	}
	return WorkspaceEnvironment{
		Env: environment, StartupScript: startupScript, FilesReady: *raw.FilesReady,
	}, nil
}

func fetchWorkspaceEnvironment(ctx context.Context, stateDir string, httpClient *http.Client) (WorkspaceEnvironment, error) {
	origin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return WorkspaceEnvironment{}, err
	}
	client, err := controlplane.New(origin, stateDir, httpClient)
	if err != nil {
		return WorkspaceEnvironment{}, err
	}
	response, err := client.GetWorkspaceEnvironment(ctx)
	if err != nil {
		return WorkspaceEnvironment{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return WorkspaceEnvironment{}, fmt.Errorf("workspace environment request failed (HTTP %d)", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, environmentResponseMaxBytes+1))
	if err != nil {
		return WorkspaceEnvironment{}, err
	}
	if len(data) > environmentResponseMaxBytes {
		return WorkspaceEnvironment{}, errors.New("workspace environment response is too large")
	}
	return decodeWorkspaceEnvironment(data)
}

func workspaceEnvironmentFile(environment map[string]string) []byte {
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	var content strings.Builder
	for _, name := range names {
		fmt.Fprintf(&content, "export %s=%s\n", name, shellQuote(environment[name]))
	}
	return []byte(content.String())
}

func storeWorkspaceEnvironment(stateDir string, environment WorkspaceEnvironment) error {
	directory := filepath.Join(stateDir, workspaceEnvironmentDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(environment)
	if err != nil {
		return err
	}
	if err := atomicfile.Write(filepath.Join(directory, workspaceEnvironmentState), append(data, '\n'), 0o600); err != nil {
		return err
	}
	return atomicfile.Write(
		filepath.Join(directory, workspaceEnvironmentShell),
		workspaceEnvironmentFile(environment.Env),
		0o600,
	)
}

func commandEnvironment(configured map[string]string) []string {
	environment := make(map[string]string)
	for _, item := range os.Environ() {
		name, value, found := strings.Cut(item, "=")
		if found {
			environment[name] = value
		}
	}
	for name, value := range configured {
		environment[name] = value
	}
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+environment[name])
	}
	return result
}

func runStartupOnce(ctx context.Context, stateDir, workspaceDir string, environment WorkspaceEnvironment) error {
	directory := filepath.Join(stateDir, workspaceEnvironmentDirectory)
	markerPath := filepath.Join(directory, startupDoneFile)
	marker, err := os.OpenFile(markerPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := marker.Close(); err != nil {
		_ = os.Remove(markerPath)
		return err
	}
	log, err := os.OpenFile(filepath.Join(directory, startupLogFile), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		_ = os.Remove(markerPath)
		return err
	}
	defer log.Close()
	if environment.StartupScript == nil {
		return nil
	}
	command := exec.CommandContext(ctx, "bash", "-c", *environment.StartupScript)
	command.Dir = workspaceDir
	command.Env = commandEnvironment(environment.Env)
	command.Stdout = log
	command.Stderr = log
	if err := command.Run(); err != nil {
		return fmt.Errorf("workspace startup script failed: %w", err)
	}
	return nil
}

func environmentTick(ctx context.Context, stateDir, workspaceDir string, httpClient *http.Client) (bool, error) {
	environment, err := fetchWorkspaceEnvironment(ctx, stateDir, httpClient)
	if err != nil {
		return false, err
	}
	if err := storeWorkspaceEnvironment(stateDir, environment); err != nil {
		return false, err
	}
	if !environment.FilesReady {
		return false, nil
	}
	if err := runStartupOnce(ctx, stateDir, workspaceDir, environment); err != nil {
		return false, err
	}
	return true, nil
}
