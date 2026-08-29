package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

  list                         providers and workspace credentials, one per line
  get PROVIDER                 print PROVIDER's token on stdout, nothing else
  env PROVIDER                 print eval-able NAME=VALUE lines for PROVIDER
  import [--check] FILE|-      store each KEY=value line as a workspace credential
  put NAME [--comment TEXT]    store one workspace credential; value on stdin
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
	case "import":
		flags := flag.NewFlagSet("import", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		check := flags.Bool("check", false, "parse and report, store nothing")
		label := flags.String("label", "", "label stored on every imported key")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 1 {
			return errors.New("usage: blitz-cred import [--check] [--label TEXT] FILE|-")
		}
		text, name, err := readImportSource(flags.Arg(0), input)
		if err != nil {
			return err
		}
		if *label == "" {
			*label = name
		}
		result, err := workspace.ImportCredentials(
			context.Background(), stateDir, text, *label, *check, nil,
		)
		if err != nil {
			return importFailure(err)
		}
		return printImport(output, result, *check)
	case "put":
		flags := flag.NewFlagSet("put", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		label := flags.String("label", "", "provenance label")
		comment := flags.String("comment", "", "what this key is for, shown by list")
		// The name reads naturally before the flags (`put NAME --comment ...`),
		// and Go's flag parser stops at the first positional — so the name is
		// lifted out before the flags are read, and either order works.
		rest := args[1:]
		name := ""
		if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
			name = rest[0]
			rest = rest[1:]
		}
		usage := errors.New(`usage: printf '%s' "$VALUE" | blitz-cred put NAME [--label TEXT] [--comment TEXT]`)
		if err := flags.Parse(rest); err != nil {
			return usage
		}
		if name == "" && flags.NArg() == 1 {
			name = flags.Arg(0)
		} else if flags.NArg() != 0 {
			return usage
		}
		if name == "" {
			return usage
		}
		data, err := io.ReadAll(io.LimitReader(input, 64*1024))
		if err != nil {
			return err
		}
		value := strings.TrimSuffix(strings.TrimSuffix(string(data), "\n"), "\r")
		if err := workspace.PutCredential(
			context.Background(), stateDir, name, value, *label, *comment, nil,
		); err != nil {
			return importFailure(err)
		}
		_, err = fmt.Fprintf(output, "stored    %s\n", name)
		return err
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

// readImportSource reads the dotenv text and names it: the file's base name
// becomes the default label, so an imported key remembers where it came from.
// `-` reads stdin and labels nothing, because a pipe has no name worth keeping.
func readImportSource(path string, input io.Reader) (text, name string, err error) {
	if path == "-" {
		data, err := io.ReadAll(io.LimitReader(input, 1<<20))
		return string(data), "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}
	return string(data), filepath.Base(path), nil
}

// importFailure names the person who can fix the refusal, in the same voice
// as mintFailure: an agent that reads "403" retries, an agent that reads a
// sentence asks the right human.
func importFailure(err error) error {
	if errors.Is(err, workspace.ErrNotWorkspaceAdmin) {
		return errors.New(
			"blitz: only a workspace admin can write workspace credentials. Ask an admin to run this, or to change your role",
		)
	}
	return err
}

// printImport writes one line per key and a closing count. Outcomes only —
// a value never appears on stdout, which is the whole point of moving it out
// of a file.
func printImport(output io.Writer, result workspace.CredentialImport, check bool) error {
	counts := map[string]int{}
	for _, entry := range result.Results {
		counts[entry.Outcome]++
		line := fmt.Sprintf("%-10s%s", entry.Outcome, entry.Name)
		if entry.Reason != "" {
			line = fmt.Sprintf("%s  (line %d: %s)", line, entry.Line, entry.Reason)
		}
		if _, err := fmt.Fprintln(output, line); err != nil {
			return err
		}
	}
	summary := fmt.Sprintf("%d lines read", result.LinesRead)
	for _, outcome := range []string{"stored", "rotated", "unchanged", "refused"} {
		if counts[outcome] > 0 {
			summary += fmt.Sprintf(", %d %s", counts[outcome], outcome)
		}
	}
	if check {
		summary += " (check only, nothing was written)"
	}
	_, err := fmt.Fprintln(output, summary)
	return err
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
//
// A workspace credential that carries a comment prints it after a `#`, so an
// agent picking a key reads what each one is for. The comment read is
// best-effort: a control plane too old to serve it costs the comments, never
// the list.
func listConnections(stateDir string, output io.Writer) error {
	names, err := workspace.ListConnections(context.Background(), stateDir, nil)
	if err != nil {
		return err
	}
	if len(names) == 0 {
		_, err := fmt.Fprintln(output, "no connections; ask the user to connect one: blitz connections open <provider>")
		return err
	}
	comments := map[string]string{}
	if credentials, err := workspace.ListCredentials(context.Background(), stateDir, nil); err == nil {
		for _, credential := range credentials {
			if credential.Comment != "" {
				comments[credential.Name] = credential.Comment
			}
		}
	}
	for _, name := range names {
		line := name
		if comment := comments[name]; comment != "" {
			line = fmt.Sprintf("%s  # %s", name, comment)
		}
		if _, err := fmt.Fprintln(output, line); err != nil {
			return err
		}
	}
	return nil
}
