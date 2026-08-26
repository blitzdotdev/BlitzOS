package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/enroll"
	"github.com/blitzdotdev/blitz-core/broker/internal/workspace"
)

// registerTimeout caps the whole broker enrolment, retries included.
const registerTimeout = 45 * time.Second

// usageText is the single description of the verb set: the help verbs print it
// and the no-argument case returns it as the error, so an agent that guessed
// wrong reads the same list whichever way it arrived.
const usageText = `usage: blitz-cred COMMAND [ARGUMENTS]

  list                         providers this workspace may use, one per line
  get PROVIDER                 print PROVIDER's token on stdout, nothing else
  env PROVIDER                 print eval-able NAME=VALUE lines for PROVIDER
  enroll --origin URL          claim this box's control-plane credential
  register                     register broker keys and pin the broker config
  token claude|codex           print the harness login token
  git-helper get|store|erase   answer git's credential protocol on stdin
  watch                        deposit harness logins to the broker as they change`

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
		// Harness logins only. A connection credential comes from `get`, which
		// checks the workspace's allow-list; the two shims below read this one
		// verbatim off stdout.
		if len(args) != 2 || (args[1] != "claude" && args[1] != "codex") {
			return errors.New("usage: blitz-cred token claude|codex")
		}
		token, err := workspace.Token(context.Background(), stateDir, args[1])
		if err != nil {
			return err
		}
		_, err = output.Write(token)
		return err
	case "list":
		if len(args) != 1 {
			return errors.New("list takes no arguments")
		}
		return listConnections(stateDir, output)
	case "get":
		if len(args) != 2 || args[1] == "" {
			return errors.New("usage: blitz-cred get PROVIDER")
		}
		token, err := workspace.MintConnectionToken(context.Background(), stateDir, args[1], nil)
		if err != nil {
			return mintFailure(args[1], err)
		}
		// An agent asks for the token before it commits, so this is the other
		// place the identity can be settled in time.
		workspace.ApplyGitIdentity(context.Background(), stateDir, token.Connection, token.Token, nil)
		_, err = fmt.Fprintln(output, token.Token)
		return err
	case "env":
		if len(args) != 2 || args[1] == "" {
			return errors.New("usage: blitz-cred env PROVIDER")
		}
		token, err := workspace.MintConnectionToken(context.Background(), stateDir, args[1], nil)
		if err != nil {
			return mintFailure(args[1], err)
		}
		workspace.ApplyGitIdentity(context.Background(), stateDir, token.Connection, token.Token, nil)
		return printEnv(output, token)
	case "git-helper":
		if len(args) != 2 {
			return errors.New("usage: blitz-cred git-helper get|store|erase")
		}
		err := workspace.GitHelper(context.Background(), stateDir, args[1], input, output, nil)
		if err == nil {
			return nil
		}
		return mintFailure("github", err)
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

// mintFailure turns a refusal into the one sentence that tells the agent what
// to do next. A bare "403" sent agents into retry loops against a workspace
// that had not been connected to the provider at all, so both refusals name
// the command that puts the question in front of a person.
func mintFailure(provider string, err error) error {
	requested := ""
	if id := workspace.AccessRequestID(err); id != "" {
		requested = fmt.Sprintf(" Request %s is waiting in their connections panel.", id)
	}
	if errors.Is(err, workspace.ErrCredentialDenied) {
		return fmt.Errorf(
			"blitz: this workspace is not connected to %s. Ask the user to connect it, then retry: blitz connections open %s.%s",
			provider, provider, requested,
		)
	}
	if errors.Is(err, workspace.ErrConnectionNotConfigured) {
		return fmt.Errorf(
			"blitz: %s has no credential behind it yet. Ask the user to add one: blitz connections open %s.%s",
			provider, provider, requested,
		)
	}
	return err
}

// printEnv writes lines a shell can eval. The header comment is one line and
// exists because the shape is not guessable: Discord wants `Bot `, a Linear
// personal key wants no prefix at all, and an agent that guesses reads the
// vendor's 401 as "the credential is broken".
func printEnv(output io.Writer, token workspace.ConnectionToken) error {
	first := token.Env
	if len(first) == 0 {
		return fmt.Errorf("blitz: %s declares no environment variables", token.Connection)
	}
	if _, err := fmt.Fprintf(
		output,
		"# send: %s: %s$%s\n",
		token.Header.Name, token.Header.Prefix, first[0].Name,
	); err != nil {
		return err
	}
	for _, entry := range token.Env {
		if _, err := fmt.Fprintf(output, "%s=%s\n", entry.Name, shellQuote(entry.Value)); err != nil {
			return err
		}
	}
	return nil
}

// shellQuote makes one value safe to eval. A provider base URL and a token are
// both opaque strings from a vendor, so neither may be pasted into a shell
// word unquoted.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

// listConnections answers "what may I use here?" with a live read, never a
// cached file. Nothing is delivered to this box any more, so the only honest
// source is the control plane's copy of the workspace manifest.
func listConnections(stateDir string, output io.Writer) error {
	names, err := workspace.ListConnections(context.Background(), stateDir, nil)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		_, err := fmt.Fprintln(output, "no connections; ask the user to connect one: blitz connections open <provider>")
		return err
	}
	for _, name := range names {
		if _, err := fmt.Fprintln(output, name); err != nil {
			return err
		}
	}
	return nil
}
