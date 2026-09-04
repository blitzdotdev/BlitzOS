import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTS_POLL_INTERVAL_MS, type PreviewFocus } from "../src/preview.js";
import { useWorkspacePreviewFocus } from "../src/use-workspace-preview-focus.js";
import { render } from "./dom.js";

const FILES_BASE = "https://box.example/workspace/";

/** The focus as the hook hands it on: the browser's own reading of the marker. */
function marker(requestedAt: number, path = "/dashboard"): PreviewFocus {
  return { kind: "port", port: 3000, path, title: "Docs", requestedAt };
}

/** The same focus as the gateway serves it: a version-2 marker. */
function focusResponse(focus: PreviewFocus | null): Response {
  return new Response(JSON.stringify({ focus: focus === null ? null : { version: 2, ...focus } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function Poller({ onFocus }: { onFocus: (focus: PreviewFocus) => void }) {
  useWorkspacePreviewFocus(true, "workspace-1", FILES_BASE, onFocus);
  return null;
}

/** Each poll is one `fetch`; this drives the interval the hook installs and
 * lets the in-flight promise settle before the next tick. */
async function poll(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PORTS_POLL_INTERVAL_MS);
    });
  }
}

describe("useWorkspacePreviewFocus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The hook promises each focus opens at most once, and that entering a
  // workspace never replays whatever the box already had. That baseline may
  // only be adopted from a poll that actually reached the box: a failed first
  // poll that reported "no focus" made the next successful poll look brand new
  // and re-opened a marker from a previous visit.
  it("does not adopt a baseline from a failed poll", async () => {
    const stale = marker(1_787_000_000_000);
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(focusResponse(stale));
    vi.stubGlobal("fetch", fetcher);
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    // The mount poll fails; the stale marker then arrives on the next tick and
    // must be adopted as the baseline rather than opened.
    await poll(2);

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onFocus).not.toHaveBeenCalled();

    // A strictly newer focus, raised while the workspace is on screen, still
    // opens: the baseline suppressed the replay, not the feature.
    const fresh = marker(1_787_000_005_000, "/reports");
    fetcher.mockResolvedValue(focusResponse(fresh));
    await poll();

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(fresh);
    await unmount();
  });

  it("treats an old box's 404 as a failed read, not as an absent focus", async () => {
    const stale = marker(1_787_000_000_000);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValue(focusResponse(stale));
    vi.stubGlobal("fetch", fetcher);
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    await poll(2);

    expect(onFocus).not.toHaveBeenCalled();
    await unmount();
  });

  it("adopts an absent focus as the baseline and opens the next one", async () => {
    const fetcher = vi.fn().mockResolvedValue(focusResponse(null));
    vi.stubGlobal("fetch", fetcher);
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    await poll();
    expect(onFocus).not.toHaveBeenCalled();

    const focus = marker(1_787_000_001_000);
    fetcher.mockResolvedValue(focusResponse(focus));
    await poll();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(focus);

    // The same marker on later polls never opens twice.
    await poll(2);
    expect(onFocus).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
