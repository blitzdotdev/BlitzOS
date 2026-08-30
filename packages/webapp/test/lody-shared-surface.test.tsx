/**
 * PHASE 7 EXIT TEST (plans/LODY-SHARING.md §8 step 5, §10.5) — the grantee's
 * MOUNTED surface, which is the one thing phase 6 could not prove.
 *
 * Phase 6 proved the relay with a protocol-v7 peer: the right frames crossed and
 * the wrong ones did not. What a protocol peer cannot prove is a rendered
 * transcript in somebody else's browser, because that needs the session's
 * METADATA — and metadata was exactly what the phase-6 ACL withheld
 * (`plans/LODY-SHARING.md` §10.1). So this file mounts the real vendored session
 * page against another member's box, over the shared prefix, with a real claim
 * on the header the real gateway would have set.
 *
 * THE OWNER'S HALF IS HEADLESS. One vendored renderer per jsdom worker is
 * already several hundred megabytes (`LODY-RUNTIME-DESIGN.md` §9.3); two would
 * be a memory experiment rather than a test. The owner is `createLodyRuntime` —
 * the same headless runtime phase 2's exit test drives — and the grantee is the
 * mount, because the grantee is what is being proven.
 *
 * THE SEEDED TURN RUNS UNDER `default`, their "Manual" mode. Under `auto` the
 * classifier answers permission prompts on the member's behalf and no card ever
 * renders (§8.6). The owner picks the mode in the product; here the owner is a
 * function call, so it says so.
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "jotai";
import { act, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { bootstrapLodyAgentConfigs, refreshLodyAcpCapabilities } from "../src/lody/agent-configs.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
  type LodyRuntimeHandle,
} from "../src/lody/runtime.js";
import type { LodySessionSurfaceProps } from "../src/lody/SessionSurface";
import { sendMachineRpc } from "../src/lody/rpc-client.js";
import { startLodySession, type StartedLodySession } from "../src/lody/session.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";
import {
  HARNESS_BOOT_TIMEOUT_MS,
  claudeCredentialAvailable,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
  type LodyShareClaim,
} from "./lody-daemon-harness.js";

/** The owner's prompt. It is the transcript a grantee must be able to follow,
 * and — when a turn is paid for — the task whose permission they answer. */
const SEEDED_PROMPT =
  "Create a file named GRANTEE_ANSWERED.md whose only content is the word ok. Then stop.";

/** Whether this run may spend a turn. */
const LIVE = process.env.BLITZ_LODY_LIVE_TURN === "1" && claudeCredentialAvailable();

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  }
}

describe.skipIf(!lodyDaemonAvailable())("phase 7: a grantee's mounted surface", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let owner: LodyRuntimeHandle | null = null;
  let sessionId = "";
  let started: StartedLodySession | null = null;
  let workspaceRoot = "";
  const store = createStore();
  const mounts: Awaited<ReturnType<typeof render>>[] = [];
  /** Everything the surface said went wrong. A write refused by the relay
   * surfaces here and nowhere else: `handleSelect` catches its own failure
   * (`floating-permission-request.tsx:317`) and leaves the card looking idle. */
  const logs: string[] = [];

  /** One shared surface, at one level, on the owner's box. */
  async function mountShared(level: "ro" | "rw"): Promise<HTMLElement> {
    const claim: LodyShareClaim = {
      target: "membership-owner",
      scope: "sessions",
      read: level === "ro" ? [sessionId] : [],
      write: level === "rw" ? [sessionId] : [],
    };
    const endpoints = harness.sharedEndpoints(claim);
    const module: { SessionSurface: (props: LodySessionSurfaceProps) => ReactNode } =
      await import("../src/lody/SessionSurface");
    const SessionSurface = module.SessionSurface;
    const mounted = await render(
      <SessionSurface
        endpoints={{
          ...endpoints,
          // Under jsdom the global WebSocket is undici's, whose `dispatchEvent`
          // rejects jsdom's `Event`, so no message ever reaches a listener.
          webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
        }}
        viewer={{ name: "Grantee", avatarUrl: null }}
        workspaceTitle="Ada's workspace"
        shared={{ sessionId }}
        readOnly={level === "ro"}
      />,
    );
    mounts.push(mounted);
    await settle();
    return mounted.container;
  }

  beforeAll(async () => {
    for (const level of ["warn", "error"] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        logs.push(`[${level}] ` + args.map((v) => (v instanceof Error ? v.message : String(v))).join(" "));
        original(...args);
      };
    }
    installLodyDomStubs();
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;
    owner = await createLodyRuntime({
      endpoints: {
        ...harness.endpoints,
        webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
      },
      snapshot,
    });
    mountLodyRuntimeAtoms(store, owner.runtime);
    // The agent configs and their capabilities are the OWNER's, written to the
    // owner's machine Flock. A grantee cannot write them and does not read them
    // — `flock-doc` stays admin-only (§10.3) — so they are seeded here, once,
    // exactly as the owner's own surface would have.
    await bootstrapLodyAgentConfigs(store, owner.runtime, snapshot.machineId);
    await refreshLodyAcpCapabilities(owner.runtime, snapshot.machineId, {});

    workspaceRoot = mkdtempSync(join(tmpdir(), "lg-"));
    sessionId = randomUUID();
    started = await startLodySession(owner.runtime, {
      sessionId,
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: "blitz-claude",
      agentType: "claude",
      prompt: SEEDED_PROMPT,
      title: "the session Ada shared",
      // Manual. See the file comment: `auto` answers for the member and the
      // card never appears.
      modeId: "default",
    });
    // THE OWNER'S RUNTIME GOES BEFORE ANY SURFACE MOUNTS, and that is the
    // singleton in §6.1 taken seriously: `sendIpc` re-reads `window.ipc` on
    // every call, so two live runtimes in one document are one runtime with two
    // sets of URLs. Measured while writing this file — with both alive, the
    // owner's own `session/dispatch-turn` came back `share_forbidden`, having
    // been routed to the grantee's endpoints. The turn below is therefore
    // dispatched over plain HTTP to the owner's own `/rpc`, which is what the
    // facade's fast path does anyway and what needs no `window.ipc` at all.
    await owner.dispose();
    owner = null;
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    for (const mounted of mounts) await mounted.unmount();
    unmountLodyRuntimeAtoms(store);
    await owner?.dispose();
    owner = null;
    if (workspaceRoot !== "") rmSync(workspaceRoot, { recursive: true, force: true });
    await harness?.stop();
  }, 60_000);

  it("renders another member's session, title and transcript, from their box", async () => {
    const container = await mountShared("rw");
    // The TITLE is the proof the `meta` projection reached the renderer: it is
    // document metadata, and a phase-6 grantee could not have seen it at all.
    await until(
      "the shared session's title",
      () => (container.textContent?.includes("the session Ada shared") === true ? true : undefined),
    );
    // And the transcript is the proof the document ROOM reached it: the title
    // is metadata and the prompt is document body, and the two arrive on
    // different rooms.
    await until(
      "the owner's prompt in the transcript",
      () => (container.textContent?.includes(SEEDED_PROMPT) === true ? true : undefined),
    );
  }, 180_000);

  it("gives a read-write grantee the composer and a read-only grantee none", async () => {
    const readWrite = mounts[0]?.container;
    if (readWrite === undefined) throw new Error("the read-write surface is not mounted");
    await until("the co-driver's composer", () => readWrite.querySelector("textarea") ?? undefined);

    const readOnly = await mountShared("ro");
    await until(
      "the read-only surface to render the session",
      () => (readOnly.textContent?.includes("the session Ada shared") === true ? true : undefined),
    );
    // Seam patch 4. The transcript is there and the composer is not: a control
    // whose result the relay would discard is not offered.
    expect(readOnly.querySelector("textarea")).toBe(null);
    await until(
      "the read-only transcript",
      () => (readOnly.textContent?.includes(SEEDED_PROMPT) === true ? true : undefined),
    );
  }, 240_000);

  /**
   * THE OWED LIVE TURN (`plans/LODY-SHARING.md` §9.1, "the permission answer,
   * live"), and it closes phase 6's one paper claim.
   *
   * Phase 6 proved that an RW grantee's CRDT write reaches the owner's replica
   * and an RO grantee's does not. What it could not prove is that the DAEMON
   * accepts a permission outcome authored by a non-owner peer, and that the card
   * a human clicks is a real rendered card rather than a frame in a test. Both
   * need an agent that actually asks, which is a paid turn.
   *
   * THE OWNER DISPATCHES AND THE GRANTEE ANSWERS. That is the product flow
   * §0.1 describes — one member driving, another co-driving.
   *
   * THE ORDER IS NOT INCIDENTAL, and it cost a turn to learn: the grantee's
   * surface must be ATTACHED TO THE ROOM BEFORE THE TURN IS DISPATCHED. With no
   * peer on the room the daemon holds its turn history writes waiting for the
   * user turn to sync, gives up after 20 s, and then cancels the permission
   * request itself — "could not be attached to an active assistant entry;
   * cancelling to avoid waiting for an unobservable permission outcome". The
   * agent asks, and nobody can answer.
   */
  it.skipIf(!LIVE)(
    "lets a read-write grantee answer a permission request the agent then acts on",
    async () => {
      const container = mounts[0]?.container;
      if (container === undefined) throw new Error("the read-write surface is not mounted");
      if (started === null) throw new Error("no seeded session");

      const explain = (cause: unknown): never => {
        throw new Error(
          `${String(cause)}\n--- surface ---\n${(container.textContent ?? "").slice(-1500)}` +
            `\n--- console ---\n${logs.slice(-25).join("\n")}` +
            `\n--- daemon log ---\n${harness.daemonLog().slice(-6000)}`,
        );
      };

      // The dispatch, over the OWNER's own door. `session/dispatch-turn` is the
      // fast path the facade takes when it can; the durable pointer beside it
      // is recovery truth and this turn is not recovering from anything.
      const dispatched = await sendMachineRpc(
        {
          rpcUrl: harness.endpoints.rpcUrl,
          controlUrl: harness.endpoints.controlUrl,
          projectUrl: harness.endpoints.projectUrl,
          platformUrl: harness.endpoints.platformUrl,
        },
        {
          machineId: snapshot.machineId,
          workspaceId: snapshot.workspace.workspaceId,
          method: "session/dispatch-turn",
          params: {
            sessionId,
            userTurnId: started.userTurnId,
            userId: snapshot.userId,
            timestamp: started.timestamp,
            inputConfig: started.inputConfig,
          },
        },
      );
      // A refused dispatch looks exactly like a slow agent, for four minutes.
      expect(JSON.stringify(dispatched)).not.toMatch(/share_forbidden|"accepted":false/u);

      await until(
        "the agent to ask the grantee for permission",
        () => (container.textContent?.includes("Permission Required") === true ? true : undefined),
        240_000,
      ).catch(explain);

      // The card is the SMALLEST element that holds both the header and an
      // enabled option button. Its header and its body are separate children,
      // so "the last div containing the header text" is the header itself and
      // has no buttons in it — measured, and it cost a turn.
      //
      // Matching option text across the whole surface is worse still: the
      // composer's permission-MODE control is a button whose label is a mode,
      // and "Always Allow" is one of them.
      const options = await until(
        "the permission card's options",
        () => {
          const cards = [...container.querySelectorAll<HTMLElement>("div")].filter((node) =>
            (node.textContent ?? "").includes("Permission Required"),
          );
          for (const card of cards.reverse()) {
            const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")].filter(
              (button) => !button.disabled && (button.textContent ?? "").trim() !== "",
            );
            if (buttons.length > 0) return buttons;
          }
          return undefined;
        },
        30_000,
      ).catch(explain);
      // Their own order: Deny, Allow Once, Always Allow. The answer this test
      // wants is the narrowest approval.
      const allowOnce =
        options.find((button) => /allow once/iu.test(button.textContent ?? "")) ?? options[1];
      if (allowOnce === undefined) {
        explain(new Error(`no approval among ${options.map((b) => b.textContent).join(" | ")}`));
        throw new Error("unreachable");
      }
      await act(async () => {
        allowOnce.click();
      });
      await settle();

      // The agent acted on an answer authored by somebody who does not own the
      // box. A session with no project runs in the daemon's own session
      // directory, so the file is looked for under the data dir.
      await until(
        "the agent's file, written after the grantee's answer",
        () => {
          const found = walkFor(harness.dataDir, "GRANTEE_ANSWERED.md", 6);
          return found ? true : undefined;
        },
        300_000,
      ).catch(explain);
    },
    900_000,
  );
});

/** Whether `name` exists anywhere under `root`, to `depth` levels. The daemon
 * chooses a session's working directory and the test does not need to predict
 * it — only to see that the write happened on the owner's box. */
function walkFor(root: string, name: string, depth: number): boolean {
  if (depth < 0 || !existsSync(root)) return false;
  let children: string[];
  try {
    children = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === name) return ["__found__"];
      return entry.isDirectory() ? [entry.name] : [];
    });
  } catch {
    return false;
  }
  if (children.includes("__found__")) return true;
  return children.some((child) => walkFor(join(root, child), name, depth - 1));
}
