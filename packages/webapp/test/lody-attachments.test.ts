/**
 * PHASE 6 SLICE 0 — the `+` attachment handoff (plans/LODY-SESSIONS.md §0.7,
 * plans/LODY-RUNTIME-DESIGN.md §10.4), and the worktree pill's seeded default
 * (§0.5).
 *
 * Phase 5 left `+` as the one composer control BlitzOS could not serve: the
 * local fast path is gated on `__LODY_ELECTRON__`, and the cloud fallback behind
 * it uploads to Lody cloud. Seam patch 3 widens that predicate, and the channel
 * behind it is what this file drives — first against a stub `fetch`, then, when a
 * `lody` bundle is installed, end to end into a real daemon's blob store.
 */
import "fake-indexeddb/auto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStore } from "jotai";
import { WebSocket as NodeWebSocket } from "ws";
import { createLodyLocalBridge } from "../src/lody/local-bridge.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
  type LodyRuntimeHandle,
} from "../src/lody/runtime.js";
import {
  isSendSessionFileLocalInput,
  uploadSessionAttachments,
  SESSION_ATTACHMENTS_DIR,
} from "../src/lody/session-attachments.js";
import { startLodySession } from "../src/lody/session.js";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { seedWorktreeWorkdirDefault } from "../src/lody/workdir-default.js";
import { lodyDaemonAvailable, startLodyHarness, type LodyHarness } from "./lody-daemon-harness.js";

const FILES_BASE = "https://cp.invalid/workspaces/w1/webapp/7445/workspace/";

interface DavCall {
  method: string;
  url: string;
  body: string;
}

/** A dufs stand-in narrow enough to state the whole contract in one place: which
 * status each method answers, and nothing about the bytes. */
function davStub(status: (call: DavCall) => number): {
  fetchImpl: typeof fetch;
  calls: DavCall[];
} {
  const calls: DavCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const raw = init?.body;
    const body = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : "";
    const call: DavCall = { method: init?.method ?? "GET", url, body };
    calls.push(call);
    return new Response(null, { status: status(call) });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function bytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return buffer;
}

describe("session attachments stage over WebDAV", () => {
  it("creates both collections, then PUTs, and reports the box's own paths", async () => {
    const { fetchImpl, calls } = davStub(({ method }) => (method === "MKCOL" ? 201 : 201));
    const result = await uploadSessionAttachments(
      { filesBase: FILES_BASE, fetchImpl },
      "s-1",
      [{ fileName: "notes.md", bytes: bytes("hello") }],
    );
    expect(result).toEqual({
      ok: true,
      paths: [`/workspace/${SESSION_ATTACHMENTS_DIR}/s-1/0-notes.md`],
      staged: [[SESSION_ATTACHMENTS_DIR, "s-1", "0-notes.md"]],
    });
    expect(calls.map((call) => `${call.method} ${call.url.slice(FILES_BASE.length)}`)).toEqual([
      `MKCOL ${SESSION_ATTACHMENTS_DIR}/`,
      `MKCOL ${SESSION_ATTACHMENTS_DIR}/s-1/`,
      `PUT ${SESSION_ATTACHMENTS_DIR}/s-1/0-notes.md`,
    ]);
    expect(calls[2]?.body).toBe("hello");
  });

  it("treats a collection that already exists as success", async () => {
    const { fetchImpl } = davStub(({ method }) => (method === "MKCOL" ? 405 : 201));
    const result = await uploadSessionAttachments(
      { filesBase: FILES_BASE, fetchImpl },
      "s-2",
      [{ fileName: "a.png", bytes: bytes("x") }],
    );
    expect(result.ok).toBe(true);
  });

  it("removes what it already wrote when a later PUT fails", async () => {
    const { fetchImpl, calls } = davStub((call) =>
      call.method === "PUT" && call.url.endsWith("1-b.txt") ? 507 : 201,
    );
    const result = await uploadSessionAttachments(
      { filesBase: FILES_BASE, fetchImpl },
      "s-3",
      [
        { fileName: "a.txt", bytes: bytes("a") },
        { fileName: "b.txt", bytes: bytes("b") },
      ],
    );
    expect(result).toEqual({ ok: false, error: "attachment_put_507" });
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      `${FILES_BASE}${SESSION_ATTACHMENTS_DIR}/s-3/0-a.txt`,
    ]);
  });

  it("names a MKCOL refusal rather than PUTting into nowhere", async () => {
    const { fetchImpl, calls } = davStub(({ method }) => (method === "MKCOL" ? 403 : 201));
    const result = await uploadSessionAttachments(
      { filesBase: FILES_BASE, fetchImpl },
      "s-4",
      [{ fileName: "a.txt", bytes: bytes("a") }],
    );
    expect(result).toEqual({ ok: false, error: "attachment_mkcol_403" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a payload whose bytes are not an ArrayBuffer", () => {
    expect(
      isSendSessionFileLocalInput({
        workspaceId: "lw_1",
        sessionId: "s-5",
        machineId: "m-1",
        files: [{ fileName: "a.txt", bytes: bytes("a") }],
      }),
    ).toBe(true);
    expect(
      isSendSessionFileLocalInput({
        workspaceId: "lw_1",
        sessionId: "s-5",
        machineId: "m-1",
        files: [{ fileName: "a.txt", bytes: "not-bytes" }],
      }),
    ).toBe(false);
    // An empty file list and a missing id are both refusals, so the channel
    // never reaches the box with nothing to stage.
    expect(
      isSendSessionFileLocalInput({
        workspaceId: "lw_1",
        sessionId: "s-5",
        machineId: "m-1",
        files: [],
      }),
    ).toBe(false);
    expect(isSendSessionFileLocalInput(undefined)).toBe(false);
  });
});

describe("the worktree pill's default", () => {
  it("seeds worktree mode once and never overwrites a stored choice", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    expect(seedWorktreeWorkdirDefault(storage)).toBe("worktree");
    expect(store.get("lody.workdirMode.global")).toBe("worktree");

    store.set("lody.workdirMode.global", "local");
    expect(seedWorktreeWorkdirDefault(storage)).toBe("local");
    expect(store.get("lody.workdirMode.global")).toBe("local");
  });
});

describe.skipIf(!lodyDaemonAvailable())("the attachment handoff reaches a real daemon", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  const store = createStore();

  beforeAll(async () => {
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    handle = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
    });
    mountLodyRuntimeAtoms(store, handle.runtime);
  }, 120_000);

  afterAll(async () => {
    unmountLodyRuntimeAtoms(store);
    await handle?.dispose();
    await harness?.stop();
  });

  /**
   * The whole channel, and the reason it is free.
   *
   * `session/file-send-local` only needs the session DOCUMENT to exist — it reads
   * `getDocMeta(getSessionRoomId(sessionId))` and refuses `session_not_found`
   * otherwise (`message-handler.ts:7554`) — so the accept unit `startLodySession`
   * writes is the whole prerequisite. No `session/create`, no adapter, no turn.
   * The daemon copies the bytes into its own blob store and answers with the
   * `transport: 'local'` blocks the composer attaches to the outgoing message,
   * which is the far end §0.7 asks for.
   */
  it("stages bytes on the box and hands the daemon a transport:'local' block", async () => {
    const sessionId = `att-${Date.now().toString(36)}`;
    await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "(probe: no turn is dispatched)",
    });

    const bridge = createLodyLocalBridge({
      ...harness.endpoints,
      webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
    });
    try {
      const handoff = async (): Promise<{ ok?: boolean; error?: string; files?: unknown[] }> => {
        const reply = await bridge.ipc.invoke("localProjects.sendSessionFileLocal", {
          workspaceId: snapshot.workspace.workspaceId,
          sessionId,
          machineId: snapshot.machineId,
          files: [{ fileName: "attached.txt", bytes: bytes("blitzos attachment") }],
        });
        // SAFETY: every arm of `LodyIpcReply` this channel returns is a JSON
        // object; the fields below are re-read defensively by the assertions.
        return reply as { ok?: boolean; error?: string; files?: unknown[] };
      };
      // `startSession` is a LOCAL durable write; the daemon learns about the
      // session when that write reaches it over the data plane, and until then
      // its own `getDocMeta` answers `session_not_found`. Polling the real call
      // is the honest wait — there is no cheaper probe for "the daemon has this
      // session" than asking it.
      let outcome = await handoff();
      const deadline = Date.now() + 30_000;
      while (outcome.error === "session_not_found" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        outcome = await handoff();
      }
      expect(outcome.error).toBeUndefined();
      expect(outcome.ok).toBe(true);
      const block = outcome.files?.[0] as
        | { type?: string; transport?: string; fileName?: string; machineId?: string }
        | undefined;
      expect(block?.type).toBe("file");
      expect(block?.transport).toBe("local");
      expect(block?.machineId).toBe(snapshot.machineId);

      // The staging directory is a hand-off, not storage: the bytes are in the
      // daemon's blob store by now, so the file is gone from the box again.
      const stagedPath = join(
        harness.endpoints.filesRoot,
        SESSION_ATTACHMENTS_DIR,
        sessionId,
        "0-attached.txt",
      );
      expect(existsSync(stagedPath)).toBe(false);
    } finally {
      bridge.dispose();
    }
  }, 120_000);
});
