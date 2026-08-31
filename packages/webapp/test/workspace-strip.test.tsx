import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStrip, workspaceCode } from "../src/shell/WorkspaceStrip.js";
import type { TenantMe } from "../src/api-adapter.js";
import type { CloudWorkspaceModel } from "../src/workspace-store.js";
import { render } from "./dom.js";
import { workspaceModelFixture } from "./workspace-fixtures.js";

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
      presenceSnapshot={null}
      presenceStale={false}
      presenceWorkspaceId={null}
      activeWorkspaceId="workspace-one"
      onSelectWorkspace={() => undefined}
      onRenameWorkspace={() => undefined}
      onOpenWorkspaceSettings={() => undefined}
      onInviteToWorkspace={() => undefined}
      onCreateWorkspace={() => undefined}
      onSwitchOrg={() => undefined}
      onCreateOrg={() => undefined}
      onOpenDrive={() => undefined}
      onOpenSettings={() => undefined}
      onOpenPresenceActivity={() => undefined}
      onCloseDrawer={() => undefined}
      {...overrides}
    />
  );
}

describe("workspaceCode", () => {
  it("reads initials from a multi-word name and two letters from a single word", () => {
    expect(workspaceCode("design-team")).toBe("DT");
    expect(workspaceCode("engineering")).toBe("EN");
    expect(workspaceCode("research sandbox")).toBe("RS");
    expect(workspaceCode("a b c d")).toBe("ABC");
    expect(workspaceCode("  ")).toBe("··");
  });
});

describe("workspace strip", () => {
  it("draws one tile per workspace, ringing the active one", async () => {
    const view = await render(strip({
      workspaces: [
        workspace(),
        workspace({ id: "workspace-two", title: "engineering", lifecycleStatus: "parked" }),
      ],
    }));
    const tiles = [...view.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Workspaces"] button',
    )];
    expect(tiles.map(({ textContent }) => textContent)).toEqual(["DT", "EN", ""]);
    expect(tiles[0]?.getAttribute("aria-current")).toBe("page");
    expect(tiles[1]?.getAttribute("aria-current")).toBeNull();
    expect(tiles[1]?.className).toContain("shell-wtile--off");
    expect(tiles[2]?.getAttribute("aria-label")).toBe("Create workspace");
    // Each workspace tile wears its own solid pastel; the create tile keeps the
    // dashed outline the stylesheet gives it.
    // jsdom normalizes hsl() to rgb() on read-back; assert solid + distinct.
    expect(tiles[0]?.style.background).toMatch(/^rgb\(/u);
    expect(tiles[1]?.style.background).toMatch(/^rgb\(/u);
    expect(tiles[0]?.style.background).not.toContain("gradient");
    expect(tiles[0]?.style.background).not.toBe(tiles[1]?.style.background);
    expect(tiles[0]?.style.background).not.toBe(tiles[1]?.style.background);
    expect(tiles[2]?.style.background).toBe("");
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

  it("offers Drive alone where the panel toggles used to be", async () => {
    const onOpenDrive = vi.fn();
    const view = await render(strip({ onOpenDrive }));
    const surfaces = [...view.container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Drive"] button',
    )];
    expect(surfaces.map((button) => button.getAttribute("aria-label"))).toEqual(["Drive"]);
    await act(async () => surfaces[0]?.click());
    expect(onOpenDrive).toHaveBeenCalledOnce();
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

  it("marks only the current organization and closes from a click anywhere outside", async () => {
    const view = await render(strip());
    const menu = () => view.container.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Organizations"]',
    );
    expect(menu()?.hidden).toBe(true);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Organization: Acme"]',
    )?.click());
    expect(menu()?.hidden).toBe(false);
    const checked = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map(({ textContent }) => textContent);
    expect(checked).toEqual(["Acme✓"]);
    const other = menu()!.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="false"]');
    expect(other?.textContent).toBe("Side");

    const backdrop = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close organization menu"]',
    );
    expect(backdrop).not.toBeNull();
    await act(async () => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(menu()?.hidden).toBe(true);
    expect(view.container.querySelector('button[aria-label="Close organization menu"]')).toBeNull();
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
