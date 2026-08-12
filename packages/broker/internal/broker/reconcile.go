package broker

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/blitzdotdev/blitz-core/broker/internal/feed"
)

type Reconciler struct {
	StateDir          string
	AuthorizedKeysDir string
	Accounts          Accounts
}

func (r Reconciler) Reconcile(current Feed) error {
	if r.Accounts == nil {
		r.Accounts = SystemAccounts{}
	}
	if err := os.MkdirAll(filepath.Join(r.StateDir, "members"), 0o755); err != nil {
		return err
	}
	managed, err := r.managedNames()
	if err != nil {
		return err
	}
	wanted := make(map[string]bool)
	var failures []error
	for _, member := range current.Members {
		wanted[member.UnixName] = true
		home := filepath.Join(r.StateDir, "members", member.UnixName)
		if err := r.Accounts.Ensure(member.UnixName, home); err != nil {
			failures = append(failures, err)
			continue
		}
		if _, err := RenderAuthorizedKeys(r.AuthorizedKeysDir, member); err != nil {
			failures = append(failures, err)
		}
	}
	for name := range managed {
		if wanted[name] || current.Preserve[name] || !feed.ValidUnixName(name) {
			continue
		}
		if _, err := RenderAuthorizedKeys(r.AuthorizedKeysDir, Member{UnixName: name, Harnesses: []string{}, Keys: []Key{}}); err != nil {
			failures = append(failures, err)
			continue
		}
		home := filepath.Join(r.StateDir, "members", name)
		if err := r.Accounts.Deprovision(name, home); err != nil {
			failures = append(failures, err)
			continue
		}
		if err := os.Remove(filepath.Join(r.AuthorizedKeysDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (r Reconciler) managedNames() (map[string]bool, error) {
	result := make(map[string]bool)
	for _, dir := range []string{filepath.Join(r.StateDir, "members"), r.AuthorizedKeysDir} {
		entries, err := os.ReadDir(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			result[entry.Name()] = true
		}
	}
	return result, nil
}
