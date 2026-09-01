package workspace

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
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

	codexManagedNote = "# Managed by blitz-cred register; edits between the markers are lost."

	// codexPreservedPrefix carries the member's own top-level model_provider
	// across the window in which the broker owns that key.
	//
	// A COMMENT, inside the marked region, because nothing else survives the
	// round trip. The value cannot stay a live key — a second top-level
	// model_provider is a duplicate-key parse error and codex refuses the whole
	// file — and it cannot live outside the region, because stripMarkedRegions
	// would leave it behind and the next wire would find two. Inside the region
	// it is deleted and re-emitted with the block it belongs to, it parses as
	// nothing at all, and a member reading their own config can see exactly
	// which setting the broker is standing in for and what it will get back.
	codexPreservedPrefix = "# blitz-broker preserved: "
)

const (
	codexHeadPrologue = codexHeadBegin + "\n" + codexManagedNote + "\n"
	codexHeadEpilogue = `model_provider = "blitz"` + "\n" + codexHeadEnd
	codexHead         = codexHeadPrologue + codexHeadEpilogue
)

// codexTail interpolates codexRefreshInterval rather than repeating it. The
// literal used to be written out here as well, so the constant above documented
// a value it did not control and tuning it changed nothing on disk.
var codexTail = codexTailBegin + `
[model_providers.blitz]
name = "BlitzOS credential broker"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"

[model_providers.blitz.auth]
command = "` + codexAuthCommand + `"
refresh_interval_ms = ` + strconv.Itoa(codexRefreshInterval) + `
` + codexTailEnd

// wireHarnesses points the vendor CLIs at the broker.
//
// Claude gets NOTHING written here, deliberately. The broker mints an OAuth
// access token (`sk-ant-oat01-…`), which reaches claude as
// CLAUDE_CODE_OAUTH_TOKEN — exported by the PATH shim for terminals, or set
// directly by an embedding caller. There is no config file in that path, and
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
// at, and gives the member back the model_provider wiring took from them.
// Leaving the block would send codex to a helper that cannot mint, which fails
// slowly and looks like a broken account rather than an unconfigured one; not
// restoring the member's own key would leave a box that landed in
// no_broker_capacity running codex on its default provider, with the setting
// the member chose deleted and nothing anywhere recording that it existed.
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
	// The member's own model_provider, from whichever of the two places holds
	// it: a live top-level assignment on a file this has never touched, or the
	// preserved comment inside our own head region on every wire after the
	// first. A live assignment wins, because it is the member overruling us and
	// it is the line about to be deleted; on a re-wire there is none, so the
	// preserved comment carries the value forward and the render is unchanged.
	preserved := preservedModelProvider(string(existing))
	body := stripMarkedRegions(string(existing))
	own := topLevelModelProvider(body)
	switch {
	case wire:
		if own != "" {
			preserved = own
		}
		// A second top-level model_provider would be a duplicate-key parse
		// error, so drop the member's own — but only the assignments BEFORE
		// the first [table] header, which are the only top-level ones.
		body = dropTopLevelModelProvider(body)
	case own == "" && preserved != "":
		// Back at the top, above every [table] header, because that is the only
		// position where a bare key is top-level again. A file that already
		// carries a live one gets nothing back: that line is the member's, it is
		// already where it belongs, and a second would be the duplicate-key
		// parse error this whole dance exists to avoid.
		body = preserved + "\n" + body
	}
	body = strings.Trim(body, "\n")

	head := codexHeadRegion(preserved)
	var rendered string
	switch {
	case wire && body != "":
		rendered = head + "\n" + body + "\n" + codexTail + "\n"
	case wire:
		rendered = head + "\n" + codexTail + "\n"
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

// codexHeadRegion renders the head region, carrying the member's own
// model_provider as a comment when there is one to carry. An empty value emits
// the plain region: a file that never had a top-level model_provider must not
// come back from an unwire with one this code invented.
func codexHeadRegion(preserved string) string {
	if preserved == "" {
		return codexHead
	}
	return codexHeadPrologue + codexPreservedPrefix + preserved + "\n" + codexHeadEpilogue
}

// preservedModelProvider reads back the line codexHeadRegion wrote.
//
// It looks only INSIDE the head region. A member who writes the same comment
// somewhere else in their file has written a comment, and reading it would make
// the value survive a strip it was never part of.
func preservedModelProvider(content string) string {
	start := strings.Index(content, codexHeadBegin)
	if start < 0 {
		return ""
	}
	region := content[start:]
	if end := strings.Index(region, codexHeadEnd); end >= 0 {
		region = region[:end]
	}
	for _, line := range strings.Split(region, "\n") {
		if value, found := strings.CutPrefix(strings.TrimLeft(line, " \t"), codexPreservedPrefix); found {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// topLevelModelProvider returns the first assignment dropTopLevelModelProvider
// would delete, trimmed. The two read the file the same way on purpose: a key
// this reports and that one leaves behind would be preserved AND kept, which is
// the duplicate-key parse error the whole two-region layout exists to avoid.
func topLevelModelProvider(content string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimLeft(line, " \t")
		if strings.HasPrefix(trimmed, "[") {
			return ""
		}
		if isModelProviderAssignment(trimmed) {
			return strings.TrimSpace(trimmed)
		}
	}
	return ""
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
