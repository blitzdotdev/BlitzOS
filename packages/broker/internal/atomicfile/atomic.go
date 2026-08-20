package atomicfile

import (
	"fmt"
	"os"
	"path/filepath"
)

// Write replaces path atomically, leaving ownership to whatever the calling
// process would create.
func Write(path string, data []byte, mode os.FileMode) error {
	return WriteOwned(path, data, mode, -1, -1)
}

// WriteOwned is Write with the ownership set BEFORE the rename, so the file is
// never visible at its final path owned by the wrong user. Chowning after the
// rename leaves a window in which the real path holds real content under the
// creating process's ownership — small, but this is a credential directory and
// the reader on the other side is sshd.
//
// Pass -1, -1 to leave ownership alone, exactly as os.Chown defines it.
func WriteOwned(path string, data []byte, mode os.FileMode, uid, gid int) (err error) {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return fmt.Errorf("create temporary file: %w", err)
	}
	tempName := temp.Name()
	defer temp.Close()
	defer os.Remove(tempName)
	// Mode before content: the temporary file never holds bytes at a wider
	// mode than the caller asked for, whatever the umask is.
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
	// The rename is only durable once the DIRECTORY entry is on disk. Without
	// this a crash can leave the old name pointing at nothing.
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
