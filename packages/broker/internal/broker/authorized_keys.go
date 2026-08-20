package broker

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
)

const brokerBinary = "/usr/local/bin/blitz-broker"

func RenderAuthorizedKeys(dir string, member Member) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		return "", err
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(dir, 0, 0); err != nil {
			return "", err
		}
	}
	path := filepath.Join(dir, member.UnixName)
	// Root-owned BEFORE the rename, not after. sshd refuses to read an
	// authorized_keys file it does not trust the ownership of, and a window in
	// which the real path is live under the wrong owner is a window in which a
	// member either cannot log in or — worse, if the directory were ever
	// member-writable — could rewrite their own forced command.
	owner := -1
	if os.Geteuid() == 0 {
		owner = 0
	}
	if err := atomicfile.WriteOwned(path, authorizedKeys(member), 0o644, owner, owner); err != nil {
		return "", err
	}
	return path, nil
}

func authorizedKeys(member Member) []byte {
	harnesses := append([]string(nil), member.Harnesses...)
	sort.Strings(harnesses)
	allowlist := strings.Join(harnesses, ",")
	if allowlist == "" {
		allowlist = "-"
	}
	keys := append([]Key(nil), member.Keys...)
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Op == keys[j].Op {
			return keys[i].Pubkey < keys[j].Pubkey
		}
		return keys[i].Op < keys[j].Op
	})
	var rendered strings.Builder
	for _, key := range keys {
		fmt.Fprintf(&rendered, "restrict,command=\"%s %s %s %s\" %s\n", brokerBinary, key.Op, member.UnixName, allowlist, key.Pubkey)
	}
	return []byte(rendered.String())
}
