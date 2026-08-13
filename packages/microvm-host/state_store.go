package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

var vmIDPattern = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)

type StateStore struct {
	dir string
}

func NewStateStore(stateDir string) *StateStore {
	return &StateStore{dir: filepath.Join(stateDir, "vms")}
}

func (s *StateStore) Ensure() error {
	return os.MkdirAll(s.dir, 0700)
}

func (s *StateStore) Load() (map[string]*VM, error) {
	if err := s.Ensure(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	vms := make(map[string]*VM)
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(s.dir, entry.Name()))
		if err != nil {
			return nil, err
		}
		var vm VM
		if err := json.Unmarshal(b, &vm); err != nil {
			return nil, fmt.Errorf("decode state %s: %w", entry.Name(), err)
		}
		if !vmIDPattern.MatchString(vm.VMID) || vm.VMID+".json" != entry.Name() {
			return nil, fmt.Errorf("invalid VM identity in %s", entry.Name())
		}
		copyVM := vm
		vms[vm.VMID] = &copyVM
	}
	return vms, nil
}

func (s *StateStore) Save(vm *VM) error {
	if !vmIDPattern.MatchString(vm.VMID) {
		return fmt.Errorf("invalid VM ID")
	}
	if err := s.Ensure(); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".vm-state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(vm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, filepath.Join(s.dir, vm.VMID+".json")); err != nil {
		return err
	}
	return syncDir(s.dir)
}

func (s *StateStore) Delete(vmID string) error {
	if !vmIDPattern.MatchString(vmID) {
		return fmt.Errorf("invalid VM ID")
	}
	err := os.Remove(filepath.Join(s.dir, vmID+".json"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDir(s.dir)
}

func syncDir(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
