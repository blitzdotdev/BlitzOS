package workspace

import (
	"bufio"
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
)

const (
	credentialsDirectory = "creds"
	environmentDirectory = "env.d"
	syncLockFile         = ".lock"
	// The workspace's own variables are the only thing left in creds/env.d.
	// Connection secrets are pulled at the moment of use and never written, so
	// nothing else joins this file. The numeric prefix is kept because
	// /etc/profile.d/blitz-creds.sh and blitz-term both source the glob, and
	// renaming the entry would only churn three readers.
	workspaceEnvironmentEntry = "00-workspace.sh"
)

// EnvironmentDir is where the broker leaves the shell fragment that
// /etc/profile.d/blitz-creds.sh sources. The layout is spelled once, next to
// the writer.
func EnvironmentDir(stateDir string) string {
	return filepath.Join(stateDir, credentialsDirectory, environmentDirectory)
}

var (
	ErrCredentialDenied = errors.New("this workspace is not connected to that provider")
	// ErrConnectionNotConfigured means the provider has no credential behind
	// it yet. That is the connect inbox, not a fault: the control plane filed a
	// request and a person answers it.
	ErrConnectionNotConfigured = errors.New("connection is not configured")
	environmentNamePattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	requestIDPattern           = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
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

// withCredentialsLock serializes every writer of creds/env.d. The broker's
// environment loop is the only writer today, but it can run twice across a
// restart, and a half-written env file is a login shell with no variables.
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

// GitHelper answers git's credential protocol. It is the pull model applied to
// a tool that cannot be taught to ask: git wants a password on stdin, so the
// helper mints one for that single call and never stores it.
func GitHelper(ctx context.Context, stateDir, action string, input io.Reader, output io.Writer, httpClient *http.Client) error {
	if err := readCredentialInput(input); err != nil {
		return err
	}
	if action != "get" {
		return nil
	}
	token, err := MintConnectionToken(ctx, stateDir, "github", httpClient)
	if errors.Is(err, ErrConnectionNotConfigured) {
		// A workspace with no GitHub credential is a normal state. Answering
		// nothing lets git fall through to its own prompt or to a public URL,
		// which is a better outcome than failing the clone.
		if AccessRequestID(err) != "" {
			return err
		}
		return nil
	}
	if err != nil {
		return err
	}
	// Clone and fetch both land here before any commit exists, which is the
	// moment the identity has to be right. Best effort by construction: see
	// ApplyGitIdentity.
	ApplyGitIdentity(ctx, stateDir, token.Connection, token.Token, httpClient)
	_, err = fmt.Fprintf(output, "username=x-access-token\npassword=%s\n\n", token.Token)
	return err
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
