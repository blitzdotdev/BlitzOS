/**
 * PHASE 5 EXIT TEST (plans/LODY-SESSIONS.md §10) — the worktree lifecycle.
 *
 * "A repo registered on the box carries a branch picker; a worktree session runs
 * on a `lody/<id>` branch under the daemon's data dir with the original clone
 * untouched; archive backs up dirty state and removes the worktree; delete
 * refuses a dirty one."
 *
 * Everything here is FREE, and that is the interesting part. A worktree session
 * is normally born from a dispatch, which is a paid turn — but the daemon cuts
 * the worktree in `createSessionInner`
 * (`vendor/lody/apps/cli/src/session/session-manager.ts:1932`), which runs
 * BEFORE `session.createAgent` (`:1404`). So a `session/create` whose
 * `runtimeOverrides` name a binary that exits non-zero creates the branch, the
 * worktree and the session document, then fails to launch an agent — which is
 * exactly the half under test, at no cost.
 *
 * What is NOT free is `SessionMeta.diffStats` and `workspaceDirty`: those are
 * per-turn post-processing (`turn-post-processing-service.ts:127`), so they need
 * a turn. That assertion is in `lody-worktree-live.test.ts`, gated behind
 * `BLITZ_LODY_LIVE_TURN=1`.
 *
 * The suite skips with no `lody` bundle installed, which is CI — the same gate
 * phases 2, 3 and 4 chose.
 */
import "fake-indexeddb/auto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "jotai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import {
  getMachineFlockDocId,
  getMachineRoomId,
  getSessionRoomId,
  machineFlockKeys,
  buildMachineArchiveSessionCommand,
  getServerNow,
} from "@lody/shared";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { sendProjectControl, sendSessionControl } from "../src/lody/rpc-client.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
  type LodyRuntimeHandle,
} from "../src/lody/runtime.js";
import { mirrorLocalProjectsToMachineMeta } from "../src/lody/local-projects.js";
import { startLodySession, type LodyProjectRef } from "../src/lody/session.js";
import { lodyDaemonAvailable, repoRoot, startLodyHarness, type LodyHarness } from "./lody-daemon-harness.js";

/**
 * The box's real registrar, run the way the s6 service runs it.
 *
 * Found through the harness's `repoRoot()` and not through `import.meta.url`,
 * for the reason that function's own comment gives: under the jsdom environment
 * Vitest serves test modules over its dev server, so `import.meta.url` is an
 * `http:` URL and `fileURLToPath` throws.
 */
const REGISTRAR = join(repoRoot(), "packages/box/rootfs/usr/local/libexec/blitz-lody-projects");

/**
 * A binary the ACP adapter cannot launch.
 *
 * `/bin/false` exits 1 immediately, so `session.createAgent` throws
 * "Claude Code process exited with code 1" and nothing is ever sent to a model.
 * The worktree is already cut by then. Any non-launching path would do; this one
 * is in every image and needs no fixture file.
 */
const NON_LAUNCHING_BINARY = "/bin/false";

/** `getDefaultSessionBranchName` sanitizes and truncates to 12 characters for a
 * `local-shared` source (`worktree-manager.ts:1098`), so session ids of exactly
 * 12 legal characters make the expected branch names literal. */
const WORKTREE_SESSION_ID = "wtprobe00001";
const ARCHIVE_SESSION_ID = "wtarchive001";

const PROBE_IDENTITY = {
  GIT_AUTHOR_NAME: "probe",
  GIT_AUTHOR_EMAIL: "probe@local.invalid",
  GIT_COMMITTER_NAME: "probe",
  GIT_COMMITTER_EMAIL: "probe@local.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...PROBE_IDENTITY },
  }).trim();
}

/** A clone shaped like the ones `/workspace/<repo>` holds: a GitHub remote, a
 * `main` branch, one commit. The remote is what makes the daemon derive
 * `githubRepoFullName`, which is the field §6.4 depends on. */
function createClone(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main", ".");
  git(path, "remote", "add", "origin", `https://github.com/blitzdotdev/${name}.git`);
  writeFileSync(join(path, "README.md"), `# ${name}\n`);
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return path;
}

/** Runs the registrar once — the s6 service's loop, minus the loop. */
function runRegistrar(dataDir: string, workspaceRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REGISTRAR], {
      env: {
        ...process.env,
        LODY_PLATFORM: "local",
        LODY_DATA_DIR: dataDir,
        BLITZ_WORKSPACE_ROOT: workspaceRoot,
        BLITZ_LODY_PROJECTS_ONCE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));
    child.once("exit", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`registrar exited ${code}: ${output}`)),
    );
  });
}

interface ProjectRow {
  localProjectId: string;
  name: string;
  rootPath: string;
}

async function until<T>(
  what: string,
  read: () => T | undefined,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!lodyDaemonAvailable())("phase 5: worktree sessions against a real daemon", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  let workspaceRoot = "";
  let clonePath: string;
  let projects: ProjectRow[] = [];
  const store = createStore();

  const endpoints = () => ({
    rpcUrl: harness.endpoints.rpcUrl,
    controlUrl: harness.endpoints.controlUrl,
    projectUrl: harness.endpoints.projectUrl,
    platformUrl: harness.endpoints.platformUrl,
  });

  const listProjects = async (): Promise<ProjectRow[]> => {
    const response = await sendProjectControl(endpoints(), {
      type: "local-project/list",
      machineId: snapshot.machineId,
    });
    if (!response.ok) throw new Error(`local-project/list failed: ${response.message}`);
    // SAFETY: `LocalProjectControlResponseSchema` accepted this body inside
    // `sendProjectControl`, and the `local-project/list` member's result carries
    // exactly these fields (`message-schemas.ts:2413`).
    const result = response.result as unknown as { workspaces: { projects: ProjectRow[] }[] };
    return result.workspaces.flatMap((workspace) => workspace.projects);
  };

  /**
   * `<dataDir>/repos/<repoId>/worktrees/<sessionId>`, found on disk.
   *
   * Recomputing `local---<sha256(rootPath).slice(0,12)>` here would restate a
   * rule the daemon owns and would pass even if the daemon changed it. Looking
   * for the one directory it created asserts the LAYOUT the plan names without
   * re-deriving the id.
   */
  const worktreePath = (sessionId: string): string => {
    const reposRoot = join(harness.dataDir, "repos");
    const repoIds = existsSync(reposRoot)
      ? readdirSync(reposRoot).filter((name) => name.startsWith("local---")).sort()
      : [];
    const owner = repoIds.find((repoId) =>
      existsSync(join(reposRoot, repoId, "worktrees", sessionId)),
    );
    if (owner === undefined) {
      throw new Error(`no worktree for ${sessionId} under ${reposRoot} (saw ${repoIds.join(", ")})`);
    }
    return join(reposRoot, owner, "worktrees", sessionId);
  };

  const projectRef = (): LodyProjectRef => ({
    kind: "local",
    localProjectId: projects[0]!.localProjectId,
    branch: "main",
    githubRepoFullName: "blitzdotdev/wt-probe",
    useWorktree: true,
  });

  /**
   * One worktree session, created without paying for a turn.
   *
   * TWO WRITES, IN THE PRODUCT'S ORDER. `startLodySession` is the accept unit
   * the landing's send makes — session meta plus the first user turn, in one
   * CRDT transaction — and it carries `machineId` and the `ProjectRef`. Only
   * then does the control-socket `session/create` run, which is the half a
   * dispatch would otherwise trigger. Skipping the first write leaves a session
   * document with no `machineId`, and `local-project/removal-preflight` filters
   * on exactly that (`local-project-removal.ts:23`) — measured, by writing this
   * test the other way round first.
   */
  const createWorktreeSession = async (sessionId: string): Promise<void> => {
    await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "(probe: the agent never launches)",
      project: projectRef(),
    });
    const result = await sendSessionControl(
      endpoints(),
      {
        type: "session/create",
        sessionId,
        machineId: snapshot.machineId,
        workspaceId: snapshot.workspace.workspaceId,
        project: projectRef(),
        acpSessionConfig: {
          prompt: "",
          cliType: "builtin",
          agentType: "claude",
          runtimeOverrides: { claudeCodeExecutable: NON_LAUNCHING_BINARY },
        },
        userId: snapshot.userId,
        userName: "probe",
        userEmail: "probe@local.invalid",
      },
      () => {},
    );
    if (!result.ok) throw new Error(`session/create failed: ${result.error}`);
    await until(`the worktree for ${sessionId}`, () => {
      try {
        return worktreePath(sessionId);
      } catch {
        return undefined;
      }
    });
  };

  beforeAll(async () => {
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    handle = await createLodyRuntime({
      endpoints: { ...harness.endpoints, webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket },
      snapshot,
    });
    mountLodyRuntimeAtoms(store, handle.runtime);
    // Short, because a worktree path under it must stay inside the `sun_path`
    // budget the harness documents.
    workspaceRoot = mkdtempSync(join(tmpdir(), "lw-"));
    clonePath = createClone(workspaceRoot, "wt-probe");
    mkdirSync(join(workspaceRoot, "not-a-repo"), { recursive: true });
  }, 120_000);

  afterAll(async () => {
    unmountLodyRuntimeAtoms(store);
    await handle?.dispose();
    if (workspaceRoot !== "") rmSync(workspaceRoot, { recursive: true, force: true });
    await harness?.stop();
  });

  it("registers every /workspace clone, once, and skips what is not a repo", async () => {
    const first = await runRegistrar(harness.dataDir, workspaceRoot);
    expect(first).toContain(`registered ${clonePath}`);
    expect(first).not.toContain("not-a-repo");

    projects = await listProjects();
    expect(projects.map((project) => project.rootPath)).toEqual([clonePath]);

    // Idempotency is the DAEMON's — `local-project/add` keyed on the same
    // `rootPath` answers with the same `localProjectId` — and the registrar's
    // list pass is what keeps a reboot quiet rather than merely harmless.
    const second = await runRegistrar(harness.dataDir, workspaceRoot);
    expect(second).toContain('"added":[]');
    expect(await listProjects()).toHaveLength(1);
  }, 60_000);

  it("reports the clone's GitHub remote, its branches and a clean tree", async () => {
    const response = await sendProjectControl(endpoints(), {
      type: "local-project/git-state",
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      localProjectId: projects[0]!.localProjectId,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    // SAFETY: the `git: true` member of `LocalProjectGitStateSchema`
    // (`message-schemas.ts:2188`), which `sendProjectControl` already validated.
    const state = response.result as {
      git: boolean;
      branches: string[];
      currentBranch: string | null;
      defaultBranch: string | null;
      githubRepoFullName: string | null;
      workingTree: { clean: boolean };
    };
    // The three things the landing's GitHub Worktrees context needs: the repo
    // name that groups a session under it (§6.4), the branch list the picker
    // renders, and the base branch it defaults to. All derived by the daemon
    // from the clone itself — `local-project/add` cannot carry any of them.
    expect(state.git).toBe(true);
    expect(state.githubRepoFullName).toBe("blitzdotdev/wt-probe");
    expect(state.branches).toContain("main");
    expect(state.currentBranch).toBe("main");
    expect(state.defaultBranch).toBe("main");
    expect(state.workingTree.clean).toBe(true);
  }, 30_000);

  it("has no worktree setup script configured, and says so cleanly", async () => {
    // §0.5 ships worktree v1 with no setup script anywhere. `runWorktreeScript`
    // returns before `events.onStart` when the config is null
    // (`worktree-setup-runner.ts:196`), so absence costs no history entry, no
    // shell and no error — which is what makes shipping without one a decision
    // rather than an omission.
    const response = await sendProjectControl(endpoints(), {
      type: "local-project/get-worktree-setup",
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      localProjectId: projects[0]!.localProjectId,
    });
    expect(response.ok).toBe(true);
    if (response.ok) expect(response.result).toBeNull();
  }, 30_000);

  it("cuts a lody/<id12> worktree off the clone and leaves the clone alone", async () => {
    const headBefore = git(clonePath, "rev-parse", "HEAD");
    const branchBefore = git(clonePath, "rev-parse", "--abbrev-ref", "HEAD");

    await createWorktreeSession(WORKTREE_SESSION_ID);
    const path = worktreePath(WORKTREE_SESSION_ID);

    // The branch generator for a `local-shared` source, verbatim.
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`lody/${WORKTREE_SESSION_ID}`);
    expect(git(path, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(join(path, "README.md"), "utf8")).toContain("wt-probe");

    // THE INVARIANT THE PLAN NAMES: the member's own clone is not moved, not
    // checked out and not dirtied by a session running beside it.
    expect(git(clonePath, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(clonePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branchBefore);
    expect(git(clonePath, "status", "--porcelain")).toBe("");
  }, 120_000);

  it("keeps a dirty worktree when the project is removed, and reports it as dirty", async () => {
    // `local-shared` removal passes `force = false` (`message-handler.ts:4512`),
    // and `removeWorktreeInternal` throws on a dirty tree rather than discarding
    // it (`worktree-manager.ts:1566`). The preflight is the READ half of that
    // rule, and it is what the confirm dialog shows before anything is removed.
    const path = worktreePath(WORKTREE_SESSION_ID);
    writeFileSync(join(path, "AGENT_EDIT.md"), "edited by the probe\n");

    const preflight = await sendProjectControl(endpoints(), {
      type: "local-project/removal-preflight",
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      localProjectId: projects[0]!.localProjectId,
    });
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    // SAFETY: `LocalProjectWorktreeCleanupPreflightResultSchema`
    // (`message-schemas.ts:2294`), already validated by `sendProjectControl`.
    const buckets = preflight.result as {
      clean: { sessionId: string }[];
      dirty: { sessionId: string }[];
      failed: { sessionId: string }[];
    };
    expect(buckets.dirty.map((entry) => entry.sessionId)).toContain(WORKTREE_SESSION_ID);
    expect(buckets.clean.map((entry) => entry.sessionId)).not.toContain(WORKTREE_SESSION_ID);
    // Nothing was destroyed by asking.
    expect(existsSync(join(path, "AGENT_EDIT.md"))).toBe(true);
  }, 60_000);

  it("archives a dirty worktree into a backup commit, keeps the branch, removes the tree", async () => {
    await createWorktreeSession(ARCHIVE_SESSION_ID);
    const path = worktreePath(ARCHIVE_SESSION_ID);
    writeFileSync(join(path, "UNCOMMITTED.md"), "work the member has not committed\n");
    expect(git(path, "status", "--porcelain")).not.toBe("");
    const branch = `lody/${ARCHIVE_SESSION_ID}`;
    const headBefore = git(path, "rev-parse", "HEAD");

    // The three writes `useSessionActions.archiveSession` makes
    // (`hooks/use-session-actions.ts:1180`). They are reproduced here rather
    // than driven through the hook because the hook needs a full surface mount
    // and what is under test is the DAEMON's half: the rail already calls it
    // (`src/lody/SessionRailSidebar.tsx`), and phase 4 proved that wiring.
    const machineId = snapshot.machineId;
    const machineRoomId = getMachineRoomId(machineId);
    const flockDocId = getMachineFlockDocId(handle.runtime.workspaceId, machineId);
    // The machine room has to be open before it can be written, the same rule
    // `startLodySession` follows for a session room and `bootstrapLodyAgentConfigs`
    // follows for this Flock: a patch to a room this peer never joined
    // converges nowhere.
    await handle.runtime.ensureDocStream(machineRoomId);
    // Without this the daemon's archive path cannot find the project's root
    // path and silently leaves the worktree behind — see the module comment on
    // `mirrorLocalProjectsToMachineMeta`. It is asserted here rather than
    // assumed: this call IS the difference between exit test 4 passing and the
    // member's uncommitted work being stranded.
    expect(await mirrorLocalProjectsToMachineMeta(handle.runtime, machineId)).toEqual([
      projects[0]!.localProjectId,
    ]);

    await handle.runtime.writer.upsertDocMeta(getSessionRoomId(ARCHIVE_SESSION_ID), {
      isArchived: true,
    });
    await handle.runtime.writer.flockRowPut(
      flockDocId,
      machineFlockKeys.archiveSessionCommand(ARCHIVE_SESSION_ID) as readonly string[],
      buildMachineArchiveSessionCommand({ requestedAt: getServerNow() }),
    );
    await handle.runtime.writer.upsertDocMeta(machineRoomId, {
      needToArchiveSessions: { [ARCHIVE_SESSION_ID]: true },
    });

    await until("the archived worktree to be removed", () => (existsSync(path) ? undefined : true), 90_000);

    // THE BRANCH SURVIVES, and it carries the backup commit. Both are read from
    // the original clone, which is the only checkout left.
    const log = git(clonePath, "log", "-1", "--format=%an <%ae>%n%s", branch);
    expect(log).toBe(
      `Lody Archive <archive@lody.ai>\nchore: archive backup for session ${ARCHIVE_SESSION_ID.slice(0, 8)}`,
    );
    expect(git(clonePath, "rev-parse", branch)).not.toBe(headBefore);
    expect(git(clonePath, "show", `${branch}:UNCOMMITTED.md`)).toContain("not committed");
    // And the clone is still where the member left it.
    expect(git(clonePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(clonePath, "status", "--porcelain")).toBe("");
  }, 180_000);
});
