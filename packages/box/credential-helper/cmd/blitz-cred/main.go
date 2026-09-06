package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/blitzdotdev/blitz-core/box/credential-helper/internal/workspace"
)

const usageText = `usage: blitz-cred COMMAND

  api-token                    print a current control-plane bearer
  help                         print this help`

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, output io.Writer) error {
	if len(args) == 0 {
		return errors.New(usageText)
	}
	switch args[0] {
	case "--help", "-h", "help":
		if len(args) != 1 {
			return errors.New("help takes no arguments")
		}
		_, err := fmt.Fprintln(output, usageText)
		return err
	case "api-token":
		if len(args) != 1 {
			return errors.New("api-token takes no arguments")
		}
		stateDir := os.Getenv("BLITZ_STATE_DIR")
		if stateDir == "" {
			return errors.New("BLITZ_STATE_DIR is required")
		}
		token, err := workspace.APIToken(context.Background(), stateDir, nil)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, token)
		return err
	default:
		return errors.New("unknown blitz-cred command")
	}
}
