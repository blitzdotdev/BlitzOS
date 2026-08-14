package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/enroll"
	"github.com/blitzdotdev/blitz-core/broker/internal/workspace"
)

const defaultStateDir = "/var/lib/blitz"

func main() {
	if err := runWithInput(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	return runWithInput(args, strings.NewReader(""), output)
}

func runWithInput(args []string, input io.Reader, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: blitz-cred enroll|register|token|sync|git-helper|watch")
	}
	stateDir := os.Getenv("BLITZ_STATE_DIR")
	if stateDir == "" {
		stateDir = defaultStateDir
	}
	switch args[0] {
	case "enroll":
		flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		origin := flags.String("origin", "", "control-plane origin")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || *origin == "" {
			return errors.New("usage: blitz-cred enroll --origin URL")
		}
		_, err := enroll.Run(context.Background(), stateDir, *origin, "blitz-cred", output, nil)
		return err
	case "register":
		if len(args) != 1 {
			return errors.New("register takes no arguments")
		}
		return workspace.Register(context.Background(), stateDir, nil)
	case "token":
		if len(args) != 2 || args[1] == "" {
			return errors.New("usage: blitz-cred token INTEGRATION")
		}
		if args[1] == "claude" || args[1] == "codex" {
			token, err := workspace.Token(context.Background(), stateDir, args[1])
			if err != nil {
				return err
			}
			_, err = output.Write(token)
			return err
		}
		result, err := workspace.MintIntegration(context.Background(), stateDir, args[1], nil)
		if requestID := workspace.AccessRequestID(err); requestID != "" {
			if errors.Is(err, workspace.ErrCredentialDenied) {
				return fmt.Errorf("blitz: access to %s requested (%s), awaiting approval", args[1], requestID)
			}
			if errors.Is(err, workspace.ErrIntegrationNotConfigured) {
				return fmt.Errorf("blitz: integration %s requested (%s), not configured yet", args[1], requestID)
			}
		}
		if errors.Is(err, workspace.ErrCredentialDenied) {
			return fmt.Errorf("blitz: access to %s denied by workspace policy", args[1])
		}
		if errors.Is(err, workspace.ErrIntegrationNotConfigured) {
			return fmt.Errorf("blitz: integration %s is not configured", args[1])
		}
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, result.ExpiresAt)
		return err
	case "sync":
		if len(args) != 1 {
			return errors.New("sync takes no arguments")
		}
		return workspace.Sync(context.Background(), stateDir, nil)
	case "git-helper":
		if len(args) != 2 {
			return errors.New("usage: blitz-cred git-helper get|store|erase")
		}
		err := workspace.GitHelper(context.Background(), stateDir, args[1], input, output, nil)
		if requestID := workspace.AccessRequestID(err); requestID != "" {
			if errors.Is(err, workspace.ErrCredentialDenied) {
				return fmt.Errorf("blitz: access to github requested (%s), awaiting approval", requestID)
			}
			if errors.Is(err, workspace.ErrIntegrationNotConfigured) {
				return fmt.Errorf("blitz: integration github requested (%s), not configured yet", requestID)
			}
		}
		if errors.Is(err, workspace.ErrCredentialDenied) {
			return errors.New("blitz: access to github denied by workspace policy")
		}
		return err
	case "watch":
		if len(args) != 1 {
			return errors.New("watch takes no arguments")
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return errors.New("current Unix user has no home directory")
		}
		return workspace.Watch(context.Background(), stateDir, home)
	default:
		return errors.New("unknown blitz-cred command")
	}
}
