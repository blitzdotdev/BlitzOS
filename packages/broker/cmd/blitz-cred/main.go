package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

  enroll --origin URL          claim this box's control-plane credential
  register                     register broker keys and pin the broker config
  token INTEGRATION            mint INTEGRATION's credential into creds/env.d
  sync                         refresh every connected credential in creds/env.d
  list                         show connected providers and the variables they export
  git-helper get|store|erase   answer git's credential protocol on stdin
  watch                        deposit harness logins to the broker as they change`

// mintSummaryFormat replaces the bare expiry `token` used to print. The epoch
// number read as the token itself, and nothing on that line said either that
// the values were already in the environment or that the next call revokes this
// lease. Values are never printed: they are already placed.
const mintSummaryFormat = `%s
env: %s
expires: %s
written to creds/env.d, already set in new login shells and agent tabs
each 'blitz-cred token' call mints a new lease and revokes the one before it, so a token exported into an earlier shell stops working
`

// exportLine is the exact shape environmentFile writes into creds/env.d:
// `export NAME='<shell-quoted value>'`. Only the name is captured. Every other
// line — an `unset`, or a line from inside a value that contains a newline — is
// skipped, so no part of a value can surface as if it were a name.
var exportLine = regexp.MustCompile(`^export ([A-Za-z_][A-Za-z0-9_]*)='`)

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
		return printMintSummary(output, result)
	case "sync":
		if len(args) != 1 {
			return errors.New("sync takes no arguments")
		}
		return workspace.Sync(context.Background(), stateDir, nil)
	case "list":
		if len(args) != 1 {
			return errors.New("list takes no arguments")
		}
		return listConnections(stateDir, output)
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

// printMintSummary reports what a mint placed, never what it placed there. The
// harness verbs (`token claude`, `token codex`) do not come through here: their
// stdout is consumed verbatim by the PATH shims.
func printMintSummary(output io.Writer, result workspace.MintResult) error {
	names := make([]string, 0, len(result.Placements))
	for _, placement := range result.Placements {
		if placement.Kind == "env" {
			names = append(names, placement.Name)
		}
	}
	expires := time.UnixMilli(result.ExpiresAt).UTC().Format(time.RFC3339)
	_, err := fmt.Fprintf(output, mintSummaryFormat, result.Integration, joinNames(names), expires)
	return err
}

// listConnections answers "what am I connected to?" without printing a secret:
// the provider names are the creds/env.d file names and the variable names come
// off the export prefix. The workspace's own entry is listed and labelled
// rather than hidden — an agent asking where a variable came from needs the
// whole environment in one answer — and it is not counted as a connection.
func listConnections(stateDir string, output io.Writer) error {
	envDir := workspace.EnvironmentDir(stateDir)
	entries, err := os.ReadDir(envDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	connections := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".sh" {
			continue
		}
		names, err := exportedNames(filepath.Join(envDir, entry.Name()))
		if err != nil {
			return err
		}
		label := strings.TrimSuffix(entry.Name(), ".sh")
		if entry.Name() == workspace.WorkspaceEnvironmentFile {
			label = "workspace variables (not a connection)"
		} else {
			connections++
		}
		if _, err := fmt.Fprintf(output, "%s: %s\n", label, joinNames(names)); err != nil {
			return err
		}
	}
	if connections == 0 {
		_, err := fmt.Fprintln(output, "nothing connected yet")
		return err
	}
	return nil
}

func exportedNames(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, line := range strings.Split(string(data), "\n") {
		if match := exportLine.FindStringSubmatch(line); match != nil {
			names = append(names, match[1])
		}
	}
	return names, nil
}

func joinNames(names []string) string {
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}
