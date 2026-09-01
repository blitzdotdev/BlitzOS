// @vitest-environment node
/**
 * Phase-0 transport spike (plans/LODY-SESSIONS.md §4).
 *
 * Proves the replacement for Lody's private "Loro Streams" gateway before any
 * phase builds on it: two independent `loro-repo` instances converge a document
 * through a `loro-websocket` `SimpleServer` over a real localhost WebSocket,
 * survive a transport drop, and resume afterwards. It also pins the answer the
 * sharing/live-status work depends on — whether the same server relays
 * ephemeral (presence) rooms.
 *
 * Node environment on purpose: the server binds a real TCP port and the client
 * side is the same `transport/websocket` entry the browser will import.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoroRepo } from "loro-repo";
import { WebSocketTransportAdapter } from "loro-repo/transport/websocket";
import { SimpleServer } from "loro-websocket/server";
import { createServer } from "node:net";

const DOC_ID = "session-phase0-echo";
const SYNC_TIMEOUT_MS = 15_000;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("net server reported no numeric port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Polls `read` until it returns a value, or fails the test on timeout. */
async function until<T>(what: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface Side {
  repo: LoroRepo;
  adapter: WebSocketTransportAdapter;
}

async function openSide(url: string): Promise<Side> {
  const adapter = new WebSocketTransportAdapter({ url });
  const repo = await LoroRepo.create({ transportAdapter: adapter });
  return { repo, adapter };
}

describe("loro-repo over a loro-websocket SimpleServer", () => {
  let server: SimpleServer;
  let url: string;
  const opened: Side[] = [];

  beforeEach(async () => {
    const port = await freePort();
    url = `ws://127.0.0.1:${port}`;
    server = new SimpleServer({ port, host: "127.0.0.1" });
    await server.start();
  });

  afterEach(async () => {
    for (const side of opened.splice(0)) {
      await side.repo.destroy().catch(() => {});
    }
    await server.stop();
  });

  it("converges a doc between two repos, survives a drop, and resumes", async () => {
    const a = await openSide(url);
    const b = await openSide(url);
    opened.push(a, b);

    const handleA = await a.repo.openPersistedDoc(DOC_ID);
    const handleB = await b.repo.openPersistedDoc(DOC_ID);
    const roomA = await handleA.joinRoom();
    const roomB = await handleB.joinRoom();
    await roomA.firstSyncedWithRemote;
    await roomB.firstSyncedWithRemote;

    handleA.doc.getText("body").insert(0, "hello from side one");
    handleA.doc.commit();
    await roomA.waitUntilSynced();

    const converged = await until("side two to see side one's text", () => {
      const text = handleB.doc.getText("body").toString();
      return text.includes("hello from side one") ? text : undefined;
    });
    expect(converged).toBe("hello from side one");

    // Drop side two's transport entirely, write while it is gone, then bring a
    // transport back and assert the missed update arrives. This is the
    // reconnect path a browser tab takes across a box restart.
    await b.repo.removeTransport("default");
    expect(b.repo.hasTransport()).toBe(false);

    handleA.doc.getText("body").insert(converged.length, " / and an offline edit");
    handleA.doc.commit();
    await roomA.waitUntilSynced();

    const rejoined = new WebSocketTransportAdapter({ url });
    await b.repo.addTransport("default", rejoined);
    await b.repo.refreshTransportRoutes();

    const resumed = await until("side two to catch up after reconnect", () => {
      const text = handleB.doc.getText("body").toString();
      return text.includes("offline edit") ? text : undefined;
    });
    expect(resumed).toBe("hello from side one / and an offline edit");
  }, 60_000);

  it("relays ephemeral (presence) state through the same server", async () => {
    const a = await openSide(url);
    const b = await openSide(url);
    opened.push(a, b);

    const roomId = "presence-phase0";
    const ephemeralA = await a.repo.joinEphemeralRoom(roomId);
    const ephemeralB = await b.repo.joinEphemeralRoom(roomId);
    await ephemeralA.firstSyncedWithRemote;
    await ephemeralB.firstSyncedWithRemote;

    ephemeralA.store.set("member-1", { cursor: 42, status: "typing" });

    const seen = await until("side two to receive presence", () => {
      const value = ephemeralB.store.get("member-1");
      return value === undefined ? undefined : (value as { cursor: number; status: string });
    });
    expect(seen).toEqual({ cursor: 42, status: "typing" });

    ephemeralA.unsubscribe();
    ephemeralB.unsubscribe();
  }, 60_000);
});
