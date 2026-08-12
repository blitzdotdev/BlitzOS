import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileEditor } from "../src/files/FileEditor.js";
import { WebDavClient } from "../src/files/webdav.js";
import { render, settle } from "./dom.js";

describe("file save honesty", () => {
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
