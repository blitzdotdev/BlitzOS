import { act } from "react";
import type { WebDAVClient } from "webdav";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
      onClose={() => undefined}
      onExpandedChange={() => undefined}
      onOpenFile={() => undefined}
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

    expect(getDirectoryContents).toHaveBeenCalledTimes(3);
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
});
