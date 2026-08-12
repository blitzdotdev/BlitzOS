package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/blitzdotdev/blitz-core/broker/internal/enroll"
	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/workspace"
)

const defaultStateDir = "/var/lib/blitz"

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: blitz-cred enroll|register|token|watch")
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
		if len(args) != 2 || !feed.ValidHarness(args[1]) {
			return errors.New("usage: blitz-cred token claude|codex")
		}
		token, err := workspace.Token(context.Background(), stateDir, args[1])
		if err != nil {
			return err
		}
		_, err = output.Write(token)
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
