import { act } from "react";
import type { WebDAVClient } from "webdav";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILES_POLL_INTERVAL_MS,
  FilesSidebar,
  ROOT_RETRY_INTERVAL_MS,
  ROOT_RETRY_WINDOW_MS,
} from "../src/FilesSidebar.js";
import { render } from "./dom.js";

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

function webDavClient(getDirectoryContents: ReturnType<typeof vi.fn>): WebDAVClient {
  return { getDirectoryContents } as unknown as WebDAVClient;
}

function sidebar(
  client: WebDAVClient | null,
  getClient: () => WebDAVClient | null,
  visible = true,
  onUnauthorized = () => undefined,
) {
  return (
    <FilesSidebar
      client={client}
      expanded={[]}
      getClient={getClient}
      mobile={false}
      open
      ready
      refreshVersion={0}
      visible={visible}
      width={280}
      sharedFolders={[]}
      canShare
      onClose={() => undefined}
      onExpandedChange={() => undefined}
      onOpenFile={() => undefined}
      dirtyFilePaths={[]}
      onPathMoved={() => undefined}
      onPathDeleted={() => undefined}
      onOpenDriveFolder={() => undefined}
      onShareToDrive={() => undefined}
      onUnauthorized={onUnauthorized}
      onWidthChange={() => undefined}
    />
  );
}

function badGateway(): Error & { status: number } {
  return Object.assign(new Error("Bad Gateway"), { status: 502 });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FilesSidebar root listing retries", () => {
  it("automatically recovers when transient root listings fail before succeeding", async () => {
    const getDirectoryContents = vi.fn()
      .mockRejectedValueOnce(badGateway())
      .mockRejectedValueOnce(badGateway())
      .mockResolvedValue([]);
    const client = webDavClient(getDirectoryContents);
    const view = await render(sidebar(client, () => client));
    await flushPromises();

    expect(getDirectoryContents).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[aria-label="Loading workspace files"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("couldn't list");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOT_RETRY_INTERVAL_MS * 2);
    });

    expect(getDirectoryContents).toHaveBeenCalledTimes(4);
    expect(view.container.textContent).toContain("(empty)");
    expect(view.container.textContent).not.toContain("couldn't list");

    await view.unmount();
  });

  it("manual root retry reacquires a client when the client prop is null", async () => {
    const failingListing = vi.fn().mockRejectedValue(badGateway());
    const recoveredListing = vi.fn().mockResolvedValue([]);
    let currentClient = webDavClient(failingListing);
    const getClient = vi.fn(() => currentClient);
    const view = await render(sidebar(null, getClient));
    await flushPromises();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOT_RETRY_WINDOW_MS);
    });

    expect(view.container.textContent).toContain("couldn't list");
    currentClient = webDavClient(recoveredListing);
    const retry = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent === "retry");
    expect(retry).toBeDefined();

    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });

    expect(getClient).toHaveBeenCalled();
    expect(recoveredListing).toHaveBeenCalledWith("/");
    expect(view.container.textContent).toContain("(empty)");

    await view.unmount();
  });

  it("keeps retrying while the client is unavailable and reacquires it", async () => {
    const recoveredListing = vi.fn().mockResolvedValue([]);
    let currentClient: WebDAVClient | null = null;
    const getClient = vi.fn(() => currentClient);
    const view = await render(sidebar(null, getClient));
    await flushPromises();

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[aria-label="Loading workspace files"]')).not.toBeNull();

    currentClient = webDavClient(recoveredListing);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOT_RETRY_INTERVAL_MS);
    });

    expect(getClient).toHaveBeenCalledTimes(2);
    expect(recoveredListing).toHaveBeenCalledWith("/");
    expect(view.container.textContent).toContain("(empty)");

    await view.unmount();
  });

  it("stops root retries when the sidebar becomes hidden", async () => {
    const getDirectoryContents = vi.fn().mockRejectedValue(badGateway());
    const client = webDavClient(getDirectoryContents);
    const getClient = () => client;
    const view = await render(sidebar(client, getClient));
    await flushPromises();
    expect(getDirectoryContents).toHaveBeenCalledTimes(1);

    await act(async () => view.root.render(sidebar(client, getClient, false)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ROOT_RETRY_WINDOW_MS);
    });

    expect(getDirectoryContents).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("ignores an in-flight root failure after the sidebar becomes hidden", async () => {
    let rejectListing: (reason: unknown) => void = () => undefined;
    const getDirectoryContents = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectListing = reject;
    }));
    const client = webDavClient(getDirectoryContents);
    const getClient = () => client;
    const onUnauthorized = vi.fn();
    const view = await render(sidebar(client, getClient, true, onUnauthorized));
    await flushPromises();

    await act(async () => view.root.render(sidebar(client, getClient, false, onUnauthorized)));
    await act(async () => {
      rejectListing(Object.assign(new Error("Unauthorized"), { status: 401 }));
      await Promise.resolve();
    });

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(getDirectoryContents).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  it("offers Drive actions in the row context menu", async () => {
    const listings = new Map<string, unknown[]>([
      ["/", [
        { basename: "shared", filename: "/shared", type: "directory" },
        { basename: "src", filename: "/src", type: "directory" },
      ]],
      ["shared", [
        { basename: "obsidian-vault", filename: "/shared/obsidian-vault", type: "directory" },
      ]],
    ]);
    const getDirectoryContents = vi.fn((path: string) => Promise.resolve(listings.get(path) ?? []));
    const client = webDavClient(getDirectoryContents as ReturnType<typeof vi.fn>);
    const onOpenDriveFolder = vi.fn();
    const onShareToDrive = vi.fn();
    const view = await render(
      <FilesSidebar
        client={client}
        expanded={[]}
        getClient={() => client}
        mobile={false}
        open
        ready
        refreshVersion={0}
        visible
        width={340}
        sharedFolders={[{
          id: "folder-1",
          name: "obsidian-vault",
          role: "editor",
          guestPath: "shared/obsidian-vault",
          attachedAt: 0,
        }]}
        canShare
        onClose={() => undefined}
        onExpandedChange={() => undefined}
        onOpenFile={() => undefined}
        dirtyFilePaths={[]}
        onPathMoved={() => undefined}
        onPathDeleted={() => undefined}
        onOpenDriveFolder={onOpenDriveFolder}
        onShareToDrive={onShareToDrive}
        onUnauthorized={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    await flushPromises();

    const rowFor = (name: string) => [...view.container.querySelectorAll(".files-tree-row")]
      .find((row) => row.textContent?.includes(name));
    const menuItems = () => [...document.body.querySelectorAll('[role="menuitem"]')]
      .map((item) => item.textContent ?? "");

    await act(async () => {
      rowFor("src")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(menuItems().some((item) => item.includes("Share to Drive"))).toBe(true);
    expect(menuItems().some((item) => item.includes("Open in Drive"))).toBe(false);
    expect(menuItems().some((item) => item.includes("Rename"))).toBe(true);
    expect(menuItems().some((item) => item.includes("Delete"))).toBe(true);
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Share to Drive"))?.click();
    });
    expect(onShareToDrive).toHaveBeenCalledWith("src");

    const sharedChevron = rowFor("shared")
      ?.querySelector<HTMLButtonElement>('[aria-label="Expand shared"]');
    await act(async () => {
      sharedChevron?.click();
      await Promise.resolve();
    });
    await flushPromises();
    await act(async () => {
      rowFor("obsidian-vault")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(menuItems().some((item) => item.includes("Open in Drive"))).toBe(true);
    expect(menuItems().some((item) => item.includes("Share to Drive"))).toBe(false);
    expect(menuItems().some((item) => item.includes("Rename"))).toBe(true);
    expect(menuItems().some((item) => item.includes("Delete"))).toBe(true);
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent?.includes("Open in Drive"))?.click();
    });
    expect(onOpenDriveFolder).toHaveBeenCalledWith("folder-1");

    await view.unmount();
  });

  it("renames a file in place and reports the path move", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([
      { basename: "notes.txt", filename: "/notes.txt", type: "file" },
    ]);
    const moveFile = vi.fn().mockResolvedValue(undefined);
    const client = { getDirectoryContents, moveFile } as unknown as WebDAVClient;
    const onPathMoved = vi.fn();
    const view = await render(
      <FilesSidebar
        client={client}
        expanded={[]}
        getClient={() => client}
        mobile={false}
        open
        ready
        refreshVersion={0}
        visible
        width={340}
        sharedFolders={[]}
        canShare
        onClose={() => undefined}
        onExpandedChange={() => undefined}
        onOpenFile={() => undefined}
        dirtyFilePaths={[]}
        onPathMoved={onPathMoved}
        onPathDeleted={() => undefined}
        onOpenDriveFolder={() => undefined}
        onShareToDrive={() => undefined}
        onUnauthorized={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    await flushPromises();

    const row = [...view.container.querySelectorAll(".files-tree-row")]
      .find((entry) => entry.textContent?.includes("notes.txt"));
    await act(async () => row?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 }),
    ));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    )].find((item) => item.textContent?.includes("Rename"))?.click());

    const input = document.body.querySelector<HTMLInputElement>('[aria-label="New name"]')!;
    expect(input.value).toBe("notes.txt");
    await act(async () => {
      changeInput(input, "journal.txt");
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flushPromises();

    expect(moveFile).toHaveBeenCalledWith("notes.txt", "journal.txt", { overwrite: false });
    expect(onPathMoved).toHaveBeenCalledWith("notes.txt", "journal.txt");
    expect(getDirectoryContents).toHaveBeenLastCalledWith("/");
    await view.unmount();
  });

  it("requires confirmation before renaming a path with dirty open files", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([
      { basename: "notes.txt", filename: "/notes.txt", type: "file" },
    ]);
    const moveFile = vi.fn().mockResolvedValue(undefined);
    const client = { getDirectoryContents, moveFile } as unknown as WebDAVClient;
    const view = await render(
      <FilesSidebar
        client={client}
        expanded={[]}
        getClient={() => client}
        mobile={false}
        open
        ready
        refreshVersion={0}
        visible
        width={340}
        sharedFolders={[]}
        canShare
        onClose={() => undefined}
        onExpandedChange={() => undefined}
        onOpenFile={() => undefined}
        dirtyFilePaths={["notes.txt"]}
        onPathMoved={() => undefined}
        onPathDeleted={() => undefined}
        onOpenDriveFolder={() => undefined}
        onShareToDrive={() => undefined}
        onUnauthorized={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    await flushPromises();

    const row = [...view.container.querySelectorAll(".files-tree-row")]
      .find((entry) => entry.textContent?.includes("notes.txt"));
    await act(async () => row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    )].find((item) => item.textContent?.includes("Rename"))?.click());

    expect(document.body.querySelector('[role="dialog"]')?.textContent)
      .toContain("unsaved changes");
    expect(document.body.querySelector('[aria-label="New name"]')).toBeNull();
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Rename")?.click());
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="New name"]')?.value)
      .toBe("notes.txt");
    expect(moveFile).not.toHaveBeenCalled();

    await view.unmount();
  });

  it("deletes a folder after warning about dirty descendants and reconciles paths", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([
      { basename: "src", filename: "/src", type: "directory" },
    ]);
    const deleteFile = vi.fn().mockResolvedValue(undefined);
    const client = { getDirectoryContents, deleteFile } as unknown as WebDAVClient;
    const onExpandedChange = vi.fn();
    const onPathDeleted = vi.fn();
    const view = await render(
      <FilesSidebar
        client={client}
        expanded={["src", "src/components"]}
        getClient={() => client}
        mobile={false}
        open
        ready
        refreshVersion={0}
        visible
        width={340}
        sharedFolders={[]}
        canShare
        onClose={() => undefined}
        onExpandedChange={onExpandedChange}
        onOpenFile={() => undefined}
        dirtyFilePaths={["src/components/App.tsx"]}
        onPathMoved={() => undefined}
        onPathDeleted={onPathDeleted}
        onOpenDriveFolder={() => undefined}
        onShareToDrive={() => undefined}
        onUnauthorized={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    await flushPromises();

    const row = [...view.container.querySelectorAll<HTMLElement>(".files-tree-row")]
      .find((entry) => entry.textContent?.includes("src"));
    await act(async () => row?.click());
    expect(view.container.querySelector('[aria-label="Selected path"]')?.textContent)
      .toContain("src");
    const selectedRow = [...view.container.querySelectorAll<HTMLElement>(".files-tree-row")]
      .find((entry) => entry.title === "~/src");
    await act(async () => selectedRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    )].find((item) => item.textContent?.includes("Delete"))?.click());

    expect(document.body.querySelector('[role="dialog"]')?.textContent)
      .toContain("discard unsaved changes in 1 open file");
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Delete")?.click());
    await flushPromises();

    expect(deleteFile).toHaveBeenCalledWith("src");
    expect(onPathDeleted).toHaveBeenCalledWith("src");
    expect(onExpandedChange).toHaveBeenCalledWith([]);
    expect(view.container.querySelector('[aria-label="Selected path"]')?.textContent)
      .not.toContain("src");
    expect(getDirectoryContents).toHaveBeenLastCalledWith("/");
    await view.unmount();
  });

  it("keeps delete confirmation open with a recoverable permission error", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([
      { basename: "notes.txt", filename: "/notes.txt", type: "file" },
    ]);
    const deleteFile = vi.fn().mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    const client = { getDirectoryContents, deleteFile } as unknown as WebDAVClient;
    const view = await render(
      <FilesSidebar
        client={client}
        expanded={[]}
        getClient={() => client}
        mobile={false}
        open
        ready
        refreshVersion={0}
        visible
        width={340}
        sharedFolders={[]}
        canShare
        onClose={() => undefined}
        onExpandedChange={() => undefined}
        onOpenFile={() => undefined}
        dirtyFilePaths={[]}
        onPathMoved={() => undefined}
        onPathDeleted={() => undefined}
        onOpenDriveFolder={() => undefined}
        onShareToDrive={() => undefined}
        onUnauthorized={() => undefined}
        onWidthChange={() => undefined}
      />,
    );
    await flushPromises();

    const row = [...view.container.querySelectorAll(".files-tree-row")]
      .find((entry) => entry.textContent?.includes("notes.txt"));
    await act(async () => row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]',
    )].find((item) => item.textContent?.includes("Delete"))?.click());
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Delete")?.click());
    await flushPromises();

    expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toBe("You don’t have permission to delete this item.");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await view.unmount();
  });

  it("closes the context menu from a click anywhere outside it", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([
      { basename: "notes.txt", filename: "/notes.txt", type: "file" },
    ]);
    const client = { getDirectoryContents } as unknown as WebDAVClient;
    const view = await render(sidebar(client, () => client));
    await flushPromises();

    const row = [...view.container.querySelectorAll(".files-tree-row")]
      .find((entry) => entry.textContent?.includes("notes.txt"));
    await act(async () => row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(document.body.querySelector(".files-context-menu")).not.toBeNull();

    const backdrop = document.body.querySelector<HTMLElement>(".files-context-backdrop");
    expect(backdrop).not.toBeNull();
    await act(async () => backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.body.querySelector(".files-context-menu")).toBeNull();
    expect(document.body.querySelector(".files-context-backdrop")).toBeNull();
    await view.unmount();
  });

  it("shows files created outside the sidebar on the next poll", async () => {
    const getDirectoryContents = vi.fn().mockResolvedValue([]);
    const client = webDavClient(getDirectoryContents);
    const view = await render(sidebar(client, () => client));
    await flushPromises();
    expect(view.container.textContent).toContain("(empty)");

    getDirectoryContents.mockResolvedValue([
      { basename: "note.txt", filename: "/note.txt", type: "file" },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FILES_POLL_INTERVAL_MS);
    });

    expect(view.container.textContent).toContain("note.txt");

    await view.unmount();
  });
});
