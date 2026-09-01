/**
 * A PLAIN CHAT SESSION WORKS IN `/workspace` — the bug this file pins.
 *
 * Reported from a canary box: clicking a RELATIVE file chip in chat output
 * ("CLAUDE.md") opened the viewer on "File not found", and the session's own
 * agent reported its working directory as `/var/lib/blitz/lody/chats/<id>` —
 * empty. A side-panel audit added the rest: the ABSOLUTE chip fails too, with
 * "Session has no local project or GitHub repository workspace", and so do the
 * Files tab and All Changes.
 *
 * One cause, all of it. A session with no `ProjectRef` is given no working
 * directory (`session-execution-service.ts:4141`) and falls back to the
 * daemon's chat-storage directory (`session/session.ts:175`); a relative
 * preview path is joined to exactly that directory and nothing else
 * (`file-preview-path-policy.ts:160`); and before a session is live at all the
 * daemon has no workspace root to answer with, so every Code Collab call is
 * refused `workspace_unavailable` (`message-handler.ts:6355`). Giving the
 * session a project answers all three. `workdir-default.ts` carries the full
 * chain; this file drives it from both ends.
 *
 * The daemon-backed half skips with no `lody` bundle installed, which is CI —
 * the same gate every other Lody exit test chose.
 */
import "fake-indexeddb/auto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { createStore } from "jotai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "@blitzos/schema";
import { WebSocket as NodeWebSocket } from "ws";
import { getSessionRoomId } from "@lody/shared";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { sendMachineRpc, sendProjectControl } from "../src/lody/rpc-client.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  type LodyRuntimeHandle,
  type LodyWorkspaceRuntime,
  type LodyWorkspaceWriter,
} from "../src/lody/runtime.js";
import { startLodySession, type LodyProjectRef } from "../src/lody/session.js";
import {
  backfillDefaultSessionProject,
  createDefaultSessionProjectResolver,
  createSessionProjectBackfiller,
  withDefaultSessionProject,
} from "../src/lody/workdir-default.js";
import {
  useDefaultSessionProjectBackfill,
  type SessionProjectBackfillInput,
} from "../src/lody/use-session-project-backfill.js";
import { render, settle } from "./dom.js";
import { lodyDaemonAvailable, startLodyHarness, type LodyHarness } from "./lody-daemon-harness.js";

const PLANE_ENDPOINTS = {
  rpcUrl: "https://box.invalid/lody/rpc",
  controlUrl: "https://box.invalid/lody/control",
  projectUrl: "https://box.invalid/lody/project",
  platformUrl: "https://box.invalid/lody/platform",
};

interface ProjectControlCall {
  type: string;
  rootPath: string;
}

/** A `/project` door that answers `local-project/add` the way the daemon does:
 * one id derived from the path it was given (`lody-fleet.ts:1805`). */
function projectControlStub(answer: (call: ProjectControlCall) => JsonValue) {
  const calls: ProjectControlCall[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)) as ProjectControlCall;
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function addAccepted(call: ProjectControlCall): JsonValue {
  return {
    ok: true,
    type: call.type,
    result: {
      localProjectId: `local-${call.rootPath.replaceAll("/", "-")}`,
      name: "workspace",
      rootPath: call.rootPath,
      workspaceIds: ["w1"],
    },
  };
}

/** A writer that records the meta it was handed and does nothing else. The five
 * members of the seam it does not implement are never reached: the decorator
 * copies them across untouched. */
function recordingWriter() {
  const metas: JsonObject[] = [];
  const writer = {
    startSession: async (_sessionId, meta) => {
      metas.push(meta);
    },
    appendSessionTurn: async () => {},
    upsertDocMeta: async () => {},
    flockRowPut: async () => {},
    flockRowPutIfAbsent: async () => ({ inserted: true, value: null }),
  } satisfies LodyWorkspaceWriter;
  return { writer, metas };
}

const DISPATCH = {
  sessionId: "s-1",
  userTurnId: "t-1",
  userId: "local:u",
  timestamp: "2026-08-31T00:00:00.000Z",
  inputConfig: {},
};

describe("the default project a plain session is given", () => {
  it("registers the workspace root and names it on the session's meta", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { writer, metas } = recordingWriter();
    const decorated = withDefaultSessionProject(
      writer,
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );

    await decorated.startSession("s-1", { id: "s-1", cliType: "builtin" }, {}, DISPATCH);

    expect(calls).toEqual([{ type: "local-project/add", machineId: "m-1", rootPath: "/workspace" }]);
    expect(metas).toEqual([
      {
        id: "s-1",
        cliType: "builtin",
        // No `githubRepoFullName`, no `branch`, no `useWorktree`: this is a chat
        // that works in `/workspace`, not a repo-backed session. Each of those
        // fields would move it into the rail's GitHub Worktrees section, cut a
        // worktree, or send it down the branch-preparation path that refuses a
        // directory with no git repository in it.
        project: { kind: "local", localProjectId: "local--workspace" },
      },
    ]);
  });

  it("registers once, however many sessions are started", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { writer } = recordingWriter();
    const decorated = withDefaultSessionProject(
      writer,
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );

    await Promise.all([
      decorated.startSession("s-1", {}, {}, DISPATCH),
      decorated.startSession("s-2", {}, {}, DISPATCH),
    ]);
    await decorated.startSession("s-3", {}, {}, DISPATCH);

    expect(calls).toHaveLength(1);
  });

  it("leaves a session that already picked a project alone", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { writer, metas } = recordingWriter();
    const decorated = withDefaultSessionProject(
      writer,
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );
    const worktree = {
      kind: "local",
      localProjectId: "local-repo",
      branch: "main",
      githubRepoFullName: "blitzdotdev/BlitzOS",
      useWorktree: true,
    };

    await decorated.startSession("s-1", { project: worktree }, {}, DISPATCH);

    expect(metas).toEqual([{ project: worktree }]);
    expect(calls).toEqual([]);
  });

  it("leaves a repo-backed session alone even before it has a ProjectRef", async () => {
    // `buildSessionCreateResult` writes `repoFullName` and `isWorktree` from
    // their own payload inputs (`use-session-actions.ts:159`, `:166`), so this
    // shape is one the create path can produce. Giving it `/workspace` would
    // point the agent at the workspace root instead of letting the daemon cut it
    // a worktree — the same rule §3's backfill reads, from the same predicate.
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { writer, metas } = recordingWriter();
    const decorated = withDefaultSessionProject(
      writer,
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );
    const repoBacked = { id: "s-1", repoFullName: "blitzdotdev/BlitzOS", isWorktree: true };

    await decorated.startSession("s-1", { ...repoBacked }, {}, DISPATCH);

    expect(metas).toEqual([repoBacked]);
    expect(calls).toEqual([]);
  });

  it("writes the session unchanged when the daemon refuses the registration", async () => {
    const { fetchImpl } = projectControlStub((call) => ({
      ok: false,
      type: call.type,
      error: "workspace_not_found",
      message: "No active workspace runtime is available",
    }));
    const { writer, metas } = recordingWriter();
    const resolve = createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1");
    const decorated = withDefaultSessionProject(writer, resolve);

    await decorated.startSession("s-1", { id: "s-1" }, {}, DISPATCH);

    // A `localProjectId` the daemon cannot resolve FAILS the turn
    // (`session-execution-service.ts:3320`), so a refusal has to degrade to
    // upstream's own behavior rather than to a guess.
    expect(metas).toEqual([{ id: "s-1" }]);
    expect(await resolve()).toBeNull();
  });

  it("retries a refusal rather than caching it for the tab's lifetime", async () => {
    let refuse = true;
    const { fetchImpl, calls } = projectControlStub((call) => {
      if (!refuse) return addAccepted(call);
      refuse = false;
      return { ok: false, type: call.type, error: "workspace_not_found", message: "not yet" };
    });
    const resolve = createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1");

    expect(await resolve()).toBeNull();
    expect(await resolve()).toEqual({ kind: "local", localProjectId: "local--workspace" });
    expect(await resolve()).toEqual({ kind: "local", localProjectId: "local--workspace" });
    expect(calls).toHaveLength(2);
  });
});

/**
 * THE SESSIONS THAT PREDATE THE FIX ABOVE, which is the second half of the same
 * report: a canary box running the fix still opened every session created
 * before it onto "Session has no local project or GitHub repository workspace".
 * Nothing was wrong with those sessions except a missing `project`, and the
 * member cannot be told to abandon the conversation, so opening one attaches
 * the same default (`workdir-default.ts` §3).
 */

/** What `buildInitialSessionMetaPatch` wrote for a plain chat BEFORE §2 shipped:
 * everything a session has, and no `project`. */
const LEGACY_META: JsonObject = {
  id: "s-1",
  machineId: "m-1",
  userId: "local:u",
  createdAt: "2026-08-20T00:00:00.000Z",
  cliType: "builtin",
  agentType: "claude",
};

/** A runtime holding ONE session document, recording what was read and written.
 * `state.meta` is mutable so a document that arrives late can arrive. */
function backfillRuntime(meta: JsonObject | undefined) {
  const state: { meta: JsonObject | undefined; deleted: boolean } = { meta, deleted: false };
  const reads: string[] = [];
  const writes: { roomId: string; patch: Record<string, JsonValue | undefined> }[] = [];
  const stub = {
    ensureDocStream: async () => {},
    repo: {
      getDocMeta: async (roomId: string) => {
        reads.push(roomId);
        return state.meta === undefined ? undefined : { meta: state.meta, deleted: state.deleted };
      },
    },
    writer: {
      upsertDocMeta: async (roomId: string, patch: Record<string, JsonValue | undefined>) => {
        writes.push({ roomId, patch });
      },
    },
  };
  // SAFETY: `backfillDefaultSessionProject` reaches exactly `ensureDocStream`,
  // `repo.getDocMeta` and `writer.upsertDocMeta`. Every other member of
  // `LodyWorkspaceRuntime` is unreachable from it, so a call that grew one would
  // fail here rather than pass against a stub that answered anything.
  return { runtime: stub as unknown as LodyWorkspaceRuntime, state, reads, writes };
}

const WORKSPACE_PROJECT = { kind: "local", localProjectId: "local--workspace" };

describe("the default project a session created before the fix is given", () => {
  it("attaches it when the session is opened", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { runtime, writes } = backfillRuntime(LEGACY_META);

    const outcome = await backfillDefaultSessionProject(
      runtime,
      "s-1",
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );

    expect(outcome).toBe("attached");
    expect(calls).toEqual([{ type: "local-project/add", machineId: "m-1", rootPath: "/workspace" }]);
    // The session room, and only the `project` key: everything else the member
    // wrote over the session's life stays exactly as it is.
    expect(writes).toEqual([
      { roomId: getSessionRoomId("s-1"), patch: { project: WORKSPACE_PROJECT } },
    ]);
  });

  it("leaves a worktree session alone", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { runtime, writes } = backfillRuntime({
      ...LEGACY_META,
      project: {
        kind: "local",
        localProjectId: "local-repo",
        branch: "main",
        githubRepoFullName: "blitzdotdev/BlitzOS",
        useWorktree: true,
      },
      repoFullName: "blitzdotdev/BlitzOS",
      isWorktree: true,
    });

    const outcome = await backfillDefaultSessionProject(
      runtime,
      "s-1",
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );

    expect(outcome).toBe("not-a-plain-chat");
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("leaves a repo-backed session that has picked no project alone", async () => {
    const { fetchImpl } = projectControlStub(addAccepted);
    // `repoFullName` is written from its own input and does not imply `project`
    // (`use-session-actions.ts:159`). Overwriting one with `/workspace` would
    // move a repo session into the wrong directory.
    const { runtime, writes } = backfillRuntime({
      ...LEGACY_META,
      repoFullName: "blitzdotdev/BlitzOS",
    });

    const outcome = await backfillDefaultSessionProject(
      runtime,
      "s-1",
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );

    expect(outcome).toBe("not-a-plain-chat");
    expect(writes).toEqual([]);
  });

  it("waits for a document that has not synced, and attaches when it arrives", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const backfill = createSessionProjectBackfiller(
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );
    // A room the repo has opened but not filled. An empty meta reads exactly
    // like a plain chat's, so a worktree session caught here would be given
    // `/workspace` over its own project — which is what `createdAt` prevents.
    const { runtime, state, writes } = backfillRuntime({});

    expect(await backfill(runtime, "s-1")).toBe("meta-unavailable");
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);

    state.meta = LEGACY_META;
    expect(await backfill(runtime, "s-1")).toBe("attached");
    expect(writes).toHaveLength(1);
  });

  it("reads once and writes once when one session is opened twice at once", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const backfill = createSessionProjectBackfiller(
      createDefaultSessionProjectResolver({ ...PLANE_ENDPOINTS, fetchImpl }, "m-1"),
    );
    const { runtime, reads, writes } = backfillRuntime(LEGACY_META);

    const raced = await Promise.all([backfill(runtime, "s-1"), backfill(runtime, "s-1")]);
    // And once more after both settled: the decision is remembered, so a member
    // who leaves the session and comes back pays nothing.
    expect(await backfill(runtime, "s-1")).toBe("attached");

    expect(raced).toEqual(["attached", "attached"]);
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

/** The hook's props, with the parts no test varies filled in. */
function backfillProps(
  fetchImpl: typeof fetch,
  over: Partial<SessionProjectBackfillInput>,
): SessionProjectBackfillInput {
  return {
    store: createStore(),
    endpoints: {
      syncUrl: "https://box.invalid/lody/sync",
      filesBase: "https://box.invalid/files",
      ...PLANE_ENDPOINTS,
      fetchImpl,
    },
    machineId: "m-1",
    sessionId: "s-1",
    shared: false,
    ...over,
  };
}

describe("the surface seam that opens a session", () => {
  it("attaches the default project to the session it was shown", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { runtime, writes } = backfillRuntime(LEGACY_META);
    const props = backfillProps(fetchImpl, {});
    props.store.set(runtimeAtom, runtime);

    const view = await render(createElement(BackfillProbe, props));
    await settle();
    await view.unmount();

    expect(calls).toHaveLength(1);
    expect(writes).toEqual([
      { roomId: getSessionRoomId("s-1"), patch: { project: WORKSPACE_PROJECT } },
    ]);
  });

  it("writes nothing on a shared surface", async () => {
    const { fetchImpl, calls } = projectControlStub(addAccepted);
    const { runtime, reads, writes } = backfillRuntime(LEGACY_META);
    // Everything else is the case above, so what is under test is the guard and
    // nothing else: the session document belongs to the box's owner, and a
    // grantee who opened their surface must not rewrite the owner's session.
    const props = backfillProps(fetchImpl, { shared: true });
    props.store.set(runtimeAtom, runtime);

    const view = await render(createElement(BackfillProbe, props));
    await settle();
    await view.unmount();

    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does nothing on the chat landing, where no session is open", async () => {
    const { fetchImpl } = projectControlStub(addAccepted);
    const { runtime, reads } = backfillRuntime(LEGACY_META);
    const props = backfillProps(fetchImpl, { sessionId: null });
    props.store.set(runtimeAtom, runtime);

    const view = await render(createElement(BackfillProbe, props));
    await settle();
    await view.unmount();

    expect(reads).toEqual([]);
  });
});

function BackfillProbe(props: SessionProjectBackfillInput) {
  useDefaultSessionProjectBackfill(props);
  return null;
}

/** Polls until `read` answers with something, for the one thing that is not
 * synchronous here: the session document reaching the daemon. */
async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!lodyDaemonAvailable())("a plain session against a real daemon", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;

  const endpoints = () => ({
    rpcUrl: harness.endpoints.rpcUrl,
    controlUrl: harness.endpoints.controlUrl,
    projectUrl: harness.endpoints.projectUrl,
    platformUrl: harness.endpoints.platformUrl,
  });

  /** The session's `ProjectRef` as it landed in the session document, which is
   * where the daemon's dispatch watcher reads it (`:1990`). */
  const sessionProject = async (sessionId: string): Promise<LodyProjectRef | undefined> => {
    const snapshotRead = await handle.runtime.repo.getDocMeta(getSessionRoomId(sessionId));
    // SAFETY: `LodyDocMetaSnapshot.meta` IS `SessionMeta` for a session room
    // (`runtime.ts`), and `project` is that type's own `ProjectRef` field.
    return snapshotRead?.meta.project as LodyProjectRef | undefined;
  };

  /** One File Preview v3 read, polled until the session document has reached
   * the daemon. `session_not_found` is the only answer that means "not yet";
   * every other code is a real result this suite wants to assert on. */
  const previewFile = (sessionId: string, path: string) =>
    until(`the daemon to preview ${path} for ${sessionId}`, async () => {
      const response = await sendMachineRpc(endpoints(), {
        machineId: snapshot.machineId,
        workspaceId: snapshot.workspace.workspaceId,
        method: "file/preview-local",
        params: { v: 3, sessionId, path },
        timeoutMs: 30_000,
      });
      if (!response.ok) return undefined;
      // SAFETY: `FilePreviewV3ResponseSchema` (`shared/src/file-preview.ts:190`),
      // whose `content` for a small UTF-8 file is the `utf8-plain` arm.
      const answer = response.result as unknown as {
        status: string;
        code?: string;
        path?: string;
        external?: boolean;
        content?: { encoding: string; text: string };
      };
      return answer.code === "session_not_found" ? undefined : answer;
    });

  /** One Code Collab v2 call, polled the same way and read the same way: a
   * refusal is `{ status: 'error', code }` (`CodeCollabV2ErrorSchema`,
   * `shared/src/code-collab.ts:218`), so `code` is what says which refusal it
   * is — the same field File Preview answers with. */
  const codeCollab = (sessionId: string, method: string, params: JsonObject) =>
    until(`the daemon to answer ${method} for ${sessionId}`, async () => {
      const response = await sendMachineRpc(endpoints(), {
        machineId: snapshot.machineId,
        workspaceId: snapshot.workspace.workspaceId,
        method,
        params,
        timeoutMs: 30_000,
      });
      if (!response.ok) return undefined;
      // SAFETY: every Code Collab v2 response is either an ok member or
      // `CodeCollabV2ErrorSchema`, whose discriminant is `status: 'error'`.
      const answer = response.result as unknown as {
        code?: string;
        status?: string;
        fileIndex?: Record<string, unknown>;
      };
      return answer.code === "session_not_found" ? undefined : answer;
    });

  const startPlainSession = async (sessionId: string): Promise<void> => {
    await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "(probe: no turn is dispatched)",
    });
  };

  beforeAll(async () => {
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    // `filesRoot` is the harness's stand-in for the box's `/workspace`, and it
    // is what the runtime registers as the default project — so the file the
    // chip names goes there, not into the daemon's data dir.
    writeFileSync(join(harness.endpoints.filesRoot, "CLAUDE.md"), "# workspace rules\n");
    handle = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.dispose();
    await harness?.stop();
  });

  it("registers the workspace root and names it on the session with no repo", async () => {
    await startPlainSession("plainwd00001");

    const project = await sessionProject("plainwd00001");
    expect(project?.kind).toBe("local");
    expect(project?.useWorktree).toBeUndefined();
    expect(project?.githubRepoFullName).toBeUndefined();

    const listed = await sendProjectControl(endpoints(), {
      type: "local-project/list",
      machineId: snapshot.machineId,
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    // SAFETY: `LocalProjectControlResponseSchema` accepted this body inside
    // `sendProjectControl`; the `local-project/list` member's result carries
    // exactly these fields (`message-schemas.ts:2413`).
    const result = listed.result as unknown as {
      workspaces: { projects: { localProjectId: string; rootPath: string }[] }[];
    };
    const registered = result.workspaces
      .flatMap((workspace) => workspace.projects)
      .find((row) => row.localProjectId === project?.localProjectId);
    expect(registered?.rootPath).toBe(harness.endpoints.filesRoot);
  }, 60_000);

  it("opens BOTH a relative and an absolute file chip", async () => {
    await startPlainSession("plainwd00002");
    // The exact call the viewer makes for a chip
    // (`workspace-machine-rpc-facade.ts:207`). No agent has run, so the daemon
    // resolves the root from the session document's `project` alone
    // (`message-handler.ts:6238`) — which is the whole point: the fix has to
    // hold before a turn, because the chip is clicked after one. The poll is
    // for that document reaching the daemon, not for the resolution.
    const relative = await previewFile("plainwd00002", "CLAUDE.md");
    expect(relative.status).toBe("ok");
    expect(relative.path).toBe("CLAUDE.md");
    expect(relative.external).not.toBe(true);
    expect(relative.content?.text).toBe("# workspace rules\n");

    // The ABSOLUTE chip fails on canary too, and earlier than path resolution:
    // with no `project` the session has no workspace root at all, so the
    // daemon answers `workspace_unavailable` (`message-handler.ts:6355`) and
    // the viewer says the session has no local project. It is the same fix, so
    // it is the same test.
    const absolute = await previewFile(
      "plainwd00002",
      join(harness.endpoints.filesRoot, "CLAUDE.md"),
    );
    expect(absolute.status).toBe("ok");
    expect(absolute.content?.text).toBe("# workspace rules\n");
  }, 60_000);

  it("serves the Files tree and All Changes for a session with no repo", async () => {
    await startPlainSession("plainwd00003");
    // `useCodeCollabSessionFileProvider` is what the Files tab and every chip
    // hang off, and both calls resolve the same workspace root the preview
    // does. Before the fix both answered `workspace_unavailable`.
    const index = await codeCollab("plainwd00003", "code-collab/get-file-index", {
      sessionId: "plainwd00003",
    });
    expect(index.code).toBeUndefined();
    expect(index.status).toBe("ok");
    expect(Object.keys(index.fileIndex ?? {})).toContain("CLAUDE.md");

    const changes = await codeCollab("plainwd00003", "code-collab/open-all-changes-diff", {
      sessionId: "plainwd00003",
    });
    // The workspace root is not a git repository, so there is nothing to diff —
    // and that is an EMPTY answer, not the `workspace_root_unavailable` error
    // the tab used to render.
    expect(changes.code).toBeUndefined();
  }, 60_000);

  it("heals a session that was created before the default project existed", async () => {
    // A LEGACY SESSION, WRITTEN PAST THE DECORATOR. `startLodySession` goes
    // through the writer §2 decorates, so a session started that way can never
    // lack a project; the meta is written directly instead, with exactly the
    // fields `buildInitialSessionMetaPatch` wrote before §2 existed. No history
    // entry and no dispatch pointer, so nothing launches an agent — which is
    // also the state the reported session is in, days after its last turn.
    const roomId = getSessionRoomId("plainwd00004");
    await handle.runtime.ensureDocStream(roomId);
    await handle.runtime.writer.upsertDocMeta(roomId, {
      id: "plainwd00004",
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      createdAt: new Date().toISOString(),
      cliType: "builtin",
      agentType: "claude",
      isArchived: false,
    });

    // What the member sees today, and the whole of the report: the Files tab,
    // All Changes and every chip render this refusal's message.
    const before = await codeCollab("plainwd00004", "code-collab/get-file-index", {
      sessionId: "plainwd00004",
    });
    expect(before.code).toBe("workspace_root_unavailable");
    expect(await sessionProject("plainwd00004")).toBeUndefined();

    // What opening it now does.
    const backfill = createSessionProjectBackfiller(
      createDefaultSessionProjectResolver(endpoints(), snapshot.machineId, harness.endpoints.filesRoot),
    );
    expect(await backfill(handle.runtime, "plainwd00004")).toBe("attached");

    const project = await sessionProject("plainwd00004");
    expect(project?.kind).toBe("local");
    expect(project?.useWorktree).toBeUndefined();
    // And the panel the report was about answers again. No turn has run in this
    // session, so the daemon resolves the root from the document alone — which
    // is the whole point: the member's existing conversation gets its files back
    // without being restarted.
    const index = await until("the Files tree to come back", async () => {
      const answer = await codeCollab("plainwd00004", "code-collab/get-file-index", {
        sessionId: "plainwd00004",
      });
      return answer.code === "workspace_root_unavailable" ? undefined : answer;
    });
    expect(index.code).toBeUndefined();
    expect(Object.keys(index.fileIndex ?? {})).toContain("CLAUDE.md");
  }, 90_000);
});
