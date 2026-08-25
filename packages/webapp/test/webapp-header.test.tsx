import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { WebAppHeader } from "../src/WebAppHeader.js";
import { render } from "./dom.js";

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("workspace session header actions", () => {
  it("opens an inactive tab context menu without selecting the tab", async () => {
    const onSelect = vi.fn();
    const view = await render(<WebAppHeader
      tabs={[
        { id: "one", label: "Chat", agent: "chat", pending: false, renameable: true },
        { id: "two", label: "Terminal", agent: "terminal", pending: false, renameable: true },
      ]}
      activeSessionId="one"
      sessionBusy={false}
      terminalDisabled={false}
      onSelect={onSelect}
      onClose={() => undefined}
      onRename={() => undefined}
      onSpawn={() => undefined}
    />);

    await act(async () => view.container.querySelector("[data-session-id='two']")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    ));

    expect(view.container.querySelector(".webapp-session-menu")).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("renames, archives, and permanently removes a managed session from its context menu", async () => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    const view = await render(<WebAppHeader
      tabs={[{
        id: "one",
        label: "Chat",
        agent: "chat",
        pending: false,
        renameable: true,
      }]}
      activeSessionId="one"
      sessionBusy={false}
      terminalDisabled={false}
      onSelect={() => undefined}
      onClose={() => undefined}
      onRename={onRename}
      onArchive={onArchive}
      onDelete={onDelete}
      onSpawn={() => undefined}
    />);

    await act(async () => view.container.querySelector("[data-session-id='one']")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    ));
    const actions = [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )];
    expect(actions.map(({ textContent }) => textContent)).toEqual([
      "Rename",
      "Archive",
      "Remove permanently",
    ]);

    await act(async () => actions[0]?.click());
    const input = view.container.querySelector<HTMLInputElement>(".webapp-tab-rename")!;
    expect(input.maxLength).toBe(64);
    await act(async () => {
      changeInput(input, "  Release work  ");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledWith("one", "Release work");

    await act(async () => view.container.querySelector("[data-session-id='one']")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true }),
    ));
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )][1]?.click());
    expect(onArchive).toHaveBeenCalledWith("one");

    await act(async () => view.container.querySelector("[data-session-id='one']")?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true }),
    ));
    await act(async () => [...view.container.querySelectorAll<HTMLButtonElement>(
      ".webapp-session-menu [role='menuitem']",
    )][2]?.click());
    expect(onDelete).toHaveBeenCalledWith("one");
    await view.unmount();
  });

  it("restores and permanently removes archived sessions from a bounded menu", async () => {
    const onRestore = vi.fn();
    const onDelete = vi.fn();
    const view = await render(<WebAppHeader
      tabs={[]}
      archivedTabs={[{
        id: "archived",
        label: "A long archived session name that remains inside the menu",
        agent: "claude",
        pending: false,
      }]}
      activeSessionId=""
      sessionBusy={false}
      terminalDisabled={false}
      onSelect={() => undefined}
      onClose={() => undefined}
      onDelete={onDelete}
      onRestore={onRestore}
      onSpawn={() => undefined}
    />);

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      "[aria-label='Archived sessions']",
    )?.click());
    expect(view.container.querySelector<HTMLElement>(".webapp-archive-menu")?.hidden).toBe(false);
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-archive-restore",
    )?.click());
    expect(onRestore).toHaveBeenCalledWith("archived");

    await act(async () => view.container.querySelector<HTMLButtonElement>(
      "[aria-label='Archived sessions']",
    )?.click());
    await act(async () => view.container.querySelector<HTMLButtonElement>(
      ".webapp-archive-delete",
    )?.click());
    expect(onDelete).toHaveBeenCalledWith("archived");
    await view.unmount();
  });
});
