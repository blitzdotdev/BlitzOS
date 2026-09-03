/**
 * PHASE 4 EXIT TEST (plans/LODY-SESSIONS.md §10).
 *
 * "`SessionRail` with Chats / GitHub Worktrees / Terminals; + New session. New
 * chat from the rail; terminal tabs unchanged; mobile drawer works."
 *
 * The mobile drawer is `shell-mobile-drawer.test.tsx` and the rail's own two
 * shapes are `session-rail.test.tsx`; both are free and gate every merge. THIS
 * file is the part that needs a daemon: Lody's own sidebar body, mounted into
 * the rail's portal host, reading the real session mirror.
 *
 * THE SAME TWO GATES PHASES 2 AND 3 CHOSE. The suite skips with no `lody`
 * bundle installed, which is CI. The one case that DISPATCHES is skipped unless
 * `BLITZ_LODY_LIVE_TURN=1`, because a dispatch spends a turn of somebody's
 * subscription:
 *
 *     BLITZ_LODY_LIVE_TURN=1 npx vitest run test/lody-session-rail.test.tsx
 *
 * Everything else here is free, and deliberately so: the three sections, the
 * terminal rows, the New session affordance and the suppressed header and
 * footer are all structure, and structure is what phase 4 changed.
 */
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { createStore } from "jotai";
import { act, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { LodySessionSurfaceApi, LodySessionSurfaceProps } from "../src/lody/SessionSurface";
import { bootstrapLodyAgentConfigs, BLITZ_CLAUDE_CONFIG_ID } from "../src/lody/agent-configs";
import { fetchLodyPlatformSnapshot } from "../src/lody/platform-snapshot";
import {
  createLodyRuntime,
  mountLodyRuntimeAtoms,
  unmountLodyRuntimeAtoms,
} from "../src/lody/runtime";
import { startLodySession } from "../src/lody/session";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";
import {
  claudeCredentialAvailable,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness";

/** The cheapest prompt that still creates a session and answers once. The rail
 * is what is under test, not the answer, so nothing here waits for content. */
const LIVE_TURN_PROMPT = "reply with the word ok";

/**
 * A session written the way the landing writes one, MINUS the dispatch.
 *
 * `startLodySession` is the accept unit — session meta plus the first user turn
 * in one write — and `dispatchLodyTurn` is the separate, PAID half. So a
 * session can be made to exist for free, and the rail listing it is then an
 * ordinary free assertion instead of a hostage to a live turn.
 *
 * It runs on its own headless runtime, BEFORE the surface mounts and disposed
 * before it does, so there is never a second `window.ipc` or a second data
 * plane in flight. The daemon keeps the session in its own store, which is what
 * makes it visible to the surface's mirror afterwards — the same path a session
 * created on another device takes.
 */
const SEEDED_TITLE = "seeded from the rail test";

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
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

describe.skipIf(!lodyDaemonAvailable())("phase 4: the vendored rail", () => {
  let harness: LodyHarness;
  let mounted: Awaited<ReturnType<typeof render>>;
  let api: LodySessionSurfaceApi | null = null;
  let activeSessionId: string | null = null;
  const selectedTerminals: string[] = [];
  const consoleErrors: string[] = [];
  /** The rail's list region, stood up exactly as `SessionRail` renders it. */
  const railHost = document.createElement("div");
  railHost.className = "session-list session-list--vendor";

  const railText = (): string => railHost.textContent ?? "";
  const railButtons = (): HTMLButtonElement[] => [
    ...railHost.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const railButton = (match: RegExp): HTMLButtonElement | undefined =>
    railButtons().find((button) => match.test(button.textContent ?? ""));
  /** A session row. `SessionList` renders it as a `div[role=button]` carrying
   * `data-sidebar-session-id` — an anchor only when a `getSessionHref` is
   * supplied, and this rail supplies none because there is no browser address
   * for a session inside the surface's memory router. */
  const railSessionRow = (match: RegExp): HTMLElement | undefined =>
    [...railHost.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")].find((row) =>
      match.test(row.textContent ?? ""),
    );

  /**
   * The surface, with two things a case may vary: whether it is hidden, and
   * which terminal the SHELL says the member is looking at. Every other prop is
   * identical across renders so the runtime is never rebuilt.
   *
   * The two travel together because that is the shell's own rule (wave 3,
   * ADJ1): while the surface is up a terminal is a TAB of it, so
   * `activeTerminalId` is the one the ADDRESS names and `''` means a
   * conversation owns the pane; while the panes are up it is the pane's own
   * focused tab. The default below is a chat address in both positions.
   */
  let surface: (hidden: boolean, activeTerminalId?: string) => ReactNode = () => null;
  /** Every session id the row's Share entry reported (phase 6). */
  const sharedSessions: string[] = [];
  /**
   * What the rail asked the SHELL to open, newest last
   * (plans/LODY-RUNTIME-DESIGN.md §15).
   *
   * A rail click is an address change, not a surface navigation, so the binding
   * carries `CloudApp`'s own navigators and this list is what a vendored row
   * reaches. The shell then drives the surface back through the imperative API,
   * which is what each case does by hand below.
   */
  const railNavigations: (string | null)[] = [];

  beforeAll(async () => {
    installLodyDomStubs();
    document.body.append(railHost);
    const module: { SessionSurface: (props: LodySessionSurfaceProps) => ReactNode } =
      await import("../src/lody/SessionSurface");
    const SessionSurface = module.SessionSurface;
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map((value) => String(value)).join(" "));
      originalError(...args);
    };
    harness = await startLodyHarness();
    await seedSession(harness);
    surface = (hidden: boolean, activeTerminalId = hidden ? "12" : "") => (
      <SessionSurface
        endpoints={{
          ...harness.endpoints,
          // See `lody-session-surface.test.tsx`: under jsdom the global
          // WebSocket is undici's and never delivers an event to a listener.
          webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
        }}
        viewer={{ name: "Phase 4", avatarUrl: null }}
        workspaceTitle="Phase 4 workspace"
        hidden={hidden}
        railHost={railHost}
        rail={{
          terminals: [
            { id: "11", label: "claude · tab 1", agent: "claude" },
            { id: "12", label: "bash", agent: "terminal" },
          ],
          activeTerminalId,
          onSelectTerminal: (tabId) => selectedTerminals.push(tabId),
          terminalsAction: <button type="button" aria-label="New tab">+</button>,
          onShareSession: (sessionId) => sharedSessions.push(sessionId),
          onOpenSession: (sessionId) => railNavigations.push(sessionId),
          onOpenLanding: () => railNavigations.push(null),
        }}
        onApiReady={(next) => {
          api = next;
        }}
        onActiveSessionChange={(next) => {
          activeSessionId = next;
        }}
      />
    );
    mounted = await render(surface(false));
    await settle();
  }, 240_000);

  afterAll(async () => {
    await mounted?.unmount();
    railHost.remove();
    await harness?.stop();
  }, 60_000);

  it("mounts Lody's sidebar body into the rail's list region", async () => {
    await until("the vendored sidebar to render", () =>
      railHost.childElementCount > 0 ? true : undefined,
    );
    expect(api).not.toBeNull();
    // No provider is missing in the SECOND mount either. The portal renders
    // below `RuntimeProvider` and outside the memory router, which is a
    // different context path from the pages, so it is worth its own assertion.
    expect(
      consoleErrors.filter((line) => /must be used within|is not available/u.test(line)),
    ).toEqual([]);
  }, 90_000);

  it("suppresses their header and all of the footer but Archive (seams #2 and #13)", () => {
    // §0.3: `div.shell-rhead` stays native, so their workspace switcher must
    // not render — it is the one control that would duplicate it.
    expect(railHost.querySelector("[data-workspace-switcher-trigger]")).toBeNull();
    expect(railHost.querySelector("[data-workspace-identity]")).toBeNull();
    // A footer entry names itself in an `sr-only` span, so the label is the
    // button's text (`IconButton`, `loro-sidebar.tsx:527`).
    // Settings and Help are surfaces BlitzOS serves from its own chrome.
    for (const label of [/^Settings$/u, /^Help$/u]) {
      expect(railButton(label) === undefined, String(label)).toBe(true);
    }
    // Archive is upstream's only affordance that leads to the archive page, so
    // hiding it left the page unreachable. Seam patch 13 keeps exactly this one.
    expect(railButton(/^Archive$/u), "the footer's Archive entry").toBeDefined();
  });

  it("offers + New session, and it asks the shell for the landing", async () => {
    const newSession = await until("the New session entry", () =>
      railButton(/New session/u),
    );
    railNavigations.length = 0;
    await act(async () => {
      newSession.click();
    });
    await settle();
    // THE SHELL IS ASKED, and the surface has not moved on its own. That is the
    // third dogfood's reports 2 and 3: the surface is hidden whenever the panes
    // own the view, so a rail click that only moved the surface's router moved
    // a page nobody could see.
    expect(railNavigations).toEqual([null]);

    // And the shell then drives the surface, which is `CloudApp`'s
    // address-follows effect in one line.
    await act(async () => {
      api?.openLanding();
    });
    await settle();
    expect(activeSessionId).toBeNull();
    expect(api?.activeSessionId()).toBeNull();

    // From a session it comes back to the landing, which is the whole of "a new
    // chat session can be started from the rail" minus the paid turn.
    await act(async () => {
      api?.openSession("11111111-1111-4111-8111-111111111111");
    });
    await settle();
    expect(activeSessionId).toBe("11111111-1111-4111-8111-111111111111");
    railNavigations.length = 0;
    await act(async () => {
      railButton(/New session/u)?.click();
    });
    await settle();
    expect(railNavigations).toEqual([null]);
    await act(async () => {
      api?.openLanding();
    });
    await settle();
    expect(activeSessionId).toBeNull();
  }, 60_000);

  it("lists a session the daemon already had, under Chats", async () => {
    await until(
      "the seeded session to reach the rail",
      () => (railText().includes(SEEDED_TITLE) ? true : undefined),
      60_000,
    ).catch((cause: unknown) => {
      throw new Error(`${String(cause)}\n--- rail ---\n${railText()}`);
    });
    // It is a CHAT: no project, so Lody's own split puts it there and not under
    // GitHub Worktrees.
    expect(railText()).toContain("Chats");
    expect(railText()).not.toContain("GitHub Worktrees");
  }, 90_000);

  it("opens a chat session when its rail row is clicked", async () => {
    await act(async () => {
      api?.openLanding();
    });
    await settle();
    expect(activeSessionId).toBeNull();
    const row = railSessionRow(new RegExp(SEEDED_TITLE, "u"));
    expect(row, `rail: ${railText()}`).toBeDefined();
    expect(row?.getAttribute("role")).toBe("button");
    railNavigations.length = 0;
    // A SINGLE click, which is what the member reported as doing nothing. The
    // row's own handler is `onClick` (`session-list.tsx:929`), so the vendored
    // half was never the problem; where it went was.
    await act(async () => {
      (row as HTMLElement).click();
    });
    await settle();
    const opened = await until("the rail click to reach the shell", () =>
      railNavigations.at(-1) ?? undefined,
    );
    expect(opened).toMatch(/^[0-9a-f-]{36}$/u);

    // The shell honours it, and the surface arrives at the same session.
    await act(async () => {
      api?.openSession(opened);
    });
    await until("the surface to open the session", () =>
      activeSessionId === opened ? true : undefined,
    );
  }, 90_000);

  /**
   * PHASE 6 EXIT TEST 5, first half (plans/LODY-SHARING.md §7).
   *
   * The way in is THEIR row context menu, with no vendor hunk: `SessionList`
   * already draws a Share entry gated on the row carrying a `sharing` state and
   * the list carrying `onShareSessionWithTeam` (`session-list.tsx:1134`), and
   * the row's "⋯" opens that same menu by synthesizing a `contextmenu` event
   * (`sidebar-row-shared.tsx:507`). So this drives the real menu rather than a
   * button of ours, and what it proves is that the two props are enough.
   */
  it("offers Share on a session row's own context menu", async () => {
    const row = railSessionRow(new RegExp(SEEDED_TITLE, "u"));
    expect(row, `rail: ${railText()}`).toBeDefined();
    await act(async () => {
      (row as HTMLElement).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    });
    await settle();
    const item = await until("the Share entry to appear in the row menu", () =>
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((node) =>
        /share/iu.test(node.textContent ?? ""),
      ),
    ).catch((cause: unknown) => {
      const items = [...document.querySelectorAll("[role='menuitem']")]
        .map((node) => node.textContent).join(" | ");
      throw new Error(`${String(cause)}\n--- menu ---\n${items}`);
    });
    expect(item.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => {
      item.click();
    });
    await settle();
    expect(sharedSessions).toHaveLength(1);
    expect(sharedSessions[0]).toMatch(/^[0-9a-f-]{36}$/u);
  }, 90_000);

  it("draws Terminals always, and the Lody sections only once they hold rows", () => {
    // Terminals is ours, injected through their `afterSessionListContent` slot,
    // and it is always there: a workspace with no terminal tab is a state the
    // member acts on from the `+` in that header.
    expect(railText()).toContain("Terminals");
    // Chats and GitHub Worktrees are Lody's own section logic, fed from the
    // runtime — and upstream's rule is that an empty section renders nothing at
    // all, header included (`loro-app-sidebar.tsx:2095`). One chat was seeded
    // and no worktree session exists, so exactly one of the two is drawn.
    expect(railText()).toContain("Chats");
    expect(railText()).not.toContain("GitHub Worktrees");
  });

  it("keeps the terminal tabs exactly as the old rail drew them", async () => {
    const rows = [...railHost.querySelectorAll<HTMLElement>(".shell-s")];
    // The LABEL, not the whole row: the trailing slot now holds the close the
    // deleted native tab strip used to own.
    expect(rows.map((row) => row.querySelector(".shell-s__t")?.textContent))
      .toEqual(["claude · tab 1", "bash"]);
    // Same glyphs: `SessionTypeIcon` renders an svg into the same gutter span.
    expect(rows[0]?.querySelector(".shell-g .shell-g__glyph")).not.toBeNull();
    // The surface is showing a CONVERSATION, so no terminal row claims to be
    // selected. That is `activeTerminalId === ''` now rather than "the surface
    // is up": a terminal is a tab of this surface, so a row keeps its highlight
    // exactly when its terminal is the tab on screen (wave 3, ADJ1).
    expect(rows.some((row) => row.className.includes("shell-s--on"))).toBe(false);
    await act(async () => {
      rows[0]?.querySelector<HTMLButtonElement>(".shell-s__open")?.click();
    });
    expect(selectedTerminals).toEqual(["11"]);
    // The `+ New tab` menu keeps a home in the rail, in the Terminals header.
    expect(
      railButtons().some((button) => button.getAttribute("aria-label") === "New tab"),
    ).toBe(true);
  });

  it("marks the terminal whose TAB owns the surface's pane", async () => {
    // The other half of ADJ1: the surface is still up, and a terminal tab is
    // what it is drawing. The old rule dropped the highlight in exactly this
    // state — the one where the member is looking at that terminal.
    await act(async () => {
      mounted.root.render(surface(false, "12"));
    });
    await settle();
    const rows = [...railHost.querySelectorAll<HTMLElement>(".shell-s")];
    expect(rows[1]?.className).toContain("shell-s--on");
    expect(rows[0]?.className).not.toContain("shell-s--on");
    await act(async () => {
      mounted.root.render(surface(false));
    });
    await settle();
  });

  it("marks the active terminal when the panes own the view", async () => {
    // `hidden` is what `CloudApp` sets when a terminal row is clicked, and the
    // rail's highlight has to follow it: the surface is still MOUNTED.
    await act(async () => {
      mounted.root.render(surface(true));
    });
    await settle();
    const rows = [...railHost.querySelectorAll<HTMLElement>(".shell-s")];
    expect(rows[1]?.className).toContain("shell-s--on");
    await act(async () => {
      mounted.root.render(surface(false));
    });
    await settle();
  });

  // A DISPATCH IS A PAID TURN, and this is phase 4's whole budget: the rail's
  // New session, the real composer, one send, and the session that appears in
  // the rail's Chats section as a result.
  it.skipIf(process.env.BLITZ_LODY_LIVE_TURN !== "1" || !claudeCredentialAvailable())(
    "starts a chat from the rail and lists it under Chats",
    async () => {
      await act(async () => {
        railButton(/New session/u)?.click();
      });
      await settle();
      // The rail asks; the shell honours. Both halves, because the paid case is
      // the only one that drives the real composer afterwards.
      expect(railNavigations.at(-1)).toBeNull();
      await act(async () => {
        api?.openLanding();
      });
      await settle();
      const composer = await until("the landing composer", () => {
        const textarea = mounted.container.querySelector<HTMLTextAreaElement>("textarea");
        return textarea ?? undefined;
      }, 60_000);
      await act(async () => {
        typeInto(composer, LIVE_TURN_PROMPT);
      });
      const send = await until("the send button to arm", () => {
        const button = mounted.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Send"]',
        );
        return button !== null && !button.disabled ? button : undefined;
      }, 30_000);
      await act(async () => {
        send.click();
      });

      const sessionId = await until(
        "the surface to open the new session",
        () => activeSessionId ?? undefined,
        60_000,
      ).catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-4000)}`);
      });
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);

      // The rail is the thing under test: the session the landing created has
      // to arrive in Lody's own Chats section, through the session mirror, with
      // nothing of ours in between.
      const row = await until(
        "the session row to reach the rail",
        () =>
          railHost.querySelector<HTMLElement>(`[data-sidebar-session-id="${sessionId}"]`)
          ?? undefined,
        60_000,
      ).catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n--- rail ---\n${railText()}`);
      });
      expect(row).toBeDefined();
      // And a click on it routes: the rail drives the ADDRESS, and the address
      // drives the surface.
      await act(async () => {
        api?.openLanding();
      });
      await settle();
      expect(activeSessionId).toBeNull();
      railNavigations.length = 0;
      await act(async () => {
        row.click();
      });
      await settle();
      expect(await until("the rail click to reach the shell", () =>
        railNavigations.at(-1) ?? undefined,
      )).toBe(sessionId);
      await act(async () => {
        api?.openSession(sessionId);
      });
      await until("the surface to open the session", () =>
        activeSessionId === sessionId ? true : undefined,
      );
    },
    600_000,
  );

});

/** See `SEEDED_TITLE`. Free: it writes, it does not dispatch. */
async function seedSession(harness: LodyHarness): Promise<void> {
  const snapshot = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
  if (snapshot === null) throw new Error("the daemon served no catalog");
  const store = createStore();
  const handle = await createLodyRuntime({
    endpoints: {
      ...harness.endpoints,
      webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
    },
    snapshot,
  });
  try {
    mountLodyRuntimeAtoms(store, handle.runtime);
    await bootstrapLodyAgentConfigs(store, handle.runtime, snapshot.machineId);
    await startLodySession(handle.runtime, {
      sessionId: randomUUID(),
      machineId: snapshot.machineId,
      userId: snapshot.userId,
      agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
      agentType: "claude",
      prompt: "seed",
      title: SEEDED_TITLE,
    });
  } finally {
    unmountLodyRuntimeAtoms(store);
    await handle.dispose();
  }
}

/** Writes into a React-controlled textarea the way a keystroke does. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
