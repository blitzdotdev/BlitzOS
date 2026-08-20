# Agent-rules fixtures

`limits.json` is not an envelope fixture: it is the single definition of the one
size limit both runtimes enforce, the UTF-8 **byte** length of `content` after
parsing. The control plane refuses to store more (`parsePutAgentRule`) and the
box refuses to install more (`blitz-rules sync`), so a document either side
accepts is a document the other accepts. Both measure `content`, never the JSON
envelope around it: escaping can expand a legal document several times over, and
`String#length` counts UTF-16 units rather than bytes. The envelope caps on both
sides are memory rails set well above this number.


The control plane serves the managed agent rules to a box at
`GET /workspaces/self/agent-rules` (box-authenticated). The response body is the
envelope `{ "version": <string>, "content": <string> }`, where `content` is the
canonical rule document and `version` is its content hash. The producer is
`packages/control-plane/core/agent-rules.ts` (`AGENT_RULES_DOC` /
`AGENT_RULES_VERSION`), whose bytes are pinned to the box-image source of truth
`packages/box/rootfs/opt/blitz/skel/agent-rules.md` by
`packages/control-plane/test/agent-rules-drift.test.ts`.

Each fixture pairs a candidate response body (`response`) with whether the box
consumer must accept it (`accepts`). The box writes `content` to
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` **only** when the envelope is
accepted; on a rejected envelope (or any network/HTTP failure) it leaves the
baked fallback in place and never writes an empty file. The consumer therefore
accepts a body iff it is a JSON object whose `version` and `content` are both
non-empty strings.

Conformance: the control-plane producer is tested in
`packages/control-plane/test/agent-rules-conformance.test.ts`; the box consumer
(`blitz-rules sync`, `packages/box/rootfs/usr/local/bin/blitz-rules`) is tested
in `packages/box/actor/test/agent-rules-conformance.test.ts`.
