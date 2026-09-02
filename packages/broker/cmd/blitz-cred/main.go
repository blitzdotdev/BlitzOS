package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/enroll"
	"github.com/blitzdotdev/blitz-core/broker/internal/workspace"
)

// registerTimeout caps the whole broker enrolment, retries included.
const registerTimeout = 45 * time.Second

// usageText is the single description of the verb set: the help verbs print it
// and the no-argument case returns it as the error, so an agent that guessed
// wrong reads the same list whichever way it arrived.
//
// The credential verbs (list, get, env, import, put, git-helper) are gone on
// purpose: the box keeps only schema-free primitives, and credentials are the
// agent's own curl against the control plane's /agent/* API. `api-token` is
// the one local helper that path needs — it prints a bearer and knows nothing
// about what the bearer is for.
const usageText = `usage: blitz-cred COMMAND [ARGUMENTS]

  api-token                    print a currently-valid control-plane bearer, and nothing else
  enroll --origin URL          claim this box's control-plane credential
  register                     register broker keys and pin the broker config
  token claude|codex           print the harness login token
  watch                        deposit harness logins to the broker as they change`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// run is the whole CLI. No verb reads stdin any more: the credential verbs
// that did (import, put, git-helper) are deleted, and everything left either
// takes arguments or takes nothing.
func run(args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New(usageText)
	}
	// Answered before the state check: `blitz-cred --help` asks what the verbs
	// are, and an agent that runs it outside a box deserves the list rather than
	// a complaint about the environment.
	if args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		_, err := fmt.Fprintln(output, usageText)
		return err
	}
	stateDir := os.Getenv("BLITZ_STATE_DIR")
	if stateDir == "" {
		return errors.New("BLITZ_STATE_DIR is required")
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
		// Bounded, because this runs as a boot-time oneshot with the rest of
		// the box's services ordered behind it. The retry budget inside
		// Register fits comfortably; anything slower than this is an outage,
		// and the right answer to an outage is a workspace that boots signed
		// out rather than one that never boots.
		ctx, cancel := context.WithTimeout(context.Background(), registerTimeout)
		defer cancel()
		return workspace.Register(ctx, stateDir, nil)
	case "token":
		// Harness logins only. The two PATH shims read this stdout verbatim as
		// the token itself.
		if len(args) != 2 || (args[1] != "claude" && args[1] != "codex") {
			return errors.New("usage: blitz-cred token claude|codex")
		}
		token, err := workspace.Token(context.Background(), stateDir, args[1])
		if err != nil {
			return err
		}
		_, err = output.Write(token)
		return err
	case "api-token":
		if len(args) != 1 {
			return errors.New("api-token takes no arguments")
		}
		token, err := workspace.APIToken(context.Background(), stateDir, nil)
		if err != nil {
			return err
		}
		// The token and one newline: this stdout feeds a command substitution
		// inside an Authorization header, so anything else becomes part of the
		// bearer the agent sends.
		_, err = fmt.Fprintln(output, token)
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
