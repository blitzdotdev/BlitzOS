/**
 * A persisted worktree preference must not strand a different box whose
 * Git-state RPC fails (vendor seam patch 18).
 *
 * `lody.workdirMode.global` is shared by every workspace on the origin, so a
 * box-local preflight cannot make the value safe: a healthy box visited earlier
 * may already have written it. The vendored landing already computes and
 * displays an effective local mode on a terminal Git-state error; this pins the
 * two submit gates to that fallback so both click and Enter remain usable.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChatLandingSubmitDisabled } from "@lody/components/components/chat/chat-landing-derived";

function findRepoRoot(): string {
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "lint-baseline.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repo root not found above ${process.cwd()}`);
    directory = parent;
  }
}

const repoRoot = findRepoRoot();

describe("worktree preference fallback after a Git-state failure", () => {
  const sendableWorktree = {
    submitting: false,
    hasBlockingImages: false,
    hasBlockingFiles: false,
    hasSendableContent: true,
    contextType: "local" as const,
    workdirMode: "worktree" as const,
    hasSelectedLocalProject: true,
    isRuntimeInitializing: false,
  };

  it("waits while Git state is loading, then enables the existing local fallback on error", () => {
    expect(getChatLandingSubmitDisabled({
      ...sendableWorktree,
      isLoadingLocalGitState: true,
      hasLocalGitStateError: false,
    })).toBe(true);

    // This is the cross-workspace reproduction: the selected `worktree` value
    // came from a healthy box's global seed, while the current box failed its
    // own probe. The component's effective mode is now local, so Send must open.
    expect(getChatLandingSubmitDisabled({
      ...sendableWorktree,
      isLoadingLocalGitState: false,
      hasLocalGitStateError: true,
    })).toBe(false);
  });

  it("does not retain a keyboard-submit early return behind the enabled button", () => {
    const source = readFileSync(
      `${repoRoot}/vendor/lody/packages/components/src/components/chat/chat-landing.tsx`,
      "utf8",
    );
    expect(source).not.toContain("local_project_git_state_failed");
    expect(source).not.toContain(
      "localGitStateError && selectedWorkdirMode === 'worktree'",
    );
    expect(source).toContain(
      "effectiveWorkdirMode === 'worktree' ? { useWorktree: true } : {}",
    );
  });

  it("is declared as the upstreamable seam the merge runbook must preserve", () => {
    const patches = readFileSync(`${repoRoot}/vendor/lody/BLITZ-PATCHES.md`, "utf8");
    expect(patches).toContain(
      "### 18. A failed Git-state probe degrades a worktree selection to local",
    );
    expect(patches).toContain("plans/evidence/lody-git-state-fallback-pr.md");
  });
});
