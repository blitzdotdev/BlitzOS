#!/usr/bin/env node
// Turns on Lody's per-session cgroup sandbox under the box's memory boundary,
// without its capacity split, in the PUBLISHED `lody` npm bundle.
//
// WHY THIS EXISTS. The daemon ends a session by signalling the agent's PROCESS
// GROUP (`apps/cli/src/agent/acp-runner.ts`, `process.kill(-pid)`). Codex runs
// every tool command under its own session id and starts its MCP servers in
// their own groups; Claude Code's Bash tool is detached too. So the `npm test`
// tree an agent launched, and the MCP servers it started, are never in that
// group and outlive it. Seen on a cx33 on 2026-09-02: a 1.5 GB test run and
// four MCP servers with no living parent, and a 531 MB vitest worker still
// alive 30 minutes after the daemon restart that killed its session.
//
// Lody already has the right answer: `LinuxCgroupSessionSandbox`
// (`apps/cli/src/session/session-sandbox.ts`) creates one cgroup per session,
// spawns the ACP agent into it, and force-terminates by writing `cgroup.kill`,
// which takes every descendant whatever its process group. On a box it fails
// at start — "Execution sandbox unavailable ... EACCES mkdir
// /sys/fs/cgroup/blitz-user.slice/lody.scope/lody-sessions" — and every session
// runs unsandboxed. The cause is structural, not a permission bit: the sandbox
// derives its parent from the daemon's OWN cgroup, and a cgroup that holds a
// process may not hand controllers to its children (cgroup v2's no-internal-
// process rule). No placement of the daemon can satisfy that.
//
// WHAT THE PATCH DOES. Two edits, one line each:
//
//   1. The session parent becomes a SIBLING of the daemon's leaf:
//      `<daemon cgroup>/lody-sessions` -> `<parent of daemon cgroup>/lody-sessions`,
//      i.e. `blitz-user.slice/lody-sessions`. `blitz-cgroup init` builds that
//      directory with `+memory +pids +cpu` in its subtree_control (the sandbox
//      never writes subtree_control itself and refuses a leaf without
//      `cpu.max`) and hands it to uid 1000. Verified by hand on 2026-09-02 as
//      uid 1000 on a live box: mkdir the leaf, migrate a process in, `cgroup.kill`,
//      rmdir — every step allowed, only `cpu.max` missing until init enables it.
//   2. `calculateAutomaticSessionSandboxLimits` no longer returns a memory or
//      cpu cap. Upstream reserves 25% of capacity and splits the rest evenly
//      across open sessions, so a third session would shrink every session's
//      ceiling to 1.7 GB on an 8 GB box and OOM-kill a full test run. The box
//      already has its ceiling (`blitz-user.slice`); what it wanted from the
//      sandbox is the kill switch, not a second budget. `memory.max`, `memory.high`
//      and `cpu.max` are written as `max`; `pids.max` keeps upstream's 1024,
//      which is a fork-bomb guard and not a share of anything.
//
// On a flat box (no boundary, unprivileged container, dev workspace) the parent
// has no controllers, `ensureRequiredFilesExist` throws as it does today, and
// the session runs unsandboxed exactly as before this patch.
//
// WHY THE GUARD IS THE VERSION AND TWO ANCHORS, NOT A FILE SHA. This runs after
// `lody-local-platform.mjs`, which pins the sha of the file AS PUBLISHED, so a
// file hash here could only ever be that patch's output. The version read from
// the installed `package.json` and each anchor at exactly one occurrence are
// the two things that are load-bearing.
//
// IT IS IDEMPOTENT. A bundle that already carries both replacements and
// neither anchor is reported and accepted, because a box RUNS this artifact
// and `packages/webapp/test/lody-daemon-harness.ts` copies the box's bundle
// and re-applies the image build's patches to the copy.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-session-sandbox.mjs <path to lody/dist/index.js>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.88.1";
const EXPECTED_OCCURRENCES = 1;

/** `LinuxCgroupSessionSandbox.initialize`: where the session parent is derived. */
const FIND_PARENT =
  "const parentDir = path__default$1.join(this.deps.cgroupMount, trimLeadingSlash(selfCgroupPath), DEFAULT_SESSION_PARENT);";
const REPLACE_PARENT =
  "const parentDir = path__default$1.join(this.deps.cgroupMount, trimLeadingSlash(path__default$1.dirname(selfCgroupPath)), DEFAULT_SESSION_PARENT); /* blitz: beside the daemon's leaf, not under it (lody-session-sandbox.mjs) */";

/** The two capped fields of `calculateAutomaticSessionSandboxLimits`'s return
 * value. `pidsMax` on the line after them is kept. */
const FIND_LIMITS =
  "      memoryMaxBytes: Math.max(1, Math.floor(executionMemoryBudgetBytes / sessionCount)),\n" +
  "      cpuMax: `${Math.max(1, Math.floor(executionCpuBudgetMicros / sessionCount))} ${DEFAULT_CPU_MAX_PERIOD_US}`,\n";
const REPLACE_LIMITS =
  "      /* blitz: no capacity split; memory and cpu stay at max (lody-session-sandbox.mjs) */\n";

const EDITS = [
  { name: "session parent directory", find: FIND_PARENT, replace: REPLACE_PARENT },
  { name: "automatic memory/cpu limits", find: FIND_LIMITS, replace: REPLACE_LIMITS },
];

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-session-sandbox.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

// `dist/index.js` -> the package root beside it. Read rather than assumed: the
// version is what a bump changes, and it is the first thing to check.
const manifestPath = join(dirname(dirname(target)), "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
  console.error(`lody-session-sandbox: cannot read ${manifestPath}: ${String(cause)}`);
  process.exit(1);
}
if (version !== EXPECTED_VERSION) {
  console.error(
    `lody-session-sandbox: refusing to patch ${target}.\n` +
      `  expected lody@${EXPECTED_VERSION}, found lody@${String(version)}\n` +
      "  The pinned lody version moved. Re-check that LinuxCgroupSessionSandbox\n" +
      "  still derives its parent from the daemon's own cgroup and that\n" +
      "  calculateAutomaticSessionSandboxLimits still splits capacity across\n" +
      "  sessions — if upstream made either configurable, DELETE this patch and\n" +
      "  use the option instead of updating it.",
  );
  process.exit(1);
}

const source = readFileSync(target, "utf8");

const alreadyPatched =
  EDITS.every((edit) => source.includes(edit.replace)) &&
  EDITS.every((edit) => !source.includes(edit.find));
if (alreadyPatched) {
  console.log(`lody-session-sandbox: ${target} is already patched (lody@${EXPECTED_VERSION}).`);
  process.exit(0);
}

let patched = source;
for (const edit of EDITS) {
  const occurrences = patched.split(edit.find).length - 1;
  if (occurrences !== EXPECTED_OCCURRENCES) {
    console.error(
      `lody-session-sandbox: expected ${EXPECTED_OCCURRENCES} occurrence of the\n` +
        `  ${edit.name} anchor in ${target}, found ${occurrences}.\n` +
        "  The session sandbox moved. Re-audit it before shipping a box: without\n" +
        "  this patch a session's test runs and MCP servers outlive the session.",
    );
    process.exit(1);
  }
  patched = patched.split(edit.find).join(edit.replace);
}

writeFileSync(target, patched);
console.log(
  `lody-session-sandbox: re-parented the session sandbox beside the daemon's leaf and dropped its capacity split in ${target} (lody@${EXPECTED_VERSION}).`,
);
