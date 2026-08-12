package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"github.com/blitzdotdev/blitz-core/broker/internal/broker"
	"github.com/blitzdotdev/blitz-core/broker/internal/controlplane"
	"github.com/blitzdotdev/blitz-core/broker/internal/enroll"
	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
	"github.com/blitzdotdev/blitz-core/broker/internal/store"
	"github.com/blitzdotdev/blitz-core/broker/internal/vendor"
)

const defaultStateDir = "/var/lib/blitz-broker"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer, input io.Reader) error {
	if len(args) == 0 {
		return errors.New("usage: blitz-broker enroll|sync|mint|deposit")
	}
	stateDir := os.Getenv("BLITZ_STATE_DIR")
	if stateDir == "" {
		stateDir = defaultStateDir
	}
	switch args[0] {
	case "enroll":
		return runEnroll(args[1:], stateDir, output)
	case "sync":
		if len(args) != 1 {
			return errors.New("sync takes no arguments")
		}
		return broker.Sync(context.Background(), stateDir, nil)
	case "mint":
		return runMint(args[1:], output)
	case "deposit":
		return runDeposit(args[1:], output, input)
	default:
		return errors.New("unknown blitz-broker command")
	}
}

func runEnroll(args []string, stateDir string, output io.Writer) error {
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("enroll", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	origin := flags.String("origin", "", "control-plane origin")
	host := flags.String("host", hostname, "advertised SSH host")
	port := flags.Int("port", 22, "advertised SSH port")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *origin == "" {
		return errors.New("usage: blitz-broker enroll --origin URL [--host H] [--port N]")
	}
	if *host == "" || strings.ContainsAny(*host, " \t\r\n") || *port < 1 || *port > 65535 {
		return errors.New("invalid advertised broker address")
	}
	if _, err := enroll.Run(context.Background(), stateDir, *origin, "blitz-broker", output, nil); err != nil {
		return err
	}
	hostKeyData, err := os.ReadFile(filepath.Join(stateDir, "ssh", "ssh_host_ed25519_key.pub"))
	if err != nil {
		return errors.New("broker SSH host public key is unavailable")
	}
	hostKey := strings.TrimSpace(string(hostKeyData))
	if !feed.ValidPublicKey(hostKey) {
		return errors.New("broker SSH host public key is invalid")
	}
	storedOrigin, err := store.LoadOrigin(stateDir)
	if err != nil {
		return err
	}
	client, err := controlplane.New(storedOrigin, stateDir, nil)
	if err != nil {
		return err
	}
	return client.RegisterBroker(context.Background(), *host, *port, hostKey)
}

func runMint(args []string, output io.Writer) error {
	_, allowed, definition, home, err := forcedCommand(args)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	token, err := broker.Mint(ctx, home, allowed, definition.Name, definition, nil)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(output, token)
	return err
}

func runDeposit(args []string, output io.Writer, input io.Reader) error {
	_, _, definition, home, err := forcedCommand(args)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	if err := broker.Deposit(ctx, home, definition, input, nil); err != nil {
		return err
	}
	_, err = io.WriteString(output, "ok\n")
	return err
}

func forcedCommand(args []string) (string, []string, vendor.Definition, string, error) {
	if len(args) != 2 || os.Getenv("SSH_CONNECTION") == "" {
		return "", nil, vendor.Definition{}, "", errors.New("command is restricted to forced-command SSH")
	}
	member := args[0]
	if !feed.ValidUnixName(member) {
		return "", nil, vendor.Definition{}, "", errors.New("invalid forced-command member")
	}
	allowed, err := parseAllowlist(args[1])
	if err != nil {
		return "", nil, vendor.Definition{}, "", err
	}
	requested := os.Getenv("SSH_ORIGINAL_COMMAND")
	definition, err := vendor.Lookup(requested)
	if err != nil || !contains(allowed, requested) {
		return "", nil, vendor.Definition{}, "", errors.New("requested harness is not allowed")
	}
	current, err := user.Current()
	if err != nil || current.Username != member {
		return "", nil, vendor.Definition{}, "", errors.New("forced-command Unix user mismatch")
	}
	account, err := user.Lookup(member)
	if err != nil {
		return "", nil, vendor.Definition{}, "", errors.New("forced-command member does not exist")
	}
	return member, allowed, definition, account.HomeDir, nil
}

func parseAllowlist(raw string) ([]string, error) {
	if raw == "-" {
		return []string{}, nil
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]bool)
	for _, part := range parts {
		if !feed.ValidHarness(part) || seen[part] {
			return nil, errors.New("invalid forced-command harness allowlist")
		}
		seen[part] = true
	}
	return parts, nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
