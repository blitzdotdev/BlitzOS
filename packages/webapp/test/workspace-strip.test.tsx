import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStrip } from "../src/shell/WorkspaceStrip.js";
import type { TenantMe } from "../src/api-adapter.js";
import type { CloudWorkspaceModel } from "../src/workspace-store.js";
import { render } from "./dom.js";
import { workspaceModelFixture } from "./workspace-fixtures.js";

const workspaceCss = readFileSync(join(process.cwd(), "src", "webapp-workspace.css"), "utf8");

const acme = { id: "org-one", slug: "acme", name: "Acme", vmLimit: 10 };
const side = { id: "org-two", slug: "side", name: "Side", vmLimit: 10 };
const membership = { id: "membership-one", role: "admin" as const, status: "active" as const };

const viewer: TenantMe = {
  identity: {
    id: "user-one",
    email: "person@example.com",
    name: "Person",
    avatarUrl: null,
    platformOperator: false,
  },
  membership,
  org: acme,
  organizations: [{ membership, org: acme }, { membership, org: side }],
};

function workspace(overrides: Partial<CloudWorkspaceModel> = {}): CloudWorkspaceModel {
  return workspaceModelFixture(overrides);
}

function strip(overrides: Partial<Parameters<typeof WorkspaceStrip>[0]> = {}) {
  return (
    <WorkspaceStrip
      workspaces={[workspace()]}
      viewer={viewer}
      activeWorkspaceId="workspace-one"
      onSelectWorkspace={() => undefined}
      onRenameWorkspace={() => undefined}
      onOpenWorkspaceSettings={() => undefined}
      onInviteToWorkspace={() => undefined}
      onCreateWorkspace={() => undefined}
      onOpenSettings={() => undefined}
      onCloseDrawer={() => undefined}
      {...overrides}
    />
  );
}

describe("workspace strip", () => {
  it("draws one tile per workspace with an accessible Discord-style selection state", async () => {
    const view = await render(strip({
      workspaces: [
        workspace(),
        workspace({ id: "workspace-two", title: "engineering", lifecycleStatus: "parked" }),
      ],
    }));
    const tiles = [...view.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Workspaces"] button',
    )];
    expect(tiles).toHaveLength(3);
    expect(tiles[0]?.getAttribute("aria-current")).toBe("page");
    expect(tiles[1]?.getAttribute("aria-current")).toBeNull();
    expect(tiles[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tiles[1]?.getAttribute("aria-selected")).toBe("false");
    expect(tiles[0]?.querySelector(".shell-wtile__indicator")?.getAttribute("aria-hidden")).toBe("true");
    expect(tiles[2]?.getAttribute("aria-label")).toBe("Create workspace");
    const sigils = tiles.slice(0, 2).map((tile) => tile.querySelector<SVGElement>(".shell-wtile__sigil"));
    expect(sigils.every((sigil) => sigil !== null)).toBe(true);
    expect(sigils[0]?.querySelectorAll("rect").length).toBeGreaterThan(1);
    expect(sigils[0]?.querySelector("rect")?.getAttribute("fill"))
      .not.toBe(sigils[1]?.querySelector("rect")?.getAttribute("fill"));
    expect(tiles[2]?.querySelector(".shell-wtile__sigil")).toBeNull();
    await view.unmount();
  });

  it("refuses to switch to a workspace the viewer cannot control", async () => {
    const onSelectWorkspace = vi.fn();
    const view = await render(strip({
      workspaces: [workspace({ canControl: false, accessRole: "viewer", shared: true })],
      onSelectWorkspace,
    }));
    const tile = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="design-team"]',
    );
    expect(tile?.disabled).toBe(true);
    expect(tile?.title).toBe("design-team — shared by Ada Owner");
    await view.unmount();
  });

  it("opens a context menu on a tile, clamped to the viewport", async () => {
    const onOpenWorkspaceSettings = vi.fn();
    const onInviteToWorkspace = vi.fn();
    const onSelectWorkspace = vi.fn();
    const view = await render(strip({
      onOpenWorkspaceSettings,
      onInviteToWorkspace,
      onSelectWorkspace,
    }));
    const tile = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="design-team"]',
    );
    await act(async () => tile?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 90,
    })));

    const menu = view.container.querySelector<HTMLElement>('[role="menu"][aria-label="Workspace design-team"]');
    expect(menu).not.toBeNull();
    // The backdrop must never be a <button>: with no global button reset, a
    // fullscreen button paints the UA's opaque button face over the whole app.
    const backdrop = view.container.querySelector<HTMLElement>(".webapp-session-backdrop");
    expect(backdrop?.tagName).toBe("DIV");
    expect(menu?.style.left).toBe("40px");
    expect(menu?.style.top).toBe("90px");
    const items = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Rename", "Settings", "Invite"]);

    await act(async () => items[2]?.click());
    expect(onInviteToWorkspace).toHaveBeenCalledWith("workspace-one");
    // Right-clicking is not left-clicking: the tile was never selected.
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="menu"][aria-label="Workspace design-team"]')).toBeNull();
    await view.unmount();
  });

  it("resets native button chrome so the context menu keeps its themed surface", () => {
    const menuRule = /\.webapp-session-menu button\s*\{(?<body>[^}]*)\}/u.exec(workspaceCss);
    expect(menuRule?.groups?.body).toMatch(/\bborder:\s*0;/u);
    expect(menuRule?.groups?.body).toMatch(/\bbackground:\s*transparent;/u);
  });

  it("offers a non-admin Settings alone, and renames through the caller's PATCH", async () => {
    const onRenameWorkspace = vi.fn();
    const view = await render(strip({
      workspaces: [workspace({ myRole: "member" })],
      onRenameWorkspace,
    }));
    const openMenu = async () => {
      await act(async () => view.container.querySelector<HTMLButtonElement>(
        'button[aria-label="design-team"]',
      )?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      })));
      const menu = view.container.querySelector('[role="menu"][aria-label="Workspace design-team"]');
      return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    };
    // A member reads the settings and administers nothing (§3).
    expect((await openMenu()).map((item) => item.textContent)).toEqual(["Settings"]);

    await act(async () => view.root.render(strip({
      workspaces: [workspace()],
      onRenameWorkspace,
    })));
    const rename = (await openMenu()).find((item) => item.textContent === "Rename");
    await act(async () => rename?.click());

    const field = view.container.querySelector<HTMLInputElement>('[aria-label="Workspace name"]');
    expect(field?.value).toBe("design-team");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        ?.set?.call(field, "renamed-team");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => field?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    })));
    expect(onRenameWorkspace).toHaveBeenCalledWith("workspace-one", "renamed-team");
    expect(view.container.querySelector('[aria-label="Workspace name"]')).toBeNull();
    await view.unmount();
  });

  it("carries no org control: only workspace tiles live above the strip's tools", async () => {
    // The org mark read as a workspace tile, so org switching moved to
    // Settings → Profile (owner annotation 2026-09-01).
    const view = await render(strip());
    expect(view.container.querySelector('button[aria-label="Organization: Acme"]')).toBeNull();
    expect(view.container.querySelector('[role="menu"][aria-label="Organizations"]')).toBeNull();
    // By class as well as by label: the classes are what a hand-written strip
    // (the design preview's, say) reaches for, and they have no CSS any more.
    expect(view.container.querySelector(".shell-orgmark")).toBeNull();
    expect(view.container.querySelector(".shell-strip__orgwrap")).toBeNull();
    // The strip opens on the workspace tiles; nothing precedes them.
    const aside = view.container.querySelector(".shell-strip");
    expect(aside?.querySelector(".shell-strip__tiles")?.previousElementSibling)
      .toBe(aside?.querySelector(".shell-strip__close"));
    expect(view.container.querySelectorAll(".shell-strip__sep").length).toBe(0);
    await view.unmount();
  });

  it("goes straight to settings from the avatar, with no menu in between", async () => {
    const onOpenSettings = vi.fn();
    const view = await render(strip({ onOpenSettings }));
    const avatar = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Settings"]',
    );
    expect(avatar?.title).toBe("Person");
    expect(avatar?.getAttribute("aria-haspopup")).toBeNull();
    await act(async () => avatar?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[role="menu"][aria-label="Account"]')).toBeNull();
    await view.unmount();
  });
});
