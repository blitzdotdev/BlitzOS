import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORTS_POLL_INTERVAL_MS, type PreviewFocus } from "../src/preview.js";
import { useWorkspacePreviewSources } from "../src/use-workspace-preview-sources.js";
import { render } from "./dom.js";

const FILES_BASE = "https://box.example/workspace/";

function marker(requestedAt: number, path = "/dashboard"): PreviewFocus {
  return { version: 1, port: 3000, path, title: "Docs", requestedAt };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function focusResponse(focus: PreviewFocus | null): Response {
  return jsonResponse({ focus });
}

/** Routes the poller's three sibling fetches: ports and previews always
 * answer empty, the `/preview-focus` read is the scenario under test. */
function stubGatewayFetch(focusImpl: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/preview-focus")) return focusImpl();
    if (url.endsWith("/ports")) return jsonResponse({ ports: [] });
    return jsonResponse({ previews: [] });
  }));
}

function Poller({ onFocus }: { onFocus: (focus: PreviewFocus) => void }) {
  useWorkspacePreviewSources(true, "workspace-1", FILES_BASE, onFocus);
  return null;
}

/** Each poll is one gateway round; this drives the interval the hook installs
 * and lets the in-flight promises settle before the next tick. */
async function poll(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PORTS_POLL_INTERVAL_MS);
    });
  }
}

describe("useWorkspacePreviewSources focus consumption", () => {
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
    let focusReads = 0;
    let current: () => Promise<Response> = async () => {
      focusReads += 1;
      if (focusReads === 1) throw new Error("offline");
      return focusResponse(stale);
    };
    stubGatewayFetch(() => current());
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    // The mount poll fails; the stale marker then arrives on the next tick and
    // must be adopted as the baseline rather than opened.
    await poll(2);

    expect(focusReads).toBeGreaterThanOrEqual(2);
    expect(onFocus).not.toHaveBeenCalled();

    // A strictly newer focus, raised while the workspace is on screen, still
    // opens: the baseline suppressed the replay, not the feature.
    const fresh = marker(1_787_000_005_000, "/reports");
    current = async () => focusResponse(fresh);
    await poll();

    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(fresh);
    await unmount();
  });

  it("treats an old box's 404 as a failed read, not as an absent focus", async () => {
    const stale = marker(1_787_000_000_000);
    let focusReads = 0;
    stubGatewayFetch(async () => {
      focusReads += 1;
      return focusReads === 1
        ? new Response("not found", { status: 404 })
        : focusResponse(stale);
    });
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    await poll(2);

    expect(onFocus).not.toHaveBeenCalled();
    await unmount();
  });

  it("adopts an absent focus as the baseline and opens the next one", async () => {
    let current: () => Promise<Response> = async () => focusResponse(null);
    stubGatewayFetch(() => current());
    const onFocus = vi.fn();

    const { unmount } = await render(<Poller onFocus={onFocus} />);
    await poll();
    expect(onFocus).not.toHaveBeenCalled();

    const focus = marker(1_787_000_001_000);
    current = async () => focusResponse(focus);
    await poll();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith(focus);

    // The same marker on later polls never opens twice.
    await poll(2);
    expect(onFocus).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
