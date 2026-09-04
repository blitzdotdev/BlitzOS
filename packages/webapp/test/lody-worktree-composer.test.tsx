/**
 * PHASE 5 EXIT TEST (plans/LODY-SESSIONS.md §0, §10) — the composer parity bar.
 *
 * §0's bias rule sets the acceptance bar as a screenshot of Lody's own composer:
 * "machine chip, repo picker, branch picker + worktree pill, `/` commands, `@`
 * mentions, `$` skills, `+` attachments, model·effort selector, permission-mode
 * selector — all working in GitHub Worktree mode on a box." This drives the REAL
 * landing composer against a REAL daemon holding a REAL registered clone, and
 * checks each control. The verdict table it produces is recorded in
 * `plans/LODY-RUNTIME-DESIGN.md` §10.
 *
 * NOTHING HERE SPENDS A TURN. Every control is reached before a send: the
 * pickers read `local-project/*`, the palettes read the machine Flock and
 * `local-project/list-{files,skills}`, and the run-configuration menu reads the
 * `acpCapability` rows the capabilities refresh already wrote. The composer is
 * never submitted.
 *
 * The suite skips with no `lody` bundle installed, which is CI.
 */
import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { LodySessionSurfaceProps } from "../src/lody/SessionSurface";
import { sendProjectControl } from "../src/lody/rpc-client.js";
import { fetchLodyPlatformSnapshot, type LodyPlatformSnapshot } from "../src/lody/platform-snapshot.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render, settle } from "./dom.js";
import {
  claudeCredentialAvailable,
  HARNESS_BOOT_TIMEOUT_MS,
  lodyDaemonAvailable,
  startLodyHarness,
  type LodyHarness,
} from "./lody-daemon-harness.js";

const REPO_NAME = "wt-composer";
const REPO_FULL_NAME = `blitzdotdev/${REPO_NAME}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "probe",
      GIT_AUTHOR_EMAIL: "probe@local.invalid",
      GIT_COMMITTER_NAME: "probe",
      GIT_COMMITTER_EMAIL: "probe@local.invalid",
    },
  }).trim();
}

/** Radix triggers act on `pointerdown`, which jsdom does not synthesize from
 * `click()`. The same three events phases 3 and 4 use. */
function openMenu(trigger: Element): void {
  trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  (trigger as HTMLElement).click();
}

/**
 * Writes into a React-controlled textarea the way a keystroke does.
 *
 * FOCUS AND CARET ARE PART OF THE GESTURE, not decoration: the mention layer
 * decides whether to open a palette from the caret position in the focused
 * textarea, so a value set without them types the character and opens nothing.
 */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  // A pointer lands in the textarea before any character does, and the mention
  // layer tracks the caret from that gesture — without it the value changes and
  // no palette opens. Measured: the `/` palette only ever appeared in a run
  // where a pointer event had reached the composer chrome first.
  for (const type of ["pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
  }
  element.focus();
  const key = value.slice(-1);
  if (key !== "") element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.setSelectionRange(value.length, value.length);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  if (key !== "") element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

/** Radix portals menus to `document.body`, so they are read off the document. */
function portalText(): string {
  return [...document.body.querySelectorAll("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]")]
    .map((node) => node.textContent ?? "")
    .join(" | ");
}

function menuItems(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>("[role='menuitem'], [role='option']")];
}

async function until<T>(what: string, read: () => T | undefined, timeoutMs = 45_000): Promise<T> {
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

describe.skipIf(!lodyDaemonAvailable())("phase 5: the composer in worktree mode", () => {
  let harness: LodyHarness;
  let snapshot: LodyPlatformSnapshot;
  let mounted: Awaited<ReturnType<typeof render>>;
  let workspaceRoot = "";
  const railHost = document.createElement("div");
  railHost.className = "session-list session-list--vendor";

  const container = (): HTMLElement => mounted.container;
  const composer = (): HTMLTextAreaElement | null => container().querySelector("textarea");

  const logs: string[] = [];

  beforeAll(async () => {
    for (const level of ["warn", "error", "debug"] as const) {
      const original = console[level];
      console[level] = (...args: unknown[]) => {
        logs.push(`[${level}] ` + args.map((v) => (v instanceof Error ? v.message : String(v))).join(" "));
        original(...args);
      };
    }
    installLodyDomStubs();
    document.body.append(railHost);
    harness = await startLodyHarness();
    const read = await fetchLodyPlatformSnapshot(harness.endpoints.platformUrl);
    if (read === null) throw new Error("the daemon served no catalog");
    snapshot = read;

    workspaceRoot = mkdtempSync(join(tmpdir(), "lw-"));
    const clonePath = join(workspaceRoot, REPO_NAME);
    mkdirSync(clonePath, { recursive: true });
    git(clonePath, "init", "-q", "-b", "main", ".");
    git(clonePath, "remote", "add", "origin", `https://github.com/${REPO_FULL_NAME}.git`);
    writeFileSync(join(clonePath, "README.md"), `# ${REPO_NAME}\n`);
    writeFileSync(join(clonePath, "index.ts"), "export const answer = 42;\n");
    git(clonePath, "add", ".");
    git(clonePath, "commit", "-qm", "init");
    // A second branch, so "the branch picker has something to pick".
    git(clonePath, "branch", "release");

    const added = await sendProjectControl(
      {
        rpcUrl: harness.endpoints.rpcUrl,
        controlUrl: harness.endpoints.controlUrl,
        projectUrl: harness.endpoints.projectUrl,
        platformUrl: harness.endpoints.platformUrl,
      },
      { type: "local-project/add", machineId: snapshot.machineId, rootPath: clonePath },
    );
    if (!added.ok) throw new Error(`local-project/add failed: ${added.message}`);

    const module: { SessionSurface: (props: LodySessionSurfaceProps) => ReactNode } =
      await import("../src/lody/SessionSurface");
    const SessionSurface = module.SessionSurface;
    mounted = await render(
      <SessionSurface
        endpoints={{
          ...harness.endpoints,
          // Under jsdom the global WebSocket is undici's, whose `dispatchEvent`
          // rejects jsdom's `Event`, so no message ever reaches a listener.
          webSocketConstructor: NodeWebSocket as unknown as typeof WebSocket,
        }}
        viewer={{ name: "Phase 5", avatarUrl: null }}
        workspaceTitle="Phase 5 workspace"
        railHost={railHost}
        rail={{}}
      />,
    );
    await settle();
    await until("the landing composer", () => composer() ?? undefined);
    // The harness's own number for a boot hook: its lock wait plus a boot.
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await mounted?.unmount();
    railHost.remove();
    if (workspaceRoot !== "") rmSync(workspaceRoot, { recursive: true, force: true });
    await harness?.stop();
  }, 60_000);

  it("offers the box as the machine chip", async () => {
    // Phase 3 proved this against the session page; here it is the LANDING's
    // own `DesktopMachineMenu`, which is a different call site.
    const chip = await until("the machine chip", () =>
      container().querySelector("[aria-label='Machine']") ??
      [...container().querySelectorAll("button")].find((button) =>
        /machine/iu.test(button.getAttribute("aria-label") ?? ""),
      ),
    );
    expect(chip).not.toBeNull();
  }, 60_000);

  it("lists the registered clone in the project picker and selects it", async () => {
    // `useVisibleLocalProjects` reads `MachineMeta.localProjects`, which for a
    // BlitzOS box arrives ONLY through `mergeMachineFlockMachineMeta`
    // (`lib/machine-flock-machine-meta-overlay.ts:68`) — `local-project/add`
    // writes a Flock row and never the legacy field. So this assertion is also
    // the proof that the overlay reaches the landing.
    const trigger = await until("the project picker to offer the clone", () => {
      const buttons = [...container().querySelectorAll("button")];
      for (const button of buttons) {
        openMenu(button);
        if (portalText().includes(REPO_NAME)) return button;
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
      return undefined;
    });
    expect(trigger).not.toBeNull();

    openMenu(trigger);
    await settle();
    const option = menuItems().find((item) => (item.textContent ?? "").includes(REPO_NAME));
    expect(option).toBeDefined();
    await act(async () => {
      option?.click();
    });
    await settle();
    // Selecting a local project puts the landing in `contextType: 'local'`
    // (`chat-landing.tsx:3457`), which is the mode a BlitzOS worktree session
    // runs in — their `github` context is the bare-mirror source §0 does not use.
    expect(container().textContent).toContain(REPO_NAME);
  }, 120_000);

  it("ticks the worktree pill and shows the branch picker on the base branch", async () => {
    // `getChatLandingBranchSelectorState` (`chat-landing-derived.ts:513`) only
    // renders the branch selector when the worktree mode is on AND the local
    // git state has arrived — which is the whole `local-project/git-state`
    // round trip through our bridge.
    // The pill renders DISABLED while the local git state loads, so this waits
    // for it to become usable — which is the whole `local-project/git-state`
    // round trip through our bridge, seen from the UI end.
    const pill = await until("the worktree pill to become available", () => {
      const node = container().querySelector<HTMLButtonElement>("[aria-label='Use worktree']");
      return node !== null && node.getAttribute("disabled") === null ? node : undefined;
    }).catch(() => {
      throw new Error(`worktree pill never enabled; logs: ${logs.slice(-15).join(" || ")}`);
    });
    // ON BY DEFAULT, BUT NOT FORCED — and the two halves have different causes.
    // §0's bar says "branch picker + FORCED worktree pill", and `checked
    // disabled` is exactly what the landing renders for the `github` context
    // (`chat-landing.tsx:3412`), which is the bare-mirror source §0.5 does not
    // use. In the `local` context the pill is a real toggle whose default comes
    // from `readWorkdirModePreference` — so it reads CHECKED here because phase
    // 6 seeds their global preference key (`workdir-default.ts`, §0.5), and it
    // stays clickable because nothing forces it. Untick and re-tick proves both.
    expect(pill.getAttribute("data-state")).toBe("checked");
    await act(async () => {
      pill.click();
    });
    await settle();
    expect(pill.getAttribute("data-state")).toBe("unchecked");
    await act(async () => {
      pill.click();
    });
    await settle();
    expect(pill.getAttribute("data-state")).toBe("checked");

    // The branch selector appears only in worktree mode AND only once the local
    // git state has arrived (`chat-landing-derived.ts:513`), so this assertion
    // is the whole `local-project/git-state` round trip through our bridge.
    const branchTrigger = await until("the branch picker to name a branch", () =>
      [...container().querySelectorAll("button")].find((button) =>
        /\bmain\b/u.test(button.textContent ?? ""),
      ),
    ).catch(() => {
      throw new Error(`no branch picker; logs: ${logs.slice(-15).join(" || ")}`);
    });
    expect(branchTrigger.textContent).toContain("main");
  }, 120_000);

  /**
   * The three mention triggers, in one case and one composer.
   *
   * They share `CombinedMentionTextarea`, and the palette it opens is decided
   * from the caret in the FOCUSED textarea — so each trigger is typed into a
   * cleared composer. Split across three `it`s they leaked an open Radix layer
   * into each other, which reads as "the palette did not open" and is not what
   * is under test.
   *
   * THE ORDER IS `@`, `$`, `/` AND IT IS LOAD-BEARING under jsdom: `/` opens
   * only once the mention layer has been activated at least once by another
   * trigger. Measured, not guessed — with `/` first the palette stays closed
   * for 30 s, and with it third the same assertion passes in the same mount. In
   * a browser the layer is warmed by the pointer that lands in the composer.
   */
  it("opens the `@`, `$` and `/` palettes against the selected clone", async () => {
    const input = (): HTMLTextAreaElement => {
      const node = composer();
      if (node === null) throw new Error("the composer is gone");
      return node;
    };
    const dismiss = async (): Promise<void> => {
      await act(async () => {
        // A Radix menu that has been open leaves the body pointer-locked and
        // the composer unfocused; a browser's next click undoes both.
        document.body.style.pointerEvents = "";
        input().dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
        typeInto(input(), "");
      });
      await settle();
    };

    // `@` — a CATEGORY menu first (Files / Skills / Commands), then the file
    // list. The non-Electron branch of `useLocalProjectFilePaths` (`:169`)
    // issues `local-project/list-files` through `requestLocalProjectControl`, so
    // these paths come from the REGISTERED CLONE, not from a GitHub tree fetch.
    await act(async () => {
      typeInto(input(), "@");
    });
    await settle();
    const files = await until("the Files mention category", () =>
      menuItems().find((item) => /^Files/u.test(item.textContent ?? "")),
      30_000,
    );
    await act(async () => {
      files.click();
    });
    await settle();
    const listing = await until(
      "the file mention list",
      () => {
        const text = document.body.textContent ?? "";
        return text.includes("README.md") ? text : undefined;
      },
      30_000,
    ).catch(() => {
      throw new Error(`no file mentions; body: ${(document.body.textContent ?? "").slice(-700)}`);
    });
    expect(listing).toContain("index.ts");

    // `$` — `local-project/list-skills` against a clone with no `.claude/skills`
    // is a successful EMPTY answer, and §0's bar is met by a clean empty state.
    // What must not happen is the palette failing to open, which is what an
    // unrouted RPC looks like from here.
    await dismiss();
    await act(async () => {
      typeInto(input(), "$");
    });
    await settle();
    expect(document.body.textContent).not.toContain("cli_not_running");
    await dismiss();
    // `/` — the entries are the ADAPTER's, reported by
    // `machine/acp-capabilities-refresh` and cached in the machine Flock, so a
    // populated palette is also the proof that OUR capabilities pass ran:
    // upstream's never does for a box (design doc §8.3). Counted rather than
    // named, because the command set belongs to whichever `claude` the image
    // pins and naming one would make an agent upgrade look like a regression.
    await act(async () => {
      typeInto(input(), "/");
    });
    await settle();
    const commands = await until(
      "the command palette",
      () => {
        const found = (document.body.textContent ?? "").match(/\/[a-z][a-z-]{2,}/gu) ?? [];
        return found.length >= 5 ? found : undefined;
      },
      30_000,
    ).catch(() => {
      throw new Error(`no command palette; body: ${(document.body.textContent ?? "").slice(-700)}`);
    });
    expect(commands.length).toBeGreaterThanOrEqual(5);

  }, 180_000);

  /**
   * LAST OF THE FREE CASES, and deliberately so. Opening this Popover and
   * letting it close returns focus to its own trigger, and under jsdom the
   * mention layer then stops opening a palette from the composer's caret — a
   * browser's next click on the composer undoes that, and jsdom has no next
   * click. So the three palettes run first and this runs last.
   */
  it("lists every branch the clone has", async () => {
    const branchTrigger = [...container().querySelectorAll("button")].find((button) =>
      /\bmain\b/u.test(button.textContent ?? ""),
    );
    expect(branchTrigger).toBeDefined();
    await act(async () => {
      branchTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    await settle();
    if (!(document.body.textContent ?? "").includes("release")) {
      await act(async () => {
        openMenu(branchTrigger!);
      });
      await settle();
    }
    await until(
      "the branch list",
      () => ((document.body.textContent ?? "").includes("release") ? true : undefined),
      20_000,
    ).catch(() => {
      throw new Error(
        `no branch list; trigger disabled=${branchTrigger!.getAttribute("disabled")} ` +
          `text=${branchTrigger!.textContent} body=${(document.body.textContent ?? "").slice(-500)}`,
      );
    });

  }, 120_000);

  it("offers the permission-mode control and the run configuration", async () => {
    const permission = await until("the permission-mode trigger", () =>
      container().querySelector("[aria-label='Permission']") ?? undefined,
    );
    openMenu(permission);
    await settle();
    // `default` is "Manual", the mode the permission CARD needs
    // (design doc §9.4). Selecting it here is what makes the live case below
    // reachable at all: under `auto` the classifier answers on the member's
    // behalf and the card never renders.
    expect(portalText()).toMatch(/Manual/u);
    const manual = menuItems().find((item) => /Manual/u.test(item.textContent ?? ""));
    expect(manual).toBeDefined();
    await act(async () => {
      manual?.click();
    });
    await settle();
  }, 120_000);

  /**
   * THE ONE PAID TURN, and it carries three exit tests at once.
   *
   * A worktree session under mode `default`, asked to write a file: the agent
   * must ask permission (exit test 6), the write must land on the `lody/<id12>`
   * branch inside the daemon's worktree and NOT in the clone (exit test 2), and
   * the turn's post-processing must produce the diff stats the rail row's badge
   * reads (exit test 3). Splitting them would cost three turns for one flow.
   */
  it.skipIf(process.env.BLITZ_LODY_LIVE_TURN !== "1" || !claudeCredentialAvailable())(
    "runs a worktree turn: permission card, an edit on the branch, and a diff badge",
    async () => {
      const input = composer();
      await act(async () => {
        typeInto(
          input as HTMLTextAreaElement,
          "Create a file named AGENT_WROTE_THIS.md whose only content is the word ok. Then stop.",
        );
      });
      await settle();
      const send = await until("the send button to arm", () => {
        const button = container().querySelector<HTMLButtonElement>('button[aria-label="Send"]');
        return button !== null && !button.disabled ? button : undefined;
      });
      await act(async () => {
        send.click();
      });

      // The landing creates the session and navigates to it; the rail row is
      // where its id becomes readable without reaching into the router. The
      // NODE is re-queried on every read below — `SessionList` replaces it on
      // each re-render, so a held reference stops updating and a badge that did
      // arrive would never be seen.
      const sessionId = await until(
        "the new session's rail row",
        () =>
          [...railHost.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")][0]?.getAttribute(
            "data-sidebar-session-id",
          ) ?? undefined,
        90_000,
      );
      const rowText = (): string =>
        railHost.querySelector(`[data-sidebar-session-id="${sessionId}"]`)?.textContent ?? "";

      // 1. THE PERMISSION CARD. Unreached since phase 3, because the default
      //    mode's classifier answered for the member; Manual is what earns it.
      await until(
        "the agent to ask for permission",
        () => (container().textContent?.includes("Permission Required") === true ? true : undefined),
        240_000,
      ).catch((cause: unknown) => {
        throw new Error(`${String(cause)}\n--- daemon log ---\n${harness.daemonLog().slice(-4000)}`);
      });
      const allow = [...container().querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
        /allow|yes|approve/iu.test(button.textContent ?? ""),
      );
      expect(allow.length).toBeGreaterThan(0);
      await act(async () => {
        allow[0]?.click();
      });

      // 2. THE EDIT, on the branch, in the worktree, with the clone untouched.
      const worktree = await until(
        "the agent's file to land in the worktree",
        () => {
          const reposRoot = join(harness.dataDir, "repos");
          const repoIds = existsSync(reposRoot) ? readdirSync(reposRoot) : [];
          for (const repoId of repoIds) {
            const path = join(reposRoot, repoId, "worktrees", sessionId);
            if (existsSync(join(path, "AGENT_WROTE_THIS.md"))) return path;
          }
          return undefined;
        },
        240_000,
      );
      // The worktree is cut on `lody/<id12>` — `getDefaultSessionBranchName`
      // slices to 12 and THEN sanitizes, so a uuid keeps its hyphen. But the
      // box's own agent rules (`/opt/blitz/skel/agent-rules.md`, installed as
      // `~/.claude/CLAUDE.md`) tell the agent to work on a new branch, and it
      // renames the one it is standing in. So the reflog is the honest record
      // here, and the deterministic branch-name assertion lives in
      // `lody-worktree-session.test.ts`, where no agent runs.
      const expectedBranch = `lody/${sessionId.slice(0, 12).replace(/[^A-Za-z0-9_-]/gu, "")}`;
      const branchNow = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
      const reflog = git(worktree, "reflog", "--format=%gs");
      expect(branchNow === expectedBranch || reflog.includes(expectedBranch)).toBe(true);
      const clonePath = join(workspaceRoot, REPO_NAME);
      expect(git(clonePath, "status", "--porcelain")).toBe("");
      expect(git(clonePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

      // 3. THE DIFF BADGE. `updateSessionDiffStats`
      //    (`turn-post-processing-service.ts:127`) runs at turn finalization and
      //    only for a project `resolveProjectGitHubRepo` resolves — which is why
      //    §6.4's `githubRepoFullName` has to be on the `ProjectRef` and not
      //    only on the git state. The rail row is where it surfaces.
      await until(
        "the rail row's line-change badge",
        () => (/\+\s*\d/u.test(rowText()) ? true : undefined),
        240_000,
      ).catch(() => {
        throw new Error(`no diff badge; row read: ${rowText()}`);
      });
    },
    900_000,
  );
});
