import { act } from "react";
import { describe, expect, it } from "vitest";
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
});
