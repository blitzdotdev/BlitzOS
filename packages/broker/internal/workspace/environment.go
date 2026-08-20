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

// workspaceEnvironmentPlacements reuses the credential placement shape so the
// workspace's variables are rendered by the one environment-file writer the
// box already has, rather than a second export format.
func workspaceEnvironmentPlacements(environment map[string]string) []Placement {
	names := make([]string, 0, len(environment))
	for name := range environment {
		names = append(names, name)
	}
	sort.Strings(names)
	placements := make([]Placement, 0, len(names))
	for _, name := range names {
		placements = append(placements, Placement{Kind: "env", Name: name, Value: environment[name]})
	}
	return placements
}

// loadWorkspaceEnvironment reads the stored state. A missing or unreadable
// state file yields the empty environment: the box must still come up.
func loadWorkspaceEnvironment(stateDir string) (WorkspaceEnvironment, error) {
	path := filepath.Join(stateDir, workspaceEnvironmentDirectory, workspaceEnvironmentState)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return WorkspaceEnvironment{Env: map[string]string{}}, nil
	}
	if err != nil {
		return WorkspaceEnvironment{}, err
	}
	return decodeWorkspaceEnvironment(data)
}

// stageWorkspaceEnvironment writes the workspace entry into an env.d directory
// being built. A credential sync rebuilds env.d from scratch, so it calls this
// to carry the workspace variables across the replacement.
func stageWorkspaceEnvironment(stateDir, envDir string) error {
	environment, err := loadWorkspaceEnvironment(stateDir)
	if err != nil {
		return err
	}
	return writeWorkspaceEnvironmentEntry(envDir, environment.Env)
}

func writeWorkspaceEnvironmentEntry(envDir string, configured map[string]string) error {
	path := filepath.Join(envDir, workspaceEnvironmentEntry)
	content := environmentFile(workspaceEnvironmentPlacements(configured))
	if len(content) == 0 {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return atomicfile.Write(path, content, 0o600)
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
	return withCredentialsLock(stateDir, func(credsDir string) error {
		envDir := filepath.Join(credsDir, environmentDirectory)
		if err := os.MkdirAll(envDir, 0o700); err != nil {
			return err
		}
		return writeWorkspaceEnvironmentEntry(envDir, environment.Env)
	})
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

var closedStartup = func() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}()

// startStartupOnce claims the once-only marker and then starts the workspace's
// startup script in its own goroutine. User code must never sit on the caller's
// path: the deposit loop that calls this also ships vendor credentials, and a
// script that legitimately never exits (a dev server, `tail -f`) would wedge it
// forever. The script's own lifetime is bound to ctx — the broker's, so the
// box's — instead of an arbitrary timeout, because killing a server the script
// started on purpose is worse than letting it run as long as the box does.
//
// The returned channel closes when the script exits, and is already closed when
// nothing ran. Only tests wait on it.
func startStartupOnce(
	ctx context.Context,
	stateDir, workspaceDir string,
	environment WorkspaceEnvironment,
) (<-chan struct{}, error) {
	directory := filepath.Join(stateDir, workspaceEnvironmentDirectory)
	markerPath := filepath.Join(directory, startupDoneFile)
	marker, err := os.OpenFile(markerPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return closedStartup, nil
	}
	if err != nil {
		return closedStartup, err
	}
	if err := marker.Close(); err != nil {
		_ = os.Remove(markerPath)
		return closedStartup, err
	}
	log, err := os.OpenFile(filepath.Join(directory, startupLogFile), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		_ = os.Remove(markerPath)
		return closedStartup, err
	}
	if environment.StartupScript == nil {
		return closedStartup, log.Close()
	}
	command := exec.CommandContext(ctx, "bash", "-c", *environment.StartupScript)
	command.Dir = workspaceDir
	command.Env = commandEnvironment(environment.Env)
	command.Stdout = log
	command.Stderr = log
	if err := command.Start(); err != nil {
		_ = log.Close()
		return closedStartup, fmt.Errorf("workspace startup script failed to start: %w", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer log.Close()
		if err := command.Wait(); err != nil {
			fmt.Fprintf(log, "\nblitz: workspace startup script failed: %v\n", err)
		}
	}()
	return done, nil
}

// environmentTick fetches and stores this box's environment, and once the
// workspace files have landed, starts the startup script exactly once. It
// returns true when there is nothing left to converge. The channel closes when
// the startup script exits; callers on the credential path must not wait on it.
func environmentTick(
	ctx context.Context,
	stateDir, workspaceDir string,
	httpClient *http.Client,
) (bool, <-chan struct{}, error) {
	environment, err := fetchWorkspaceEnvironment(ctx, stateDir, httpClient)
	if err != nil {
		return false, closedStartup, err
	}
	if err := storeWorkspaceEnvironment(stateDir, environment); err != nil {
		return false, closedStartup, err
	}
	if !environment.FilesReady {
		return false, closedStartup, nil
	}
	done, err := startStartupOnce(ctx, stateDir, workspaceDir, environment)
	if err != nil {
		return false, done, err
	}
	return true, done, nil
}
