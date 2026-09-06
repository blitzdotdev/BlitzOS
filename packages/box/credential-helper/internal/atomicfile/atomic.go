package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// WritePreservingOwnership replaces path atomically while retaining the owner
// of an existing target. A new target keeps the caller's default ownership.
func WritePreservingOwnership(path string, data []byte, mode os.FileMode) error {
	uid, gid := -1, -1
	info, err := os.Stat(path)
	if err == nil {
		// SAFETY: os.Stat returns the platform's syscall.Stat_t on supported Unix
		// systems. Refuse the write if that invariant does not hold.
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("read existing ownership: unexpected stat type %T", info.Sys())
		}
		uid, gid = int(stat.Uid), int(stat.Gid)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat existing file: %w", err)
	}
	return writeOwned(path, data, mode, uid, gid)
}

func writeOwned(path string, data []byte, mode os.FileMode, uid, gid int) (err error) {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tempName := temp.Name()
	defer temp.Close()
	defer os.Remove(tempName)
	if err = temp.Chmod(mode); err != nil {
		return err
	}
	if uid >= 0 || gid >= 0 {
		if err = temp.Chown(uid, gid); err != nil {
			return err
		}
	}
	if _, err = temp.Write(data); err != nil {
		return err
	}
	if err = temp.Sync(); err != nil {
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tempName, path); err != nil {
		return err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
