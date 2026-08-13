import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileEditor } from "../src/files/FileEditor.js";
import { FilesPanel } from "../src/files/FilesPanel.js";
import { WebDavClient } from "../src/files/webdav.js";
import { render, settle } from "./dom.js";

describe("file save honesty", () => {
  it("invokes a stored fetcher without binding the WebDavClient as this", async () => {
    const fetcher = vi.fn(async function (this: unknown) {
      if (this !== undefined) throw new TypeError("fetcher was rebound");
      return new Response("contents", { status: 200 });
    });
    const client = new WebDavClient("http://localhost:7445/workspace/", fetcher);

    await expect(client.read("/notes.txt")).resolves.toBe("contents");
  });

  it('shows "Save failed" when the plain PUT returns 500', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("failure", { status: 500 });
      return new Response("original", { status: 200 });
    });
    const client = new WebDavClient("http://localhost:7445/workspace/", fetcher);
    const view = await render(<FileEditor client={client} path="/notes.txt" onClose={() => undefined} />);
    await settle();

    const textarea = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="File contents"]');
    expect(textarea).not.toBeNull();
    await act(async () => {
      textarea!.value = "changed";
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...view.container.querySelectorAll("button")].find(({ textContent }) => textContent === "Save");
    await act(async () => save?.click());
    await settle();

    const status = view.container.querySelector(".editor-footer span:nth-child(2)");
    expect(status?.textContent).toBe("Save failed");
    const put = fetcher.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(put?.[1]?.headers).toBeUndefined();
    await view.unmount();
  });
});

describe("cross-origin file browser", () => {
  it("loads dufs from its own origin when browser fetch cannot pass CORS", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("blocked by CORS"));
    const view = await render(<FilesPanel baseUrl="http://files.invalid/workspace/" />);
    await settle();

    expect(view.container.querySelector<HTMLIFrameElement>('iframe[title="Files"]')?.src)
      .toBe("http://files.invalid/workspace/");
    expect(fetcher).not.toHaveBeenCalled();

    await view.unmount();
    fetcher.mockRestore();
  });
});
