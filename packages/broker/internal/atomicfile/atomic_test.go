package atomicfile

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestWritePreservingOwnership(t *testing.T) {
	t.Run("same uid and gid", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state")
		if err := os.WriteFile(path, []byte("old\n"), 0o640); err != nil {
			t.Fatal(err)
		}
		before := ownership(t, path)

		if err := WritePreservingOwnership(path, []byte("new\n"), 0o600); err != nil {
			t.Fatal(err)
		}

		after := ownership(t, path)
		if after != before {
			t.Fatalf("ownership changed from %v to %v", before, after)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Fatalf("mode = %o, want 600", got)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(content); got != "new\n" {
			t.Fatalf("content = %q, want %q", got, "new\n")
		}
	})

	t.Run("root keeps different owner", func(t *testing.T) {
		if os.Geteuid() != 0 {
			t.Skip("requires root")
		}
		path := filepath.Join(t.TempDir(), "credential")
		if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chown(path, 1000, 1000); err != nil {
			t.Fatal(err)
		}

		if err := WritePreservingOwnership(path, []byte("rotated\n"), 0o600); err != nil {
			t.Fatal(err)
		}

		if got := ownership(t, path); got != [2]uint32{1000, 1000} {
			t.Fatalf("ownership = %v, want [1000 1000]", got)
		}
	})
}

func ownership(t *testing.T, path string) [2]uint32 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// SAFETY: os.Stat returns syscall.Stat_t on every platform supported by the
	// broker's Unix-only file ownership contract.
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatalf("unexpected stat type %T", info.Sys())
	}
	return [2]uint32{stat.Uid, stat.Gid}
}
