package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/blitzdotdev/blitz-core/broker/internal/atomicfile"
)

// The codex block is written between markers so a re-register replaces exactly
// our lines and touches nothing the member wrote.
//
// TWO regions, not one, because TOML is position-sensitive: a bare key after a
// [table] header belongs to that table. The bare `model_provider` therefore has
// to go at the TOP of the file and the provider tables at the BOTTOM. A single
// region would swallow the member's own settings between them.
const (
	codexHeadBegin = "# BEGIN blitz-broker (top-level keys)"
	codexHeadEnd   = "# END blitz-broker (top-level keys)"
	codexTailBegin = "# BEGIN blitz-broker (provider)"
	codexTailEnd   = "# END blitz-broker (provider)"

	// codexAuthCommand takes no arguments: codex passes none to the command it
	// finds here, so the harness has to be in the name.
	codexAuthCommand = "/usr/local/bin/blitz-cred-codex"

	// codexRefreshInterval is how often codex re-runs that command, in
	// milliseconds. Five minutes: well inside the shortest access-token life
	// of the two harnesses, so a long-running session never reaches the
	// vendor with a token that died under it.
	codexRefreshInterval = 300000

	codexConfigPath = ".codex/config.toml"
)

const codexHead = codexHeadBegin + `
# Managed by blitz-cred register; edits between the markers are lost.
model_provider = "blitz"
` + codexHeadEnd

const codexTail = codexTailBegin + `
[model_providers.blitz]
name = "BlitzOS credential broker"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"

[model_providers.blitz.auth]
command = "` + codexAuthCommand + `"
refresh_interval_ms = 300000
` + codexTailEnd

// wireHarnesses points the vendor CLIs at the broker.
//
// Claude gets NOTHING written here, deliberately. The broker mints an OAuth
// access token (`sk-ant-oat01-…`), which reaches claude as
// CLAUDE_CODE_OAUTH_TOKEN — exported by the PATH shim for terminals and set in
// options.env by the actor for chat. There is no config file in that path, and
// there must not be one: `apiKeyHelper` is the API-KEY hook, it rejects an
// OAuth token outright, and a managed apiKeyHelper does not lose to a valid
// CLAUDE_CODE_OAUTH_TOKEN — with both set, claude hangs. Deleting
// /etc/claude-code/managed-settings.json is the root half of this, done by the
// box's register unit before it drops privileges.
//
// Codex is the opposite: it has a real pull hook in its own config, so it
// fetches its own token every refresh_interval_ms and never needs a file
// written down.
func wireHarnesses(home string) error {
	return writeCodexConfig(filepath.Join(home, filepath.FromSlash(codexConfigPath)), true)
}

// unwireHarnesses removes the broker's lines when there is no broker to point
// at. Leaving them would send codex to a helper that cannot mint, which fails
// slowly and looks like a broken account rather than an unconfigured one.
func unwireHarnesses(home string) error {
	err := writeCodexConfig(filepath.Join(home, filepath.FromSlash(codexConfigPath)), false)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func writeCodexConfig(path string, wire bool) error {
	existing, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err != nil && !wire {
		// Nothing to strip and nothing to create.
		return os.ErrNotExist
	}
	body := stripMarkedRegions(string(existing))
	if wire {
		// A second top-level model_provider would be a duplicate-key parse
		// error, so drop the member's own — but only the assignments BEFORE
		// the first [table] header, which are the only top-level ones.
		body = dropTopLevelModelProvider(body)
	}
	body = strings.Trim(body, "\n")

	var rendered string
	switch {
	case wire && body != "":
		rendered = codexHead + "\n" + body + "\n" + codexTail + "\n"
	case wire:
		rendered = codexHead + "\n" + codexTail + "\n"
	case body == "":
		// The file held nothing but our block. Remove it rather than leaving
		// an empty config for codex to parse.
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	default:
		rendered = body + "\n"
	}
	if string(existing) == rendered {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(path, []byte(rendered), 0o600)
}

// stripMarkedRegions removes every marked region, including a duplicate left
// by an interrupted earlier write.
func stripMarkedRegions(content string) string {
	for _, marker := range [][2]string{{codexHeadBegin, codexHeadEnd}, {codexTailBegin, codexTailEnd}} {
		for {
			start := strings.Index(content, marker[0])
			if start < 0 {
				break
			}
			end := strings.Index(content[start:], marker[1])
			if end < 0 {
				// An unterminated marker: everything from it on is ours, and
				// leaving half a block would be a parse error.
				content = content[:start]
				break
			}
			after := start + end + len(marker[1])
			if after < len(content) && content[after] == '\n' {
				after++
			}
			content = content[:start] + content[after:]
		}
	}
	return content
}

func dropTopLevelModelProvider(content string) string {
	lines := strings.Split(content, "\n")
	kept := make([]string, 0, len(lines))
	inTable := false
	for _, line := range lines {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "[") {
			inTable = true
		}
		if !inTable && isModelProviderAssignment(trimmed) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func isModelProviderAssignment(trimmed string) bool {
	const key = "model_provider"
	if !strings.HasPrefix(trimmed, key) {
		return false
	}
	return strings.HasPrefix(strings.TrimLeft(trimmed[len(key):], " \t"), "=")
}
