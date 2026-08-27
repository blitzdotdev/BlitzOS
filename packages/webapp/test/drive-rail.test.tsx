import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { DriveRail } from "../src/files/DriveRail.js";
import { render } from "./dom.js";

const acme = { id: "org-one", slug: "acme", name: "Acme", vmLimit: 10 };
const side = { id: "org-two", slug: "side", name: "Side", vmLimit: 10 };

function rail(onSwitchOrg: (orgId: string) => void = () => undefined) {
  return (
    <DriveRail
      workspaces={[]}
      activeWorkspaceId=""
      nav="drive"
      identity={null}
      org={acme}
      organizations={[acme, side]}
      sessions={[]}
      activeSessionId=""
      onSelectSession={() => undefined}
      onOpenDrive={() => undefined}
      onOpenTemplates={() => undefined}
      onOpenRecipes={() => undefined}
      onSelectWorkspace={() => undefined}
      onCreateWorkspace={() => undefined}
      onSwitchOrg={onSwitchOrg}
      onCreateOrg={() => undefined}
      onOpenSettings={() => undefined}
      onOpenWorkspaceShare={() => undefined}
      onOpenWorkspaceDetails={() => undefined}
      drawerOpen={false}
      onCloseDrawer={() => undefined}
    />
  );
}

describe("rail organization menu", () => {
  it("marks only the current organization and closes from a click anywhere outside", async () => {
    const view = await render(rail());
    const menu = () => view.container.querySelector<HTMLElement>("#webapp-org-menu");
    expect(menu()?.hidden).toBe(true);

    await act(async () => view.container.querySelector<HTMLButtonElement>(".webapp-org-button")?.click());
    expect(menu()?.hidden).toBe(false);
    const current = menu()?.querySelector('[role="menuitemradio"][aria-checked="true"]');
    expect(current?.querySelector(".webapp-org-menu-check")).not.toBeNull();
    const other = menu()?.querySelector<HTMLElement>(".webapp-org-menu-switch");
    expect(other?.textContent).toBe("Side");
    expect(other?.querySelector(".webapp-org-menu-check")).toBeNull();

    const backdrop = view.container.querySelector<HTMLElement>(".webapp-org-backdrop");
    expect(backdrop).not.toBeNull();
    await act(async () => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(menu()?.hidden).toBe(true);
    expect(view.container.querySelector(".webapp-org-backdrop")).toBeNull();
    await view.unmount();
  });
});
