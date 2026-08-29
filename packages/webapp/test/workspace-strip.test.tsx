import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceStrip, workspaceCode } from "../src/shell/WorkspaceStrip.js";
import type { TenantMe } from "../src/api-adapter.js";
import type { CloudWorkspaceModel } from "../src/workspace-store.js";
import type { WorkspaceDrawerSegment } from "../src/storage.js";
import { render } from "./dom.js";

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
  return {
    id: "workspace-one",
    ownerMembershipId: "member-owner",
    canControl: true,
    shared: false,
    owner: { name: "Ada Owner", avatarUrl: null },
    accessRole: "owner",
    orgShareRole: null,
    serverName: "design-team",
    title: "design-team",
    machineType: "cx23@fsn1",
    volumeId: null,
    lifecycleStatus: "running",
    errorDetail: null,
    retryAction: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    connections: [],
    agentDefault: "claude",
    ...overrides,
  };
}

function strip(overrides: Partial<Parameters<typeof WorkspaceStrip>[0]> = {}) {
  return (
    <WorkspaceStrip
      workspaces={[workspace()]}
      viewer={viewer}
      activeWorkspaceId="workspace-one"
      openPanels={new Set<WorkspaceDrawerSegment>()}
      pendingRequestCount={0}
      surfacesEnabled
      onSelectWorkspace={() => undefined}
      onCreateWorkspace={() => undefined}
      onOpenPanel={() => undefined}
      onSwitchOrg={() => undefined}
      onCreateOrg={() => undefined}
      onOpenDrive={() => undefined}
      onOpenSettings={() => undefined}
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

  it("focuses a workspace surface without closing it again", async () => {
    const onOpenPanel = vi.fn();
    const view = await render(strip({
      onOpenPanel,
      openPanels: new Set<WorkspaceDrawerSegment>(["files"]),
      pendingRequestCount: 2,
    }));
    const surfaces = [...view.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Workspace surfaces"] button',
    )];
    expect(surfaces.map((button) => button.getAttribute("aria-label")))
      .toEqual(["Files", "teenyapps", "Connections"]);
    expect(surfaces[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(surfaces[2]?.textContent).toBe("2");
    await act(async () => surfaces[1]?.click());
    expect(onOpenPanel).toHaveBeenCalledWith("previews");
    await view.unmount();
  });

  it("disables the surfaces when no workspace is open", async () => {
    const view = await render(strip({ surfacesEnabled: false }));
    const surfaces = [...view.container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Workspace surfaces"] button',
    )];
    expect(surfaces.every((button) => button.disabled)).toBe(true);
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

  it("reaches Drive and settings from the account menu", async () => {
    const onOpenDrive = vi.fn();
    const onOpenSettings = vi.fn();
    const view = await render(strip({ onOpenDrive, onOpenSettings }));
    const menu = () => view.container.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Account"]',
    );
    expect(menu()?.hidden).toBe(true);
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Account: Person"]',
    )?.click());
    expect(menu()?.hidden).toBe(false);

    const items = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map(({ textContent }) => textContent))
      .toEqual(["Drive", "Settings", "Ask us on Discord"]);
    await act(async () => items[0]?.click());
    expect(onOpenDrive).toHaveBeenCalledOnce();

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Account: Person"]',
    )?.click());
    await act(async () => menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')[1]?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
