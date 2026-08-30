/**
 * PHASE 2 EXIT TEST (plans/LODY-SESSIONS.md §10, plans/LODY-RUNTIME-DESIGN.md).
 *
 * "Create a session from the browser; a turn dispatches; a reply streams."
 *
 * Everything under test is real: a patched `lody@0.88.1` daemon, the box's own
 * `blitz-lody-bridge`, our `window.ipc` install, our WebSocket data plane, our
 * three HTTP planes, and the vendored `createWorkspaceRuntime` in
 * `syncMode: 'local'`. The only stand-in is the Go gateway, which has no
 * toolchain here and is tested in `packages/box/gateway/main_test.go`.
 *
 * TWO GATES, DELIBERATELY:
 *
 * - The whole suite SKIPS when no `lody` bundle is installed, which is CI. A
 *   test that needs a 21 MB npm artifact cannot be a merge gate, and pretending
 *   otherwise with a mock would test the mock.
 * - The DISPATCH is skipped unless `BLITZ_LODY_LIVE_TURN=1`, because a dispatch
 *   launches the ACP adapter and spends a turn of somebody's subscription. Run
 *   the exit test with:
 *
 *     BLITZ_LODY_LIVE_TURN=1 npx vitest run test/lody-session-roundtrip.test.ts
 *
 * `packages/webapp/test/lody-data-plane-frames.test.ts` and
 * `packages/box/guest-tests/test/lody-bridge-frames.test.ts` are the parts that
 * DO gate every merge.
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { createStore } from "jotai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { bootstrapLodyAgentConfigs, blitzAgentConfigRows } from "../src/lody/agent-configs.js";
import { createLodyRuntime, mountLodyRuntimeAtoms, unmountLodyRuntimeAtoms, type LodyRuntimeHandle } from "../src/lody/runtime.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { dispatchLodyTurn, startLodySession } from "../src/lody/session.js";
import {
  claudeCredentialAvailable,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";

/** One minimal turn is the whole paid budget for this test, and it is spent
 * once. Never retried: a retry loop on a paid call is how a test bill becomes a
 * surprise. */
const LIVE_TURN_PROMPT = "reply with the word ok";
const LIVE_TURN_DEADLINE_MS = 90_000;

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

describe.skipIf(!lodyDaemonAvailable())("phase 2: a session round-trips against a real daemon", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  const store = createStore();
  /** Handed from the create test to the dispatch test; they are one flow split
   * in two so the paid half can be skipped without losing the free half. */
  let startedSession: Awaited<ReturnType<typeof startLodySession>> | null = null;

  beforeAll(async () => {
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    handle = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        // A real browser's `WebSocket` needs no injection. Under Vitest's jsdom
        // environment `globalThis.WebSocket` is undici's, whose `dispatchEvent`
        // rejects jsdom's `Event` class outright ("must be an instance of
        // Event. Received an instance of Event"), so no `open` or `message`
        // ever reaches a listener and the data plane looks silently dead.
        // SAFETY: `ws`'s WebSocket implements the four handler properties,
        // `readyState`, `send` and `close` that data-plane-connection.ts uses,
        // and its EventTarget shim decodes text frames to strings.
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
    });
    mountLodyRuntimeAtoms(store, handle.runtime);
  }, 180_000);

  afterAll(async () => {
    unmountLodyRuntimeAtoms(store);
    await handle?.dispose();
    await harness?.stop();
  }, 60_000);

  it("reads the daemon's own identity through /lody/platform", () => {
    // Not a BlitzOS membership id. Every local write and access check runs
    // against this one (`vendor/lody/packages/platform/src/local.ts:103`).
    expect(snapshot.userId.startsWith("local:")).toBe(true);
    expect(snapshot.workspace.workspaceId.startsWith("lw_")).toBe(true);
    expect(snapshot.machineId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("installs a non-Electron bridge and boots the runtime on it", async () => {
    // The seam patch's whole point: the local planes are reachable and no
    // Electron path is lit.
    expect(globalThis.window.__LODY_LOCAL_BRIDGE__).toBe(true);
    expect("__LODY_ELECTRON__" in globalThis.window).toBe(false);
    expect(typeof globalThis.window.ipc?.invoke).toBe("function");

    expect(handle.runtime.workspaceId).toBe(snapshot.workspace.workspaceId);
    // syncMode 'local' routes every machine to the local plane immediately, so
    // a missing cloud machine-meta list cannot strand the box (design risk 3).
    await expect(handle.runtime.resolveMachineTargetPlane(snapshot.machineId)).resolves.toBe("local");
    // The data plane is live, not merely constructed. Polled rather than read
    // once: `createWorkspaceRuntime` resolves as soon as it has ATTACHED the
    // transport, and the socket's own handshake finishes a moment later — the
    // meta room's first join legitimately reports `reconnecting` until it does.
    await until("the data plane socket to report connected", async () =>
      (await globalThis.window.ipc!.invoke("loro.isConnected")) === true ? true : undefined,
    );
  });

  it("refuses a channel it does not serve, loudly", async () => {
    await expect(globalThis.window.ipc!.invoke("updater.check")).rejects.toThrow(
      /lody_ipc_channel_unsupported/u,
    );
    expect(handle.bridge.unsupportedChannels()).toContain("updater.check");
  });

  it("seeds the two agent configs once, with their runtime overrides", async () => {
    const created = await bootstrapLodyAgentConfigs(store, snapshot.machineId);
    expect(created.sort()).toEqual(["blitz-claude", "blitz-codex"]);

    // Every builtin config MUST carry an override, or the daemon downloads its
    // own agent binary (plans/evidence/lody-phase1.md §A.d).
    for (const row of blitzAgentConfigRows(snapshot.machineId)) {
      const values = Object.values(row.runtimeOverrides).filter((value) => value !== undefined);
      expect(values.length, row.id).toBeGreaterThan(0);
    }
    // kimi/grok/deepseek are managed-runtime-only and must never be registered.
    expect(blitzAgentConfigRows(snapshot.machineId).map((row) => row.agentType)).toEqual([
      "claude",
      "codex",
    ]);

    const again = await bootstrapLodyAgentConfigs(store, snapshot.machineId);
    expect(again).toEqual([]);
  }, 60_000);

  it("creates a session whose user turn lands in the CRDT doc", async () => {
    const sessionId = randomUUID();
    const started = await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: "blitz-claude",
      agentType: "claude",
      prompt: LIVE_TURN_PROMPT,
      title: "phase 2 exit test",
    });
    expect(started.userTurnId).toMatch(/^[0-9a-f-]{36}$/u);

    const history = await until("the user turn to appear in the session doc", async () =>
      await handle.runtime.withSessionStore(sessionId, (sessionStore) => {
        // SAFETY: the session doc's shape is Lody's `SessionDocMeta`; only
        // `history` is read, and it is re-checked to be an array.
        const state = sessionStore.getState() as { history?: unknown };
        return Array.isArray(state.history) && state.history.length > 0 ? state.history : undefined;
      }),
    );
    // SAFETY: `history` is a non-empty array of Lody history entries; the two
    // fields read here are re-checked by the assertions themselves.
    const first = history[0] as { id?: unknown; role?: unknown; userId?: unknown };
    expect(first.id).toBe(started.userTurnId);
    expect(first.role).toBe("user");
    expect(first.userId).toBe(snapshot.userId);

    startedSession = started;
  }, 60_000);

  // A DISPATCH IS A PAID TURN. `session/dispatch-turn` launches the ACP adapter,
  // which runs the agent, so this cannot be part of an unattended `npm test`:
  // one run of the suite would spend one turn of somebody's subscription. It is
  // opt-in, and the opt-in is the phase-2 exit test itself:
  //
  //   BLITZ_LODY_LIVE_TURN=1 npx vitest run test/lody-session-roundtrip.test.ts
  //
  // Everything above it — the identity, the bridge, the runtime, the agent
  // configs, the CRDT write — is free and runs whenever a daemon is installed.
  it.skipIf(process.env.BLITZ_LODY_LIVE_TURN !== "1")(
    "dispatches that turn and streams the agent's reply back into the doc",
    async () => {
    const started = startedSession;
    if (started === null) throw new Error("the session test must run first");
    const sessionId = started.sessionId;

    // The dispatch pointer is recovery truth and must be durable before the RPC.
    const dispatch = await dispatchLodyTurn(
      handle.runtime,
      started,
      snapshot.machineId,
      snapshot.userId,
      { timeoutMs: LIVE_TURN_DEADLINE_MS },
    );
    // The facade answers `null` only when it could not reach a plane at all. A
    // real answer — accepted or refused — is what proves the RPC round trip.
    expect(dispatch).not.toBeNull();

    if (!claudeCredentialAvailable()) {
      // TODO(lody-phase3): with no usable agent credential this asserts only
      // that the daemon ACCEPTED the dispatch, not that an adapter launched and
      // streamed. Canary must prove the rest: one turn through
      // `/usr/local/bin/claude` with `blitz-cred-claude` minting the token,
      // asserting an assistant entry appears in the same session doc and the
      // daemon log shows the ACP spawn (plans/evidence/lody-phase1.md blocker 5).
      return;
    }

    // ONE paid turn, no retries. A reply that never arrives fails the test; it
    // is never re-sent.
    //
    // The wait is for CONTENT, not for the row. The daemon writes the assistant
    // entry as soon as the adapter accepts the turn — `items: []`, with only
    // `modelInfo` filled — and streams blocks into it afterwards. Waiting for
    // the row alone would pass on an agent that connected and then said nothing.
    const assistant = await until(
      "the agent's reply to stream into the session doc",
      async () =>
        await handle.runtime.withSessionStore(sessionId, (sessionStore) => {
          const state = sessionStore.getState() as { history?: unknown };
          if (!Array.isArray(state.history)) return undefined;
          const reply = state.history.find(
            (entry: unknown) =>
              typeof entry === "object" &&
              entry !== null &&
              (entry as { role?: unknown }).role === "assistant" &&
              Array.isArray((entry as { items?: unknown }).items) &&
              (entry as { items: unknown[] }).items.length > 0,
          );
          return reply ?? undefined;
        }),
      LIVE_TURN_DEADLINE_MS,
    ).catch((cause: unknown) => {
      throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-4000)}`);
    });
    // SAFETY: `until` only returns an entry whose `role` is `'assistant'` and
    // whose `items` is a non-empty array; the fields read here were the filter.
    const reply = assistant as { items: unknown[]; modelInfo?: { modelId?: unknown } };
    expect(reply.items.length, JSON.stringify(assistant).slice(0, 800)).toBeGreaterThan(0);
    // The adapter really launched: `modelInfo` is written by the ACP harness
    // from the model the agent reports, and nothing in this tree can invent it.
    expect(typeof reply.modelInfo?.modelId, JSON.stringify(assistant).slice(0, 800)).toBe("string");

    // Nothing was dropped on the way: the whole round trip parsed.
    const stats = handle.bridge.dataPlaneStats();
    expect(stats.unparseable).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.oversizedOutbound).toBe(0);
    },
    240_000,
  );
});
