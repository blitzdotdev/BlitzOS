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

type SystemAccounts struct{}

func (SystemAccounts) Ensure(name, home string) error {
	account, err := user.Lookup(name)
	if errors.Is(err, user.UnknownUserError(name)) {
		if err := runSystem("useradd", "--create-home", "--home-dir", home, "--shell", "/bin/sh", "--", name); err != nil {
			return err
		}
		account, err = user.Lookup(name)
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
		return os.Lchown(path, uid, gid)
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
