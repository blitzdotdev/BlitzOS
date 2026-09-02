#!/usr/bin/env node
// Removes the built-in Lody MCP server from every agent session in the
// PUBLISHED `lody` npm bundle.
//
// WHY THIS EXISTS. `AgentClient.buildMcpServers` hands every ACP agent one
// stdio MCP server, `lody __internal lody-mcp-server`, which is the WHOLE
// `lody` CLI bundle loaded again as a child of the agent. Measured on a cx33
// on 2026-09-02: 266 MB resident (221 MB proportional) per session, beside a
// codex that costs 211 MB proportional in all its own processes, and beside a
// claude at 271 MB. It is the single largest per-session fixed cost on a box,
// and BlitzOS uses none of what it serves: `lody_session_*` spawn sibling
// sessions, `lody_task_*` are the cloud task board, `lody_review_submit` and
// `lody_report_preview_candidate` feed surfaces the box does not render, and
// previews go through `blitz teenyapp open` (packages/box/rootfs). The HTTP
// variant is already dark (`LODY_MCP_HTTP_DISABLED=1` in the daemon's s6 run).
//
// It is also the process most often found orphaned: codex starts its MCP
// servers in their own process groups, so the daemon's group kill of a
// session's agent never reaches them, and a stdio server whose agent is gone
// does not exit on its own. Four of five on the box on 2026-09-02 had no
// living parent.
//
// WHAT THE PATCH DOES. Two edits, both strictly narrowing:
//
//   1. `const builtin = this.buildBuiltinMcpServers(workdir);`
//      becomes an empty list. Workspace-configured MCP servers (the
//      `externalLoad` branch of the same method) still load; only the
//      built-in one is gone. `buildBuiltinMcpServers` stays as dead code.
//   2. `LODY_MCP_TOOLS_REMINDER`, the sentence appended to every user turn —
//      "Use the available Lody MCP tools when relevant…" — becomes the empty
//      string, because it would now advertise tools the agent does not have.
//
// WHY THE GUARD IS THE VERSION AND TWO ANCHORS, NOT A FILE SHA. This runs after
// `lody-local-platform.mjs`, which pins the sha of the file AS PUBLISHED, so a
// file hash here could only ever be that patch's output. The version read from
// the installed `package.json` and each anchor at exactly one occurrence are
// the two things that are load-bearing. A refactor that moves either fails
// here with a count of 0, at image build time.
//
// IT IS IDEMPOTENT. A bundle that already carries both replacements and
// neither anchor is reported and accepted, because a box RUNS this artifact
// and `packages/webapp/test/lody-daemon-harness.ts` copies the box's bundle
// and re-applies the image build's patches to the copy.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-builtin-mcp-off.mjs <path to lody/dist/index.js>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.88.1";
const EXPECTED_OCCURRENCES = 1;

/** The first line of `AgentClient.buildMcpServers`. */
const FIND_BUILTIN = "const builtin = this.buildBuiltinMcpServers(workdir);";
const REPLACE_BUILTIN =
  "const builtin = []; /* blitz: no built-in lody MCP server (lody-builtin-mcp-off.mjs) */";

/** The reminder `buildPrompt` appends to every turn. The `\n\n` are the two
 * escaped characters as they appear in the bundle's double-quoted literal. */
const FIND_REMINDER =
  'const LODY_MCP_TOOLS_REMINDER = "\\n\\nUse the available Lody MCP tools when relevant; rely on their tool descriptions for complete, current capabilities and usage guidance.";';
const REPLACE_REMINDER = 'const LODY_MCP_TOOLS_REMINDER = "";';

const EDITS = [
  { name: "buildMcpServers builtin list", find: FIND_BUILTIN, replace: REPLACE_BUILTIN },
  { name: "LODY_MCP_TOOLS_REMINDER", find: FIND_REMINDER, replace: REPLACE_REMINDER },
];

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-builtin-mcp-off.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

// `dist/index.js` -> the package root beside it. Read rather than assumed: the
// version is what a bump changes, and it is the first thing to check.
const manifestPath = join(dirname(dirname(target)), "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
  console.error(`lody-builtin-mcp-off: cannot read ${manifestPath}: ${String(cause)}`);
  process.exit(1);
}
if (version !== EXPECTED_VERSION) {
  console.error(
    `lody-builtin-mcp-off: refusing to patch ${target}.\n` +
      `  expected lody@${EXPECTED_VERSION}, found lody@${String(version)}\n` +
      "  The pinned lody version moved. Re-check that AgentClient.buildMcpServers\n" +
      "  still prepends a built-in `lody` stdio server and that buildPrompt still\n" +
      "  appends LODY_MCP_TOOLS_REMINDER — if upstream made the built-in server\n" +
      "  optional, DELETE this patch and use the option instead of updating it.",
  );
  process.exit(1);
}

const source = readFileSync(target, "utf8");

const alreadyPatched =
  EDITS.every((edit) => source.includes(edit.replace)) &&
  EDITS.every((edit) => !source.includes(edit.find));
if (alreadyPatched) {
  console.log(`lody-builtin-mcp-off: ${target} is already patched (lody@${EXPECTED_VERSION}).`);
  process.exit(0);
}

let patched = source;
for (const edit of EDITS) {
  const occurrences = patched.split(edit.find).length - 1;
  if (occurrences !== EXPECTED_OCCURRENCES) {
    console.error(
      `lody-builtin-mcp-off: expected ${EXPECTED_OCCURRENCES} occurrence of the\n` +
        `  ${edit.name} anchor in ${target}, found ${occurrences}.\n` +
        "  The agent client or the prompt builder moved. Re-audit both before\n" +
        "  shipping a box: without this patch every session pays for a second\n" +
        "  copy of the lody bundle it never calls.",
    );
    process.exit(1);
  }
  patched = patched.split(edit.find).join(edit.replace);
}

writeFileSync(target, patched);
console.log(
  `lody-builtin-mcp-off: removed the built-in lody MCP server and its prompt reminder from ${target} (lody@${EXPECTED_VERSION}).`,
);
