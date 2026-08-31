/**
 * THE FIRST TURN AFTER AN AGENT SIGN-IN
 * (plans/LODY-RUNTIME-DESIGN.md §14.2, the third canary dogfood's report 4).
 *
 * The report, with a screenshot: on a fresh box the first prompt comes back
 * "Authentication required"; the member signs in through Lody's own panel; the
 * NEXT message shows "Resuming conversation from chat history" and then fails
 * with "The agent ended the turn without producing any output"; and the message
 * after THAT works.
 *
 * WHY IT NEEDS A REAL DAEMON AND A REAL CLI. Every hop in that story is the
 * daemon's: which ACP session it restores, whether it replays the chat history
 * into a fresh one, and what the claude adapter does with the prompt it is
 * handed. A stub of any of them would assert the stub.
 *
 * THE STAND-IN IS THE CREDENTIAL, NOT THE BINARY. `beforeAll` writes a shim
 * that execs the SAME `/opt/blitz/npm/bin/claude` the box runs; the only thing
 * it changes is which `HOME` that process sees, so the first turn runs against a
 * signed-out CLI exactly as a box with no Claude credential does, and
 * `markSignedIn()` is `claude auth login` in its only observable effect — the
 * credential is now in the HOME the agent's process reads.
 *
 * TWO GATES, the ones every daemon-backed suite here uses: the whole file skips
 * without a `lody` bundle (which is CI), and the turn that reaches a model is
 * skipped unless `BLITZ_LODY_LIVE_TURN=1`, because it spends a turn of
 * somebody's subscription:
 *
 *   BLITZ_LODY_LIVE_TURN=1 npx vitest run test/lody-post-signin-turn.test.ts
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "jotai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { isJsonArray, isJsonObject, isJsonString, type JsonValue } from "@blitzos/schema";
import { getMachineFlockDocId, getSessionRoomId, machineFlockKeys } from "@lody/shared";
import { BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs.js";
import { repairPhantomAcpSession } from "../src/lody/session-auth-recovery.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
  type LodyRuntimeHandle,
} from "../src/lody/runtime.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { continueLodySession, dispatchLodyTurn, startLodySession } from "../src/lody/session.js";
import {
  claudeCredentialAvailable,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";

/** The vendor CLI the box's own PATH shim execs. The stand-in below execs the
 * same one, so nothing about the agent is simulated. */
const CLAUDE_BINARY = "/opt/blitz/npm/bin/claude";
/** The cheapest prompt that still needs a model. One turn, never retried. */
const LIVE_TURN_PROMPT = "reply with the word ok";
const LIVE_TURN_DEADLINE_MS = 120_000;

async function until<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Every history entry of one session, oldest first. */
async function readHistory(handle: LodyRuntimeHandle, sessionId: string): Promise<JsonValue[]> {
  return await handle.runtime.withSessionStore(sessionId, (store) => {
    const history = store.getState().history;
    return history !== undefined && isJsonArray(history) ? [...history] : [];
  });
}

/** The `name`/`reason` of every system notice in a history slice, in order.
 * `chat_failed` carries its reason; every other notice is named alone. */
function systemNotices(history: readonly JsonValue[]): string[] {
  const found: string[] = [];
  for (const entry of history) {
    if (!isJsonObject(entry)) continue;
    const items = entry.items;
    if (items === undefined || !isJsonArray(items)) continue;
    for (const item of items) {
      if (!isJsonObject(item) || item.type !== "system_notice") continue;
      const rawName = item.name;
      const name = rawName !== undefined && isJsonString(rawName) ? rawName : "";
      const meta = item.meta;
      const rawReason = meta !== undefined && isJsonObject(meta) ? meta.reason : undefined;
      const reason = rawReason !== undefined && isJsonString(rawReason) ? rawReason : "";
      found.push(reason === "" ? name : `${name}:${reason}`);
    }
  }
  return found;
}

/** `true` once an assistant entry carries CONTENT. The daemon writes the row
 * with `items: []` as soon as the adapter accepts the turn, so waiting for the
 * row would pass on an agent that connected and then said nothing — which is
 * the exact failure under test. */
function assistantSpoke(history: readonly JsonValue[]): boolean {
  return history.some((entry) => {
    if (!isJsonObject(entry) || entry.role !== "assistant") return false;
    const items = entry.items;
    return items !== undefined && isJsonArray(items) && items.length > 0;
  });
}

describe.skipIf(!lodyDaemonAvailable())("the first turn after an agent sign-in", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let handle: LodyRuntimeHandle;
  const store = createStore();
  let scratch = "";
  /** Flipping this file is the whole of "the member signed in". */
  let signedInMarker = "";
  let sessionId = "";

  const markSignedIn = (): void => writeFileSync(signedInMarker, "1");

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "lody-signin-"));
    const signedOutHome = join(scratch, "signed-out-home");
    mkdirSync(signedOutHome, { recursive: true });
    signedInMarker = join(scratch, "signed-in");
    const standIn = join(scratch, "claude");
    // `exec`s the real CLI both times. Before the marker exists it runs with a
    // HOME that holds no credential, which is a box whose member has never
    // signed Claude in; afterwards it runs with the daemon's own HOME, which is
    // where `claude auth login --claudeai` puts the credential.
    writeFileSync(
      standIn,
      [
        "#!/bin/sh",
        `if [ ! -f "${signedInMarker}" ]; then`,
        `  HOME="${signedOutHome}"`,
        "  export HOME",
        "  unset CLAUDE_CODE_OAUTH_TOKEN",
        "  unset CLAUDE_CONFIG_DIR",
        "fi",
        `exec ${CLAUDE_BINARY} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(standIn, 0o755);

    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    handle = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        // See `lody-session-roundtrip.test.ts`: under jsdom the global
        // WebSocket is undici's and delivers no event to a listener.
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
    });
    mountLodyRuntimeAtoms(store, handle.runtime);

    // The product's own agent-config row, with the stand-in in place of the
    // box's PATH shim. Written and then PUSHED, in `bootstrapLodyAgentConfigs`'s
    // order: the daemon fails open on a row it cannot resolve (§12.2), which
    // would make every turn below fail for the wrong reason.
    const flockDocId: string = getMachineFlockDocId(handle.runtime.workspaceId, snapshot.machineId);
    const flock = await handle.runtime.repo.openFlockDoc(flockDocId);
    await flock.syncOnce();
    // SAFETY: `machineFlockKeys.agentConfig` is Lody's own key builder for this
    // row family; the vendor type seam erases its `readonly string[]` return.
    const key = machineFlockKeys.agentConfig(BLITZ_CLAUDE_CONFIG_ID) as readonly string[];
    await handle.runtime.writer.flockRowPutIfAbsent(flockDocId, key, {
      id: BLITZ_CLAUDE_CONFIG_ID,
      machineId: snapshot.machineId,
      name: "Claude Code",
      cliType: "builtin",
      agentType: "claude",
      env: {},
      runtimeOverrides: { claudeCodeExecutable: standIn },
    });
    await flock.syncOnce();
  }, 240_000);

  afterAll(async () => {
    unmountLodyRuntimeAtoms(store);
    await handle?.dispose();
    await harness?.stop();
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  it("refuses the first turn while the agent CLI is signed out", async () => {
    // FREE: the adapter reports ACP -32000 before any model is reached.
    sessionId = randomUUID();
    const started = await startLodySession(handle.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "hello",
      title: "post-sign-in turn",
    });
    await dispatchLodyTurn(handle.runtime, started, snapshot.machineId, snapshot.userId, {
      timeoutMs: LIVE_TURN_DEADLINE_MS,
    });
    const notices = await until(
      "the daemon to record the auth failure",
      async () => {
        const found = systemNotices(await readHistory(handle, sessionId));
        return found.some((notice) => notice.startsWith("chat_failed:")) ? found : undefined;
      },
      120_000,
    ).catch((cause: unknown) => {
      throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-4000)}`);
    });
    expect(notices).toContain("chat_failed:acp_auth_required");
  }, 180_000);

  it("leaves an ACP session id behind that names nothing", async () => {
    // FREE, and it is the whole root cause. The adapter answered `session/new`
    // while the CLI was signed out, so the daemon persisted an id BEFORE the
    // prompt it then refused. Measured against a real `lody@0.88.1`: without
    // this the next turn resumes it, `loadSession` answers "Resource not
    // found", and the fallback turn ends with no agent output.
    const roomId = getSessionRoomId(sessionId);
    const meta = await handle.runtime.repo.getDocMeta(roomId);
    const acpSessionId = meta?.meta.acpSessionId;
    expect(acpSessionId !== undefined && isJsonString(acpSessionId)).toBe(true);

    // The repair waits for the failed turn's status to settle, which is what
    // its third condition is for. The banner polls, so in the product this is
    // one more tick; here it is an explicit wait with the status in the
    // failure message.
    const dropped = await until(
      "the phantom id to be dropped",
      async () => (await repairPhantomAcpSession(handle.runtime, sessionId)) ?? undefined,
      60_000,
    ).catch(async (cause: unknown) => {
      const current = await handle.runtime.repo.getDocMeta(roomId);
      throw new Error(`${String(cause)}\nstatus: ${JSON.stringify(current?.meta.status)}`);
    });
    expect(dropped).toMatch(/^[0-9a-f-]{36}$/u);
    const repaired = await handle.runtime.repo.getDocMeta(roomId);
    expect(repaired?.meta.acpSessionId).toBeUndefined();
    // Idempotent: a poll that runs again has nothing left to drop.
    expect(await repairPhantomAcpSession(handle.runtime, sessionId)).toBeNull();
  }, 60_000);

  // A DISPATCH IS A PAID TURN, and this is the whole budget of this file. It
  // runs after the repair above, which is the point: measured against a real
  // `lody@0.88.1` with the phantom id left in place, this same turn came back
  // `agent_no_output` — the member's report, reproduced.
  it.skipIf(process.env.BLITZ_LODY_LIVE_TURN !== "1" || !claudeCredentialAvailable())(
    "answers the next message once the member has signed in",
    async () => {
      markSignedIn();
      const second = await continueLodySession(handle.runtime, {
        sessionId,
        userId: snapshot.userId,
        agentType: "claude",
        prompt: LIVE_TURN_PROMPT,
      });
      await dispatchLodyTurn(handle.runtime, second, snapshot.machineId, snapshot.userId, {
        timeoutMs: LIVE_TURN_DEADLINE_MS,
      });

      await until(
        "the agent's reply to stream into the session doc",
        async () => {
          const history = await readHistory(handle, sessionId);
          if (assistantSpoke(history)) return true;
          const notices = systemNotices(history);
          // Fail on the reported symptom rather than on a timeout: the whole
          // point of this case is that this notice must not appear.
          if (notices.includes("chat_failed:agent_no_output")) {
            throw new Error(
              `the post-sign-in turn produced no output: ${notices.join(", ")}\n` +
                `--- daemon log ---\n${harness.daemonLog().slice(-8000)}`,
            );
          }
          return undefined;
        },
        LIVE_TURN_DEADLINE_MS,
      ).catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-8000)}`);
      });
    },
    300_000,
  );
});
