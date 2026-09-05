/**
 * THE LOCAL-PLATFORM SNAPSHOT MUST FORGET THE PREVIOUS BOX.
 *
 * The field report, distilled: switch workspaces and the sessions rail is empty
 * until a full page reload. The rail is fed by a runtime whose workspace id, on
 * the local platform, comes from `useImplicitLocalWorkspace()` — a MODULE-LEVEL
 * singleton in `vendor/lody/.../local-platform-provider.ts` that polls
 * `localPlatform.getSnapshot` exactly once per page and then never reads again
 * (Electron has one daemon per renderer; a browser talking to many boxes does
 * not). So the second box visited in one page gets a runtime pinned to the
 * FIRST box's `lw_<uuid>`, opens that box's replica and subscribes to its rooms
 * while the data plane dials a different daemon. Nothing syncs; no error is
 * raised; a reload — the only thing that reset the singleton — is the cure.
 *
 * BLITZ SEAM PATCH 17 added `resetLocalPlatformSnapshotState()` for sequential
 * hand-off. Seam 18 supersedes that host behavior with client-keyed state so
 * retained surfaces never reset one another, but keeps the scoped reset as a
 * compatibility/test cleanup. This regression pins that retained API directly.
 */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, settle } from "./dom.js";
import {
  resetLocalPlatformSnapshotState,
  useImplicitLocalWorkspace,
} from "@lody/components/providers/local-platform-provider";

interface BoxSnapshot {
  userId: string;
  workspace: { workspaceId: string; name: string; slug: string; role: string };
}

function snapshotFor(tag: string): BoxSnapshot {
  return {
    userId: `local:${tag}`,
    workspace: { workspaceId: `lw_${tag}`, name: tag, slug: tag, role: "owner" },
  };
}

/** The box `window.ipc` answers for. Flipped between mounts, the way a real
 * workspace switch swaps our per-box bridge under the same global. */
let currentBox = "A";

function installFakeBridge(): void {
  window.ipc = {
    invoke: async (channel: string) =>
      channel === "localPlatform.getSnapshot" ? snapshotFor(currentBox) : undefined,
    on: () => () => {},
    send: () => {},
  } as unknown as Window["ipc"];
}

/** Renders the vendored hook and reports the workspace id it resolves. */
function ProbeHarness({ onId }: { onId: (id: string | null) => void }) {
  const workspace = useImplicitLocalWorkspace();
  onId(workspace?.id ?? null);
  return null;
}

afterEach(() => {
  resetLocalPlatformSnapshotState();
  delete (window as { ipc?: unknown }).ipc;
  vi.restoreAllMocks();
});

describe("local-platform snapshot across a box switch", () => {
  it("re-reads the current box's identity only after a reset", async () => {
    installFakeBridge();

    let observed: string | null = null;
    const onId = (id: string | null): void => {
      observed = id;
    };

    // BOX A. The first mount polls, settles on A, and stops polling for good —
    // exactly upstream's design.
    currentBox = "A";
    const boxA = await render(<ProbeHarness onId={onId} />);
    await settle();
    expect(observed).toBe("lw_A");
    await boxA.unmount();

    // BOX B, WITHOUT A RESET. A fresh surface mounts against box B's bridge, but
    // the singleton has already settled: the hook hands back box A's id. This is
    // the bug — the runtime would open box A's replica while dialling box B.
    currentBox = "B";
    const staleMount = await render(<ProbeHarness onId={onId} />);
    await settle();
    expect(observed).toBe("lw_A");
    await staleMount.unmount();

    // THE COMPATIBILITY RESET. Sequential/default-client hosts can still forget
    // the previous snapshot explicitly; retained surfaces use distinct clients.
    await act(async () => {
      resetLocalPlatformSnapshotState();
    });
    const freshMount = await render(<ProbeHarness onId={onId} />);
    await settle();
    expect(observed).toBe("lw_B");
    await freshMount.unmount();
  });
});
