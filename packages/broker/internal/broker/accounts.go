package broker

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
)

type Accounts interface {
	Ensure(string, string) error
	Deprovision(string, string) error
}

type SystemAccounts struct {
	lookupUser  func(string) (*user.User, error)
	lookupGroup func(string) (*user.Group, error)
	run         func(string, ...string) error
	lchown      func(string, int, int) error
}

func (accounts SystemAccounts) Ensure(name, home string) error {
	lookupUser := accounts.lookupUser
	if lookupUser == nil {
		lookupUser = user.Lookup
	}
	lookupGroup := accounts.lookupGroup
	if lookupGroup == nil {
		lookupGroup = user.LookupGroup
	}
	run := accounts.run
	if run == nil {
		run = runSystem
	}
	lchown := accounts.lchown
	if lchown == nil {
		lchown = os.Lchown
	}

	account, err := lookupUser(name)
	if errors.Is(err, user.UnknownUserError(name)) {
		args := []string{"--create-home", "--home-dir", home, "--shell", "/bin/sh"}
		expectedGID := ""
		group, groupErr := lookupGroup(name)
		switch {
		case groupErr == nil:
			expectedGID = group.Gid
			gid, parseErr := strconv.Atoi(expectedGID)
			if parseErr != nil || gid < 0 {
				return fmt.Errorf("managed group %s has invalid GID", name)
			}
			args = append(args, "--gid", expectedGID)
		case errors.Is(groupErr, user.UnknownGroupError(name)):
		default:
			return groupErr
		}
		args = append(args, "--", name)
		if err := run("useradd", args...); err != nil {
			return err
		}
		account, err = lookupUser(name)
		if err == nil && expectedGID != "" && account.Gid != expectedGID {
			return fmt.Errorf("managed user %s has unexpected primary group", name)
		}
	}
	if err != nil {
		return err
	}
	if account.HomeDir != home {
		return fmt.Errorf("managed user %s has unexpected home", name)
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(home, 0o700); err != nil {
		return err
	}
	return filepath.WalkDir(home, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return lchown(path, uid, gid)
	})
}

func (SystemAccounts) Deprovision(name, home string) error {
	if err := runAllowNoMatch("pkill", "-KILL", "-u", name); err != nil {
		return err
	}
	if err := processCheck(name); err != nil {
		return err
	}
	if _, err := user.Lookup(name); err == nil {
		if err := runSystem("userdel", "--remove", "--", name); err != nil {
			return err
		}
	} else if !errors.Is(err, user.UnknownUserError(name)) {
		return err
	}
	return os.RemoveAll(home)
}

func processCheck(name string) error {
	cmd := exec.Command("pkill", "-0", "-u", name)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	err := cmd.Run()
	if err == nil {
		return fmt.Errorf("processes remain for %s", name)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return nil
	}
	return errors.New("could not verify member processes stopped")
}

func runAllowNoMatch(command string, args ...string) error {
	err := runSystem(command, args...)
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 1 {
		return nil
	}
	return err
}

func runSystem(command string, args ...string) error {
	cmd := exec.Command(command, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", command, err)
	}
	return nil
}
