// @vitest-environment node
/**
 * Browser-side conformance for the Lody data-plane frame contract
 * (`packages/schema/fixtures/lody-data-plane/`, CLAUDE.md cross-runtime rule).
 *
 * `webapp/src/lody/data-plane-connection.ts` is the first BlitzOS-authored
 * producer and parser of protocol v7, so the framing became ours in phase 2.
 * This validates the corpus against Lody's OWN schemas — not a copy — so an
 * upstream merge that changes the protocol fails here rather than in a session
 * that silently stops converging.
 *
 * Node environment: nothing here needs a DOM, and the `WebSocket` the
 * connection takes is injected.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES,
  LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES,
  LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE,
  LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION,
  DocUpdateChunkAssembler,
  LocalLoroDataPlaneClientMessageSchema,
  LocalLoroDataPlaneServerMessageSchema,
} from "@lody/shared/local-loro-data-plane";
import {
  createLodyDataPlaneConnection,
  lodyLiveDataPlaneSocketCount,
} from "../src/lody/data-plane-connection.js";

const CORPUS = fileURLToPath(new URL("../../schema/fixtures/lody-data-plane/", import.meta.url));

function read(relative: string): unknown {
  return JSON.parse(readFileSync(`${CORPUS}${relative}`, "utf8"));
}

function names(dir: string): string[] {
  return readdirSync(`${CORPUS}${dir}`)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

describe("lody data-plane frame corpus", () => {
  const constants = read("constants.json") as Record<string, unknown>;

  it("pins the constants both runtimes hard-code", () => {
    expect(constants.protocolVersion).toBe(LOCAL_LORO_DATA_PLANE_PROTOCOL_VERSION);
    expect(constants.maxFrameBytes).toBe(LOCAL_LORO_DATA_PLANE_MAX_FRAME_BYTES);
    expect(constants.maxPayloadBytes).toBe(LOCAL_LORO_DATA_PLANE_MAX_PAYLOAD_BYTES);
    expect(constants.payloadTooLargeCode).toBe(LOCAL_LORO_DATA_PLANE_PAYLOAD_TOO_LARGE);
  });

  it("accepts every client frame and covers every client type", () => {
    const seen = new Set<string>();
    for (const name of names("client")) {
      const frame = read(`client/${name}`);
      const parsed = LocalLoroDataPlaneClientMessageSchema.safeParse(frame);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      seen.add((frame as { type: string }).type);
    }
    expect([...seen].sort()).toEqual([...(constants.clientTypes as string[])].sort());
  });

  it("accepts every server frame and covers every server type", () => {
    const seen = new Set<string>();
    for (const name of names("server")) {
      if (name === "doc-update-chunked.json") continue;
      const frame = read(`server/${name}`);
      const parsed = LocalLoroDataPlaneServerMessageSchema.safeParse(frame);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      seen.add((frame as { type: string }).type);
    }
    expect([...seen].sort()).toEqual([...(constants.serverTypes as string[])].sort());
  });

  it("rejects every invalid frame on both sides", () => {
    const invalid = names("invalid");
    expect(invalid.length).toBeGreaterThan(0);
    for (const name of invalid) {
      const frame = read(`invalid/${name}`);
      const asClient = LocalLoroDataPlaneClientMessageSchema.safeParse(frame);
      const asServer = LocalLoroDataPlaneServerMessageSchema.safeParse(frame);
      expect(asClient.success || asServer.success, name).toBe(false);
    }
  });

  it("keeps forward compatibility: an unknown field does not fail a frame", () => {
    // The schemas are deliberately not `.strict()`, and the 0.88.1 daemon runs
    // ahead of the 0.76.0 subtree. A reader that rejected an added field would
    // turn every upstream release into an outage.
    const parsed = LocalLoroDataPlaneServerMessageSchema.safeParse(read("server/pong-with-unknown-field.json"));
    expect(parsed.success).toBe(true);
  });

  it("reassembles a chunked doc-update transfer, in order and exactly once", () => {
    const transfer = read("server/doc-update-chunked.json") as {
      reassembles_to: { dataBase64: string };
      frames: { payload: { transferId: string; chunkIndex: number; chunkCount: number; dataBase64: string } }[];
    };
    const assembler = new DocUpdateChunkAssembler();
    const completions: string[] = [];
    for (const frame of transfer.frames) {
      expect(LocalLoroDataPlaneServerMessageSchema.safeParse(frame).success).toBe(true);
      const done = assembler.push(frame.payload);
      if (done !== null) completions.push(done);
    }
    expect(completions).toEqual([transfer.reassembles_to.dataBase64]);
  });
});

/** A `WebSocket` that never opens and never fires, so the connection's parsing
 * and status behaviour can be driven without a server. */
class ScriptedWebSocket {
  static readonly instances: ScriptedWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly url: string) {
    ScriptedWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  openIt(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(raw: string): void {
    this.onmessage?.({ data: raw });
  }
  closeIt(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe("the browser connection parses the corpus at its boundary", () => {
  it("delivers valid frames, drops invalid ones, and counts what it dropped", () => {
    ScriptedWebSocket.instances.length = 0;
    const handle = createLodyDataPlaneConnection({
      url: "ws://127.0.0.1:1/lody/sync",
      // SAFETY: ScriptedWebSocket implements every member this module touches
      // (readyState, send, close, and the four handler properties); the cast
      // only satisfies the DOM lib's wider `WebSocket` declaration.
      webSocketConstructor: ScriptedWebSocket as unknown as typeof WebSocket,
    });
    const socket = ScriptedWebSocket.instances[0]!;
    expect(lodyLiveDataPlaneSocketCount()).toBe(1);
    const received: string[] = [];
    handle.connection.onMessage((message: { type: string }) => received.push(message.type));

    const statuses: boolean[] = [];
    handle.connection.onStatusChange((connected: boolean) => statuses.push(connected));
    // The immediate call-back is what the adapter uses to decide whether to
    // rejoin; a listener registered before `open` would otherwise never learn.
    expect(statuses).toEqual([false]);

    socket.openIt();
    expect(statuses).toEqual([false, true]);
    expect(handle.connection.isConnected()).toBe(true);

    const serverFixtures = names("server").filter((name) => name !== "doc-update-chunked.json");
    for (const name of serverFixtures) socket.deliver(JSON.stringify(read(`server/${name}`)));
    expect(received.length).toBe(serverFixtures.length);
    expect([...new Set(received)].sort()).toEqual(
      [...(read("constants.json") as { serverTypes: string[] }).serverTypes].sort(),
    );

    const delivered = received.length;
    const before = handle.stats();
    for (const name of names("invalid")) socket.deliver(JSON.stringify(read(`invalid/${name}`)));
    socket.deliver("{not json");
    const after = handle.stats();
    expect(after.rejected - before.rejected).toBe(names("invalid").length);
    expect(after.unparseable - before.unparseable).toBe(1);
    // A dropped frame is dropped, not thrown and not delivered.
    expect(received.length).toBe(delivered);

    handle.connection.send(read("client/ping.json") as never);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual(read("client/ping.json"));

    handle.dispose();
    expect(lodyLiveDataPlaneSocketCount()).toBe(0);
  });

  it("reports an established socket close and its redial as continuity edges", () => {
    vi.useFakeTimers();
    ScriptedWebSocket.instances.length = 0;
    const continuity: string[] = [];
    const handle = createLodyDataPlaneConnection({
      url: "ws://127.0.0.1:1/lody/sync",
      // SAFETY: ScriptedWebSocket implements every WebSocket member touched by
      // this module; the DOM declaration contains unrelated browser members.
      webSocketConstructor: ScriptedWebSocket as unknown as typeof WebSocket,
      onContinuity: (event) => continuity.push(event),
    });
    const socket = ScriptedWebSocket.instances[0];
    if (socket === undefined) throw new Error("the connection opened no socket");
    socket.openIt();
    socket.closeIt();
    expect(continuity).toEqual(["socket-close"]);

    vi.advanceTimersByTime(1_000);
    expect(continuity).toEqual(["socket-close", "socket-redial"]);
    expect(ScriptedWebSocket.instances).toHaveLength(2);
    handle.dispose();
    expect(lodyLiveDataPlaneSocketCount()).toBe(0);
    vi.useRealTimers();
  });

  it("reports a physical loss before open but not intentional disposal", () => {
    vi.useFakeTimers();
    try {
      ScriptedWebSocket.instances.length = 0;
      const continuity: string[] = [];
      const handle = createLodyDataPlaneConnection({
        url: "ws://127.0.0.1:1/lody/sync",
        // SAFETY: ScriptedWebSocket implements the complete subset used by
        // the connection, including the pre-open error callback driven here.
        webSocketConstructor: ScriptedWebSocket as unknown as typeof WebSocket,
        onContinuity: (event) => continuity.push(event),
      });
      const socket = ScriptedWebSocket.instances[0];
      if (socket === undefined) throw new Error("the connection opened no socket");
      socket.onerror?.();
      expect(continuity).toEqual(["socket-close"]);

      vi.advanceTimersByTime(1_000);
      expect(continuity).toEqual(["socket-close", "socket-redial"]);
      handle.dispose();
      expect(continuity).toEqual(["socket-close", "socket-redial"]);
      expect(lodyLiveDataPlaneSocketCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
