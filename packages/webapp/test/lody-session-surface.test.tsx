/**
 * PHASE 3 EXIT TEST (plans/LODY-SESSIONS.md §10).
 *
 * "`SessionSurface` mounted; the full chat loop — send, cancel, permission
 * prompts, diffs, queue — in the real webapp UI against the local daemon."
 *
 * Everything under test is real: a patched `lody@0.88.1` daemon, the box's own
 * `blitz-lody-bridge`, our `window.ipc`, our WebSocket data plane, our three
 * HTTP planes, the vendored `RuntimeProvider`, and their `ChatLanding` and
 * `SessionDetail` pages driven through the DOM. The only stand-ins are the Go
 * gateway (no toolchain here; `gateway/main_test.go` covers it) and jsdom's
 * missing measurement APIs (`lody-dom-stubs.ts`).
 *
 * TWO GATES, THE SAME TWO PHASE 2 CHOSE:
 *
 * - The suite SKIPS with no `lody` bundle installed, which is CI. A test that
 *   needs a 21 MB npm artifact cannot gate a merge, and faking it would test
 *   the fake.
 * - Anything that DISPATCHES is skipped unless `BLITZ_LODY_LIVE_TURN=1`,
 *   because a dispatch launches the ACP adapter and spends a turn of somebody's
 *   subscription.
 *
 *     BLITZ_LODY_LIVE_TURN=1 npx vitest run test/lody-session-surface.test.tsx
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { act, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { LodySessionSurfaceApi, LodySessionSurfaceProps } from "../src/lody/SessionSurface";
import { fetchLodyPlatformSnapshot } from "../src/lody/platform-snapshot";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";
import {
  claudeCredentialAvailable,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness";

/**
 * One prompt, one turn, and it has to earn three things: a permission request,
 * a window in which the queue and the Stop button exist, and no side effect.
 *
 * `rm -f` on a path that does not exist is the cheapest thing a permission
 * classifier reliably escalates — `BUILTIN_DEFAULT_MODE_IDS.claude` is `auto`
 * (`vendor/lody/packages/shared/src/ai.ts:402`), so a benign `echo` would be
 * approved by the classifier and the card would never render. The `sleep`
 * afterwards keeps the turn running long enough to cancel it.
 */
const LIVE_TURN_PROMPT =
  "Use the Bash tool to run exactly `rm -f /tmp/blitz-phase3-scratch`, then run `sleep 90`. Do not ask me anything else.";
const LIVE_TURN_DEADLINE_MS = 120_000;

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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
  }
}

describe.skipIf(!lodyDaemonAvailable())("phase 3: the mounted Lody session surface", () => {
  let harness: LodyHarness;
  let mounted: Awaited<ReturnType<typeof render>>;
  let api: LodySessionSurfaceApi | null = null;
  /** The session the surface currently shows, mirrored out of the memory router
   * exactly as `CloudApp` will mirror it into the rail in phase 4. */
  let activeSessionId: string | null = null;
  const text = (): string => mounted.container.textContent ?? "";
  /** Every message React or the vendored renderer logged at error level while
   * the surface was up. Risk 2 in the design doc is "what else does the session
   * page demand"; a missing provider announces itself here. */
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    // The stubs go in BEFORE the module graph loads, not merely before the
    // render: `session-monaco-text-viewer.tsx` pulls Monaco in, and Monaco
    // decides at module load whether it can register its clipboard commands.
    // A static `import` at the top of this file would be hoisted above this.
    installLodyDomStubs();
    const module: { SessionSurface: (props: LodySessionSurfaceProps) => ReactNode } =
      await import("../src/lody/SessionSurface");
    const SessionSurface = module.SessionSurface;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((value) => String(value)).join(" "));
      originalError(...args);
    };
    harness = await startLodyHarness();
    mounted = await render(
      <SessionSurface
        endpoints={{
          ...harness.endpoints,
          // Under Vitest's jsdom environment `globalThis.WebSocket` is undici's,
          // whose `dispatchEvent` rejects jsdom's `Event` class outright, so no
          // `open` or `message` ever reaches a listener and the data plane looks
          // silently dead. `ws` implements the four handler properties,
          // `readyState`, `send` and `close` the connection uses.
          webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
        }}
        viewer={{ name: "Phase 3", avatarUrl: null }}
        workspaceTitle="Phase 3 workspace"
        onApiReady={(next) => {
          api = next;
        }}
        onActiveSessionChange={(next) => {
          activeSessionId = next;
        }}
      />,
    );
    await settle();
  }, 240_000);

  afterAll(async () => {
    await mounted?.unmount();
    await harness?.stop();
  }, 60_000);

  it("mounts the chat landing against the real daemon", async () => {
    let connected = false;
    void globalThis.window.ipc?.invoke("loro.isConnected").then((value) => {
      connected = value === true;
    });
    await until(
      "the data plane to report connected",
      () => {
        void globalThis.window.ipc?.invoke("loro.isConnected").then((value) => {
          connected = value === true;
        });
        return connected ? true : undefined;
      },
      60_000,
    );
    const text = mounted.container.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(mounted.container.querySelector("textarea")).not.toBeNull();
    expect(api).not.toBeNull();
    // The box machine is offered by name. That is design-doc risk 3 answered
    // from the UI end: `buildVisibleMachineIndex`'s owner fallback only reaches
    // it because `userAtom` carries the daemon's own `local:<uuid>`.
    const machineChip = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Machine",
    );
    expect(machineChip?.textContent ?? "").not.toBe("");
    // No provider is missing and no IPC channel was refused.
    expect(consoleErrors.filter((line) => /must be used within|is not available/u.test(line))).toEqual([]);
    expect(api?.unsupportedIpcChannels()).toEqual([]);
  }, 90_000);

  it("arms the composer once a prompt is typed", async () => {
    const composer = mounted.container.querySelector("textarea");
    expect(composer).not.toBeNull();
    await act(async () => {
      typeInto(composer as HTMLTextAreaElement, LIVE_TURN_PROMPT);
    });
    await settle();
    const send = await until(
      "the send button to arm",
      () => {
        const button = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
        return button !== null && !button.disabled ? button : undefined;
      },
      15_000,
    );
    expect(send.disabled).toBe(false);
  }, 30_000);

  it("offers the seeded agent config in the run-configuration menu", async () => {
    const trigger = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Run configuration",
    );
    expect(trigger).toBeDefined();
    await act(async () => {
      openMenu(trigger as HTMLButtonElement);
    });
    await settle();
    // The menu is a Radix body portal, so this also proves the agent-config
    // bootstrap reached the machine Flock room and came back through the UI —
    // "Claude Code" is the name `blitzAgentConfigRows` writes.
    expect(menuLabels().join(" ")).toContain("Claude Code");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
  }, 30_000);

  /**
   * Design-doc risk 6: `/session-control` answers its whole batch at the end,
   * so a slow `machine/acp-capabilities-refresh` would leave the composer's
   * model and effort selectors empty with no sign of progress. This times it
   * against a daemon that has never launched this adapter.
   *
   * It costs nothing: the refresh starts the ACP adapter and asks it for its
   * models and modes. No prompt is sent, so no turn is spent.
   */
  it("refreshes ACP capabilities inside the streaming-bridge budget", async () => {
    const snapshot = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (snapshot === null) throw new Error("the daemon served no catalog");
    const started = Date.now();
    const answer = await globalThis.window.ipc?.invoke("sessionControl.send", {
      requestId: randomUUID(),
      message: {
        type: "machine/acp-capabilities-refresh",
        machineId: snapshot.machineId,
        workspaceId: snapshot.workspace.workspaceId,
        configId: "blitz-claude",
        cliType: "builtin",
        agentType: "claude",
        runtimeOverrides: { claudeCodeExecutable: "/usr/local/bin/claude" },
        env: {},
      },
    });
    const elapsedMs = Date.now() - started;
    // The adapter really launched and really answered, which is also the
    // narrowest proof that `/usr/local/bin/claude` runs under the daemon.
    expect(JSON.stringify(answer)).toContain("acp-capabilities-refresh_response");
    // Measured 2.0-3.0 s on a cold daemon and recorded in
    // plans/LODY-RUNTIME-DESIGN.md §7. The bound is the design doc's
    // streaming-bridge trigger, not a performance target: over it, the bridge
    // has to answer `/session-control` as newline-delimited JSON instead of one
    // body, or the composer's selectors look hung while it runs.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 60_000);

  /**
   * Risk 2 in the design doc: "`ConvexProvider` is not the only cloud provider
   * the session page needs". It is not — `SessionDetail` reaches
   * `useWorkspaceMembers`, which calls `useAuthClient()` with no local-platform
   * branch, and the chat landing never does. This mounts the session page for a
   * session that does not exist yet, which is the cheapest way to run every
   * provider demand it has without spending a turn.
   */
  it("mounts the session detail page without demanding a cloud provider", async () => {
    expect(api).not.toBeNull();
    await act(async () => {
      api?.openSession(randomUUID());
    });
    await settle();
    expect(activeSessionId).not.toBeNull();
    const missingProviders = consoleErrors.filter((line) =>
      /must be used within|is not available|Wrap the app/u.test(line),
    );
    expect(missingProviders).toEqual([]);
    await act(async () => {
      api?.openLanding();
    });
    await settle();
    expect(activeSessionId).toBeNull();
  }, 60_000);

  /**
   * The two machine-RPC methods phase 3 owes an answer on, driven over the same
   * `/lody/rpc` door the Stop button and the conversation diff panel use.
   *
   * Both are FREE: `session/cancel` on an idle session and `code-collab/open-turn-diff`
   * on a turn that produced no diff are refusals, and a refusal that comes back
   * as a STRUCTURED response is the proof the plane carries the method at all.
   * A method the daemon did not route answers `unsupported`/`invalid_request`
   * instead, which is the failure this pins.
   *
   * Diff evidence needs NO new bridge door: `code-collab/*` is a machine-RPC
   * method (`shared/src/local-machine-rpc.ts:54`), and `/lody/rpc` already
   * carries that whole union.
   */
  it("carries session/cancel and the turn-diff request over the existing RPC door", async () => {
    const snapshot = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (snapshot === null) throw new Error("the daemon served no catalog");
    const base = {
      machineId: snapshot.machineId,
      workspaceId: snapshot.workspace.workspaceId,
    };
    const cancel = await globalThis.window.ipc?.invoke("machineRpc.send", {
      ...base,
      method: "session/cancel",
      params: { sessionId: randomUUID(), turnId: randomUUID() },
    });
    // `SendLocalMachineRpcResult` is `{ ok: true, result }` | `{ ok: false, error }`.
    // Either shape is an ANSWER; what would fail here is our own request being
    // rejected before it left the browser.
    expect(JSON.stringify(cancel)).not.toContain("lody_machine_rpc_invalid_request");
    expect(cancel).not.toBeNull();

    const turnDiff = await globalThis.window.ipc?.invoke("machineRpc.send", {
      ...base,
      method: "code-collab/open-turn-diff",
      params: { sessionId: randomUUID(), turnId: randomUUID(), path: "README.md" },
    });
    expect(JSON.stringify(turnDiff)).not.toContain("lody_machine_rpc_invalid_request");
    expect(turnDiff).not.toBeNull();
  }, 60_000);

  // A DISPATCH IS A PAID TURN. Everything above is free and runs whenever a
  // daemon is installed; this one turn carries the whole rest of the exit test,
  // which is why it does permission, queue and cancel in a single agent run
  // rather than three.
  it.skipIf(process.env.BLITZ_LODY_LIVE_TURN !== "1" || !claudeCredentialAvailable())(
    "sends from the landing, queues, answers a permission request, and cancels",
    async () => {
      const composer = mounted.container.querySelector<HTMLTextAreaElement>("textarea");
      expect(composer).not.toBeNull();
      await act(async () => {
        typeInto(composer as HTMLTextAreaElement, LIVE_TURN_PROMPT);
      });
      await settle();
      const send = await until("the send button to arm", () => {
        const button = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
        return button !== null && !button.disabled ? button : undefined;
      });
      await act(async () => {
        send.click();
      });

      // 1. The landing created the session and the surface navigated to it.
      const sessionId = await until(
        "the surface to open the new session",
        () => activeSessionId ?? undefined,
        60_000,
      );
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
      await until("the prompt to appear in the transcript", () =>
        text().includes("blitz-phase3-scratch") ? true : undefined,
      );

      // 2. The message queue. A second message sent while the turn runs is
      //    QUEUED, not dispatched, so this costs nothing — and it is removed
      //    again before the queue can drain into a second paid turn.
      const running = mounted.container.querySelector<HTMLTextAreaElement>("textarea");
      await act(async () => {
        typeInto(running as HTMLTextAreaElement, "queued while the turn runs");
      });
      await settle();
      // Enter, not the Send button: while a turn runs the composer's primary
      // action becomes Stop, and Enter is the gesture that reaches the queue in
      // both states.
      await act(async () => {
        (running as HTMLTextAreaElement).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      const remove = await until("the queued message row", () => {
        const button = mounted.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Remove from queue"]',
        );
        return button ?? undefined;
      }, 30_000);
      expect(text()).toContain("queued while the turn runs");
      await act(async () => {
        remove.click();
      });
      await until("the queued message to be removed", () =>
        mounted.container.querySelector('button[aria-label="Remove from queue"]') === null
          ? true
          : undefined,
      );

      // 3. The permission request card, and answering it through the CRDT
      //    route (`usePermissionResponse` -> `writer.respondSessionPermission`).
      await until(
        "the agent to ask for permission",
        () => (text().includes("Permission Required") ? true : undefined),
        LIVE_TURN_DEADLINE_MS,
      ).catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-4000)}`);
      });
      const options = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => /allow|yes|approve/iu.test(button.textContent ?? ""),
      );
      expect(options.length, `permission card offered: ${text().slice(-600)}`).toBeGreaterThan(0);
      await act(async () => {
        options[0]?.click();
      });
      await until(
        "the permission card to resolve",
        () => (text().includes("Permission Required") ? undefined : true),
        30_000,
      );

      // 4. Cancel. `session/cancel` through the machine RPC plane, driven by
      //    their own Stop button.
      const stop = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
      if (stop !== null) {
        await act(async () => {
          stop.click();
        });
        await until(
          "the turn to stop",
          () =>
            mounted.container.querySelector('button[aria-label="Stop"]') === null ? true : undefined,
          60_000,
        );
      }

      // Nothing was dropped and no channel was refused across the whole loop.
      expect(api?.unsupportedIpcChannels()).toEqual([]);
      expect(consoleErrors.filter((line) => line.includes("must be used within"))).toEqual([]);
    },
    600_000,
  );
});

/** Opens a Radix menu the way a pointer does. Radix's triggers act on
 * `pointerdown`, which jsdom does not synthesize from `click()`. */
function openMenu(trigger: HTMLElement): void {
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  trigger.click();
}

/** Writes into a React-controlled textarea the way a keystroke does: through the
 * native value setter, then an `input` event React's synthetic system sees. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The labels an open menu offers. Radix renders it into a body
 * portal, so it is read off the document rather than the container. */
function menuLabels(): string[] {
  return [...document.body.querySelectorAll("[role='menuitem'], [role='option']")].map(
    (node) => node.textContent ?? "",
  );
}
