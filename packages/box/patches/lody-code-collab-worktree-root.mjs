#!/usr/bin/env node
// Points Code Collab at the WORKTREE of a worktree session, in the PUBLISHED
// `lody` npm bundle. Without it the "All Changes" side panel of every BlitzOS
// worktree session says "No changes yet."
//
// WHAT THE MEMBER SEES. Reported from the first real worktree dogfood on canary
// (workspace 1d07e756, session 5317b6e0, repo LodyAI/Lody, branch
// feat/identify-coding-task): the rail row reads "+152 -115", the composer's
// worktree bar reads "+152 -115", a turn renders the chip "AGENTS.md +44 -34",
// and the All Changes panel is EMPTY. The diff exists; the panel does not see
// it.
//
// TWO DOORS, AND ONLY ONE KNOWS ABOUT THE WORKTREE. The rail, the bar and the
// chips read `SessionMeta.diffStats`, which turn post-processing computes inside
// the LIVE session's own working directory — the worktree, always. The panel
// reads `code-collab/get-file-index`, whose root comes from
// `resolveCodeCollabWorkspaceRoot`
// (`vendor/lody/apps/cli/src/lib/message-handler.ts:6238`). That resolver
// answers from a live `Session` object when there is one, and otherwise from the
// session document — where its FIRST branch is
//
//   if (project?.kind === 'local') { ...return the local project's root path... }
//
// and neither `project.useWorktree` nor `meta.isWorktree` is consulted. A
// BlitzOS worktree session is exactly a local project with `useWorktree: true`
// (`plans/LODY-SESSIONS.md` §6.4), so the moment its agent process is gone the
// panel starts diffing `/workspace/<repo>` — the CLONE, which the worktree
// design guarantees is clean. That is an empty SUCCESS, not a refusal, which is
// why the member sees an empty state and no error at all.
//
// Measured here on 2026-09-01, against a real daemon
// (`packages/webapp/test/lody-worktree-session.test.ts`): one file added in the
// worktree of a live session, then `code-collab/get-file-index` polled every
// three seconds.
//
//   t=0s  keys=AGENTS.md,README.md     <- the worktree, from the live Session
//   t=3s  keys=README.md               <- the clone, from the document
//   ...   keys=README.md               (for as long as anyone looks)
//
// WHAT THE PATCH DOES. One branch, inserted before that return: when the session
// is a worktree session AND the worktree exists on disk, answer with the
// worktree's host path instead. Everything else is untouched — a local project
// session that is not a worktree, and a worktree session whose worktree is not
// there, both keep the answer they have today.
//
// It is not a new rule. The daemon's own terminal resolver already reads exactly
// these two fields one file away:
//
//   if (meta.isWorktree || project.useWorktree === true) {
//     const repoId = deriveRepoIdFromLocalProjectPath(rootPath);
//     return ...getWorktreeHostPathFromDotlodyPath(repoId, sessionId, ...)
//   }                      (`apps/cli/src/lib/terminal-workdir-resolver.ts:97`)
//
// so a terminal opened on a worktree session lands in the worktree while its
// file panel reads the clone. This gives Code Collab the same two lines, through
// the same `WorktreeManager` the resolver's GitHub branch twenty lines below
// already uses.
//
// UPSTREAM PR: "Code Collab resolves a local-project worktree session to its
// worktree". The github-project branch of the same function handles its own
// worktrees; the local-project branch predates `useWorktree` and was never
// extended. Drop this patch when it merges.
//
// WHY THE GUARD IS NOT A WHOLE-FILE SHA: three patches now run over the same
// artifact and a file hash can only pin the first (see `lody-acp-auth-queue.mjs`).
// This one pins the installed package's VERSION and its exact anchor text at
// exactly one occurrence.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-code-collab-worktree-root.mjs <path to lody/dist/index.js>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.88.1";
const EXPECTED_OCCURRENCES = 1;

/** The whole local-project branch of `resolveCodeCollabWorkspaceRoot`. Taken
 * whole rather than by its last line, because the `return` it ends with is what
 * the insert goes in front of and the block is what makes it unique. */
const FIND = `      if (project?.kind === "local") {
        const workspaceRoot = await resolveWorkspaceLocalProjectRootPath(this.workspaceDocument.repo, this.workspaceId, this.machineId, project.localProjectId);
        if (!workspaceRoot) {
          return {
            ok: false,
            error: "workspace_unavailable",
            message: \`Local project not found in workspace: \${project.localProjectId}\`
          };
        }
        return {
          ok: true,
          workspaceRoot,
          source: \`local-project:\${project.localProjectId}\`,
          ...ownerSessionIdField(ownerSessionId)
        };
      }`;

/** The marker the idempotency check looks for, and the source string the daemon
 * logs for a resolution that came from here. */
const PATCHED_SOURCE = "local-project-worktree:";

const REPLACE = `      if (project?.kind === "local") {
        const workspaceRoot = await resolveWorkspaceLocalProjectRootPath(this.workspaceDocument.repo, this.workspaceId, this.machineId, project.localProjectId);
        if (!workspaceRoot) {
          return {
            ok: false,
            error: "workspace_unavailable",
            message: \`Local project not found in workspace: \${project.localProjectId}\`
          };
        }
        if (meta.isWorktree === true || project.useWorktree === true) {
          const blitzOriginalRootPath = normalizeLocalProjectRootPath(workspaceRoot);
          const blitzWorktreeManager = getWorktreeManager({
            repoId: deriveRepoIdFromLocalProjectPath(blitzOriginalRootPath),
            source: { kind: "local-shared", originalRootPath: blitzOriginalRootPath },
            logger: this.logger
          });
          if (blitzWorktreeManager.hasWorktree(ownerSessionId)) {
            return {
              ok: true,
              workspaceRoot: blitzWorktreeManager.getWorktreeHostPath(ownerSessionId),
              source: \`${PATCHED_SOURCE}\${project.localProjectId}\`,
              ...ownerSessionIdField(ownerSessionId)
            };
          }
        }
        return {
          ok: true,
          workspaceRoot,
          source: \`local-project:\${project.localProjectId}\`,
          ...ownerSessionIdField(ownerSessionId)
        };
      }`;

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-code-collab-worktree-root.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

// `dist/index.js` -> the package root beside it. Read rather than assumed: the
// version is what a bump changes, and it is the first thing to check.
const manifestPath = join(dirname(dirname(target)), "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
  console.error(`lody-code-collab-worktree-root: cannot read ${manifestPath}: ${String(cause)}`);
  process.exit(1);
}
if (version !== EXPECTED_VERSION) {
  console.error(
    `lody-code-collab-worktree-root: refusing to patch ${target}.\n` +
      `  expected lody@${EXPECTED_VERSION}, found lody@${String(version)}\n` +
      "  The pinned lody version moved. Re-check whether the local-project branch\n" +
      "  of resolveCodeCollabWorkspaceRoot still ignores useWorktree — if upstream\n" +
      "  fixed it, DELETE this patch instead of updating it.",
  );
  process.exit(1);
}

const source = readFileSync(target, "utf8");
if (source.includes(PATCHED_SOURCE)) {
  console.log(`lody-code-collab-worktree-root: ${target} is already patched.`);
  process.exit(0);
}

const occurrences = source.split(FIND).length - 1;
if (occurrences !== EXPECTED_OCCURRENCES) {
  console.error(
    `lody-code-collab-worktree-root: expected ${EXPECTED_OCCURRENCES} occurrence of the\n` +
      `  local-project branch of resolveCodeCollabWorkspaceRoot in ${target}, found ${occurrences}.\n` +
      "  That resolver moved. Re-audit it before shipping a box: without this patch\n" +
      "  All Changes, the Files tab and every file chip of a worktree session read\n" +
      "  the clone instead of the worktree.",
  );
  process.exit(1);
}

writeFileSync(target, source.split(FIND).join(REPLACE));
console.log(
  `lody-code-collab-worktree-root: pointed Code Collab at the worktree in ${target} (lody@${EXPECTED_VERSION}).`,
);
