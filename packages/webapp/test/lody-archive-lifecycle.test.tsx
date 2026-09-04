/**
 * ARCHIVE → RESTORE → DELETE, against a real daemon, through real affordances.
 *
 * `lody-archive-page.test.tsx` proves the page mounts and that its two verbs
 * call the session actions. This file proves the OTHER half, which no stub can:
 * that those actions really move a session on the box, so a restored session
 * comes back to the rail and a deleted one does not come back at all.
 *
 * NOTHING HERE IS SYNTHESISED. The session is archived from the rail row's own
 * context menu, the archive page is reached from the rail footer's Archive entry
 * (seam patch 13 — upstream's own control), and restore and delete are the
 * page's own buttons. What the test drives is exactly what a member's cursor
 * drives, which is the only way to catch a page that renders and cannot act.
 *
 * FREE. A session is created by `startLodySession`, which is the accept unit —
 * session meta plus the first user turn in one write — and never dispatched, so
 * no model is called and no turn of anybody's subscription is spent. The suite
 * skips with no `lody` bundle installed, which is CI: the same gate phases 2, 3
 * and 4 chose.
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
import { lodyDaemonAvailable, startLodyHarness, type LodyHarness } from "./lody-daemon-harness";

/** Two sessions, so "the archived one left the rail" cannot pass on an empty
 * rail and "the deleted one is gone" cannot pass on an empty page. */
const KEPT_TITLE = "kept by the archive lifecycle test";
const MOVED_TITLE = "moved by the archive lifecycle test";

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

/** Two sessions on the daemon, written the way the landing writes one, MINUS
 * the dispatch — the free half (`lody-session-rail.test.tsx`'s `seedSession`).
 * The runtime is disposed before the surface mounts, so there is never a second
 * `window.ipc` or a second data plane in flight. */
async function seedSessions(harness: LodyHarness): Promise<void> {
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
    for (const title of [KEPT_TITLE, MOVED_TITLE]) {
      await startLodySession(handle.runtime, {
        sessionId: randomUUID(),
        machineId: snapshot.machineId,
        userId: snapshot.userId,
        agentConfigId: BLITZ_CLAUDE_CONFIG_ID,
        agentType: "claude",
        prompt: "seed",
        title,
      });
    }
  } finally {
    unmountLodyRuntimeAtoms(store);
    await handle.dispose();
  }
}

describe.skipIf(!lodyDaemonAvailable())("the archive page, against a real daemon", () => {
  let harness: LodyHarness;
  let mounted: Awaited<ReturnType<typeof render>>;
  let api: LodySessionSurfaceApi | null = null;
  /** The rail's list region, stood up exactly as `SessionRail` renders it. */
  const railHost = document.createElement("div");
  railHost.className = "session-list session-list--vendor";

  const railText = (): string => railHost.textContent ?? "";
  const railButtons = (): HTMLButtonElement[] => [
    ...railHost.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const railButton = (match: RegExp): HTMLButtonElement | undefined =>
    railButtons().find((button) => match.test(button.textContent ?? ""));
  const railSessionRow = (match: RegExp): HTMLElement | undefined =>
    [...railHost.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")].find((row) =>
      match.test(row.textContent ?? ""),
    );
  /** The page, which renders in the surface rather than in the rail's portal. */
  const pageText = (): string => mounted.container.textContent ?? "";
  const pageButton = (label: string): HTMLButtonElement | undefined =>
    [...mounted.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label,
    );

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.click();
    });
    await settle();
  }

  /** Their row context menu, opened the way the row's own "⋯" opens it
   * (`sidebar-row-shared.tsx:507` synthesizes exactly this event). */
  async function rowMenuItem(row: HTMLElement, match: RegExp): Promise<HTMLElement> {
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
      );
    });
    await settle();
    return await until(`the ${String(match)} entry in the row menu`, () =>
      [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((node) =>
        match.test(node.textContent ?? ""),
      ),
    );
  }

  beforeAll(async () => {
    installLodyDomStubs();
    document.body.append(railHost);
    const module: { SessionSurface: (props: LodySessionSurfaceProps) => ReactNode } =
      await import("../src/lody/SessionSurface");
    const SessionSurface = module.SessionSurface;
    harness = await startLodyHarness();
    await seedSessions(harness);
    mounted = await render(
      <SessionSurface
        endpoints={{
          ...harness.endpoints,
          // See `lody-session-surface.test.tsx`: under jsdom the global
          // WebSocket is undici's and never delivers an event to a listener.
          webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
        }}
        viewer={{ name: "Archive", avatarUrl: null }}
        workspaceTitle="Archive workspace"
        railHost={railHost}
        rail={{
          // NO `onOpenArchive` AND NO `onOpenSession`. Absent, the rail falls
          // back to the surface's own router, which is the headless composition
          // `SessionSurface` documents — and it is what lets this suite drive
          // the footer entry without standing up `CloudApp`'s address plane.
        }}
        onApiReady={(next) => {
          api = next;
        }}
      />,
    );
    await settle();
    await until("the vendored sidebar to render", () =>
      railHost.childElementCount > 0 ? true : undefined,
    );
  }, 240_000);

  afterAll(async () => {
    await mounted?.unmount();
    railHost.remove();
    await harness?.stop();
  }, 60_000);

  it("archives one session from the rail, and the archive page is where it went", async () => {
    const row = await until(`the ${MOVED_TITLE} row`, () =>
      railSessionRow(new RegExp(MOVED_TITLE, "u")),
    );
    const archive = await rowMenuItem(row, /archive/iu);
    await click(archive);

    // Upstream confirms an archive before it takes it ("Archive chat?"), so the
    // dialog is part of the affordance rather than an obstacle to route around.
    const confirm = await until("the archive confirmation", () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => /^archive$/iu.test(button.textContent ?? ""),
      ),
    );
    await click(confirm);

    // The rail lists exactly the UN-archived sessions, so the row leaves it —
    // and the other one stays, which is what makes the first half mean
    // something.
    await until("the archived row to leave the rail", () =>
      railSessionRow(new RegExp(MOVED_TITLE, "u")) === undefined ? true : undefined,
    );
    expect(railText()).toContain(KEPT_TITLE);

    // The way in is upstream's own footer entry (seam patch 13), not a control
    // of ours: with no `onOpenArchive` binding the rail navigates the surface's
    // own router, which is what the headless composition does.
    const entry = railButton(/^Archive$/u);
    expect(entry, "the rail footer's Archive entry").toBeDefined();
    await click(entry!);
    expect(api?.isArchiveOpen()).toBe(true);

    await until("the archived session to appear on the page", () =>
      pageText().includes(MOVED_TITLE) ? true : undefined,
    );
    // The page lists the ARCHIVED ones and only those.
    expect(pageText()).not.toContain(KEPT_TITLE);
  }, 120_000);

  it("restores it, and the rail gets the row back", async () => {
    const restore = await until("the row's Restore control", () =>
      pageButton("Restore session"),
    );
    await click(restore);

    // The whole claim of the feature: a restored session is an ordinary session
    // again, on the daemon, so the rail lists it without a reload.
    await until("the restored row to return to the rail", () =>
      railSessionRow(new RegExp(MOVED_TITLE, "u")) !== undefined ? true : undefined,
    );
    await until("the restored session to leave the archive page", () =>
      pageText().includes(MOVED_TITLE) ? undefined : true,
    );
  }, 120_000);

  it("deletes it permanently, and only after the confirmation", async () => {
    // Archive it again, so there is something to delete.
    const row = await until(`the ${MOVED_TITLE} row`, () =>
      railSessionRow(new RegExp(MOVED_TITLE, "u")),
    );
    await click(await rowMenuItem(row, /archive/iu));
    await click(
      await until("the archive confirmation", () =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => /^archive$/iu.test(button.textContent ?? ""),
        ),
      ),
    );
    const target = await until("the archived session on the page", () =>
      pageText().includes(MOVED_TITLE) ? true : undefined,
    );
    expect(target).toBe(true);

    await click(await until("the row's Delete control", () => pageButton("Delete permanently")));
    // THE CLICK ALONE MUST NOT DELETE. A permanent delete has no undo, and the
    // row's trash icon sits one pixel from Restore.
    expect(document.body.textContent).toContain("Delete permanently?");
    expect(pageText(), "nothing is gone yet").toContain(MOVED_TITLE);

    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Delete",
    );
    expect(confirm, "the dialog's Delete button").toBeDefined();
    await click(confirm!);

    await until("the deleted session to leave the archive page", () =>
      pageText().includes(MOVED_TITLE) ? undefined : true,
    );
    // Permanent means it does not come back as an ordinary session either.
    expect(railSessionRow(new RegExp(MOVED_TITLE, "u"))).toBeUndefined();
    expect(railText(), "the session it was not").toContain(KEPT_TITLE);
  }, 120_000);
});
