package vendor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Runner func(context.Context, string, []string, string) error

type Definition struct {
	Name           string
	Command        string
	CredentialPath string
	RefreshArgs    []string
	VerifyArgs     []string
	ReadToken      func([]byte) (string, time.Time, error)
}

func Lookup(name string) (Definition, error) {
	switch name {
	case Claude.Name:
		return Claude, nil
	case Codex.Name:
		return Codex, nil
	default:
		return Definition{}, fmt.Errorf("unsupported harness %q", name)
	}
}

func Run(ctx context.Context, command string, args []string, home string) error {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = homeEnvironment(home)
	cmd.Stdin = nil
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errors.New("vendor CLI timed out")
		}
		return errors.New("vendor CLI rejected the credential")
	}
	return nil
}

func homeEnvironment(home string) []string {
	environment := make([]string, 0, len(os.Environ())+1)
	for _, item := range os.Environ() {
		if !strings.HasPrefix(item, "HOME=") && !strings.HasPrefix(item, "CODEX_HOME=") && !strings.HasPrefix(item, "CLAUDE_CONFIG_DIR=") {
			environment = append(environment, item)
		}
	}
	return append(environment, "HOME="+home)
}
