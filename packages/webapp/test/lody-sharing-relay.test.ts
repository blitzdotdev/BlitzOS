/**
 * PHASE 6 EXIT TESTS 1, 2 and 4 (plans/LODY-SHARING.md §7), against a real
 * daemon.
 *
 * `packages/box/guest-tests/test/lody-bridge-share.test.ts` proves the ACL is
 * the one the corpus specifies, frame by frame, against a stand-in daemon. What
 * that cannot prove is the thing the feature is FOR: that a grantee holding a
 * read-only claim really does receive another member's live session document
 * through the real bridge and the real `lody` daemon, and that its own writes
 * really do not land in the owner's replica.
 *
 * SO THE GRANTEE HERE IS A RAW PROTOCOL-V7 PEER, not a second mounted surface.
 * That is the honest shape for what phase 6 shipped: the renderer's local plane
 * is a singleton on `window.ipc` (`plans/LODY-SHARING.md` §6.1), so a second
 * mounted runtime is the deferred follow-up — while a protocol peer is a
 * first-class participant on this wire and is exactly what the relay's ACL
 * decides about.
 *
 * The claim arrives on the header the gateway sets. The gateway's own half —
 * verifying the ticket the claim came in, and refusing every path but `/lody/*`
 * — is `packages/box/gateway/main_test.go`; the harness's shim forwards headers
 * the way the real gateway does after it has verified one.
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { createStore } from "jotai";
import { LoroDoc } from "loro-crdt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { sendMachineRpc } from "../src/lody/rpc-client.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
  type LodyRuntimeHandle,
} from "../src/lody/runtime.js";
import { startLodySession } from "../src/lody/session.js";
import {
  HARNESS_BOOT_TIMEOUT_MS,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";

const SHARE_HEADER = "X-Blitz-Lody-Share";
const PROTOCOL_VERSION = 7;
/** The prompt is the transcript, as far as this test is concerned: it is the one
 * string a grantee must be able to read out of the owner's session document. */
const SEEDED_PROMPT = "the transcript a grantee must be able to follow";
/** A key no Lody schema knows, so its presence in the owner's replica can only
 * mean the relay forwarded the write that carried it. */
const PROBE_CONTAINER = "blitzShareProbe";

interface Claim {
  target: string;
  scope: "sessions" | "all";
  read: string[];
  write: string[];
}

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!lodyDaemonAvailable())("phase 6: a grantee on the real relay", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  let sessionId = "";
  const store = createStore();
  const sockets: NodeWebSocket[] = [];

  /** One protocol-v7 peer holding a claim, with the frames it received. */
  async function peer(claim: Claim | null): Promise<{
    frames: Record<string, unknown>[];
    send: (frame: Record<string, unknown>) => void;
    peerId: string;
    close: () => void;
  }> {
    const options = claim === null
      ? {}
      : { headers: { [SHARE_HEADER]: JSON.stringify(claim) } };
    const socket = new NodeWebSocket(harness.endpoints.syncUrl, options);
    sockets.push(socket);
    const frames: Record<string, unknown>[] = [];
    socket.on("message", (data: Buffer | string) => {
      frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const peerId = `renderer:${randomUUID()}`;
    return {
      frames,
      peerId,
      send: (frame) => socket.send(JSON.stringify(frame)),
      close: () => socket.close(),
    };
  }

  function joinFrame(peerId: string, docId: string, haveVersion?: string): Record<string, unknown> {
    const frame: Record<string, unknown> = {
      type: "join",
      protocolVersion: PROTOCOL_VERSION,
      requestId: randomUUID(),
      workspaceId: snapshot.workspace.workspaceId,
      peerId,
      room: { scope: "doc", docId },
    };
    if (haveVersion !== undefined) frame.haveVersion = haveVersion;
    return frame;
  }

  /** The `joined` frame's payload, imported into a fresh replica. */
  async function readRoom(claim: Claim | null, docId: string): Promise<LoroDoc> {
    const client = await peer(claim);
    client.send(joinFrame(client.peerId, docId));
    const joined = await until(`a joined frame for ${docId}`, () =>
      client.frames.find((frame) => frame.type === "joined"),
    );
    const doc = new LoroDoc();
    const payload = joined.payload as { kind?: string; dataBase64?: string } | undefined;
    if (payload?.dataBase64 !== undefined && payload.dataBase64 !== "") {
      doc.import(Buffer.from(payload.dataBase64, "base64"));
    }
    client.close();
    return doc;
  }

  const ownerClaim = (level: "read" | "write"): Claim => ({
    target: "membership-owner",
    scope: "sessions",
    read: level === "read" ? [sessionId] : [],
    write: level === "write" ? [sessionId] : [],
  });

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
    sessionId = randomUUID();
    await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: "blitz-claude",
      agentType: "claude",
      prompt: SEEDED_PROMPT,
      title: "phase 6 exit test",
    });
    // The accept unit is a LOCAL durable write; the daemon learns about it when
    // that write reaches it over the data plane, and a grantee reads it out of
    // the room only after that. Polling the room IS the wait — there is no
    // cheaper probe for "the daemon holds this session" than reading it.
    await untilRoom(
      "the seeded transcript to reach the daemon's room",
      `session-${sessionId}`,
      SEEDED_PROMPT,
    );
  }, HARNESS_BOOT_TIMEOUT_MS);

  /** Reads the room until `text` appears in it, or fails saying what it saw. */
  async function untilRoom(what: string, docId: string, text: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let seen = "";
    for (;;) {
      const doc = await readRoom({ target: "membership-owner", scope: "all", read: [], write: [] }, docId);
      seen = JSON.stringify(doc.toJSON());
      if (seen.includes(text)) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; room held ${seen.slice(0, 400)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** True once `text` appears in the room, false if it never does. */
  async function roomEventuallyHolds(docId: string, text: string, timeoutMs = 10_000): Promise<boolean> {
    try {
      await untilRoom(text, docId, text, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    unmountLodyRuntimeAtoms(store);
    await handle?.dispose();
    await harness?.stop();
  }, 60_000);

  // EXIT TEST 1, first half.
  it("streams the owner's transcript to a read-only grantee", async () => {
    const doc = await readRoom(ownerClaim("read"), `session-${sessionId}`);
    const seen = JSON.stringify(doc.toJSON());
    expect(seen).toContain(SEEDED_PROMPT);
  }, 60_000);

  // EXIT TEST 1, second half, and EXIT TEST 2's write half. One case, because
  // the two are the same act judged by two claims, and asserting them apart
  // would let a relay that forwards nothing pass the first.
  it("drops a read-only grantee's write and forwards a read-write grantee's", async () => {
    const room = `session-${sessionId}`;

    /** A real Loro update, authored against a replica of the owner's document
     * so the daemon can apply it. */
    const authorProbe = async (value: string): Promise<string> => {
      const doc = await readRoom(ownerClaim("read"), room);
      const before = doc.version();
      doc.getMap(PROBE_CONTAINER).set("wrote", value);
      doc.commit();
      return Buffer.from(doc.export({ mode: "update", from: before })).toString("base64");
    };

    const readOnly = await peer(ownerClaim("read"));
    readOnly.send(joinFrame(readOnly.peerId, room));
    await until("the read-only join", () => readOnly.frames.find((frame) => frame.type === "joined"));
    readOnly.send({
      type: "update",
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: snapshot.workspace.workspaceId,
      peerId: readOnly.peerId,
      room: { scope: "doc", docId: room },
      payload: { kind: "doc-update", dataBase64: await authorProbe("read-only") },
    });
    // Read from a FRESH replica rather than the writer's own: a CRDT client
    // always sees its own change locally, which is exactly why "read-only" is
    // about what the relay applies and not about what the client believes.
    expect(await roomEventuallyHolds(room, "read-only", 4_000)).toBe(false);
    readOnly.close();

    const readWrite = await peer(ownerClaim("write"));
    readWrite.send(joinFrame(readWrite.peerId, room));
    await until("the read-write join", () => readWrite.frames.find((frame) => frame.type === "joined"));
    readWrite.send({
      type: "update",
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: snapshot.workspace.workspaceId,
      peerId: readWrite.peerId,
      room: { scope: "doc", docId: room },
      payload: { kind: "doc-update", dataBase64: await authorProbe("read-write") },
    });
    expect(await roomEventuallyHolds(room, "read-write")).toBe(true);
    readWrite.close();
  }, 120_000);

  // EXIT TEST 4.
  it("gives a workspace admin every room with no grant row at all", async () => {
    const admin: Claim = { target: "membership-owner", scope: "all", read: [], write: [] };
    const doc = await readRoom(admin, `session-${sessionId}`);
    expect(JSON.stringify(doc.toJSON())).toContain(SEEDED_PROMPT);

    // …and nothing more than read. The admin's implicit access carries no write
    // list, and the predicate that decides a write never reads `scope`.
    const client = await peer(admin);
    client.send(joinFrame(client.peerId, `session-${sessionId}`));
    await until("the admin join", () => client.frames.find((frame) => frame.type === "joined"));
    const replica = await readRoom(admin, `session-${sessionId}`);
    const before = replica.version();
    replica.getMap(PROBE_CONTAINER).set("wrote", "admin-implicit");
    replica.commit();
    client.send({
      type: "update",
      protocolVersion: PROTOCOL_VERSION,
      workspaceId: snapshot.workspace.workspaceId,
      peerId: client.peerId,
      room: { scope: "doc", docId: `session-${sessionId}` },
      payload: {
        kind: "doc-update",
        dataBase64: Buffer.from(replica.export({ mode: "update", from: before })).toString("base64"),
      },
    });
    expect(await roomEventuallyHolds(`session-${sessionId}`, "admin-implicit", 4_000)).toBe(false);
    client.close();
  }, 90_000);

  it("refuses a room the claim does not name, on the real daemon", async () => {
    const client = await peer(ownerClaim("read"));
    client.send(joinFrame(client.peerId, `session-${randomUUID()}`));
    const refusal = await until("the refusal", () =>
      client.frames.find((frame) => frame.type === "error"),
    );
    expect(refusal.code).toBe("room_forbidden");
    expect(refusal.terminal).toBe(true);
    client.close();
  }, 60_000);

  // The "and its diffs" half of exit test 1, and the RPC scope end to end.
  it("answers a granted session's diff RPC and refuses an ungranted act", async () => {
    const endpoints = {
      rpcUrl: harness.endpoints.rpcUrl,
      controlUrl: harness.endpoints.controlUrl,
      projectUrl: harness.endpoints.projectUrl,
      platformUrl: harness.endpoints.platformUrl,
      fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set(SHARE_HEADER, JSON.stringify(ownerClaim("read")));
        return fetch(input, { ...init, headers });
      }) as typeof fetch,
    };
    // A STRUCTURED answer is the proof the plane routed the method: the session
    // has no turn to diff, so the daemon's own refusal is the success here.
    const diff = await sendMachineRpc(endpoints, {
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      method: "code-collab/open-turn-diff",
      params: { sessionId, turnId: randomUUID() },
    });
    expect(diff.ok === false ? diff.error : "routed").not.toBe("share_forbidden");

    const cancel = await sendMachineRpc(endpoints, {
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
      method: "session/cancel",
      params: { sessionId, turnId: randomUUID() },
    });
    expect(cancel).toEqual({ ok: false, error: "share_forbidden" });
  }, 60_000);
});
