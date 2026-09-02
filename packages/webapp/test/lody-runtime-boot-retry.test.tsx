/**
 * THE THIRD LATCH OF THE FRESH-WORKSPACE BUG, and the only one that lives in
 * vendored code.
 *
 * `RuntimeProvider` creates the workspace runtime once. Its catch sets
 * `runtimeAtom` to null and the control-connection atom to `error`, and then
 * stops — its dependency list holds a slug, a workspace id and an Electron-only
 * flag, so against a box there is no input left that can change. On a freshly
 * provisioned workspace the gateway answers long before the ~300 MB session
 * daemon does, the one boot lands in that gap, and `LodyAgentConfigGate` then
 * renders "Starting sessions on this workspace…" for the lifetime of the tab —
 * while a terminal in the same rail opens instantly, because ttyd never needed
 * the daemon.
 *
 * `vendor/lody/BLITZ-PATCHES.md` forbids patching the provider, so the retry is
 * a remount driven from our side. What matters is that it fires for exactly the
 * failure that strands the surface and for nothing else.
 */
import { act } from "react";
import { createStore } from "jotai";
import { describe, expect, it, vi, afterEach } from "vitest";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { lodyControlConnectionStateAtom } from "@lody/components/atoms/control-connection";
import {
  runtimeBootRetryDelayMs,
  useLodyRuntimeBootRetry,
} from "../src/lody/use-runtime-boot-retry.js";
import {
  reportBoxGatewayProbe,
  resetBoxGatewayHealth,
} from "../src/box-gateway-health.js";
import { render } from "./dom.js";

const MACHINE_ID = "m-1";

/** The hook only asks whether a runtime EXISTS, so a marker object is the whole
 * fixture a live boot needs to be represented by. */
const LIVE_RUNTIME = { workspaceId: "lw_1" } as never;

function mount(store: ReturnType<typeof createStore>, machineId: string | null = MACHINE_ID) {
  const seen = { generation: 0 };
  function Host() {
    seen.generation = useLodyRuntimeBootRetry(store, machineId);
    return null;
  }
  return { seen, render: async () => await render(<Host />) };
}

/** The box is answering. Every rebuild below is gated on this, because a
 * rebuild against an address nothing replies to is churn, not recovery. */
function boxIsAnswering(): void {
  resetBoxGatewayHealth();
  reportBoxGatewayProbe("reached");
}

afterEach(() => {
  vi.useRealTimers();
  resetBoxGatewayHealth();
});

describe("the runtime boot retry", () => {
  it("does nothing while the boot has not failed", async () => {
    vi.useFakeTimers();
    const store = createStore();
    store.set(runtimeAtom, null);
    // 'idle' and 'connecting' are a boot in progress, not a boot that failed.
    store.set(lodyControlConnectionStateAtom, "connecting");
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(seen.generation).toBe(0);
    await view.unmount();
  });

  it("rebuilds the provider when the boot failed and left no runtime", async () => {
    vi.useFakeTimers();
    boxIsAnswering();
    const store = createStore();
    store.set(runtimeAtom, null);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    // Nothing before the first delay: a rebuild on the same tick would spin
    // against a daemon that is still opening its sockets.
    expect(seen.generation).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(runtimeBootRetryDelayMs(0));
    });
    expect(seen.generation).toBe(1);
    await view.unmount();
  });

  it("keeps rebuilding for as long as the box needs, without a budget", async () => {
    vi.useFakeTimers();
    boxIsAnswering();
    const store = createStore();
    store.set(runtimeAtom, null);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    // Five minutes of a daemon that is slow to arrive. A retry budget here
    // would be a fourth latch of the same shape as the three being removed:
    // a fixed moment at which "slow" is decided to mean "never".
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(seen.generation).toBeGreaterThan(3);
    await view.unmount();
  });

  it("stops as soon as a runtime exists", async () => {
    vi.useFakeTimers();
    boxIsAnswering();
    const store = createStore();
    store.set(runtimeAtom, null);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(runtimeBootRetryDelayMs(0));
    });
    const afterFirstRebuild = seen.generation;
    expect(afterFirstRebuild).toBe(1);

    // The rebuild worked. Whatever the socket does from here is not this
    // hook's business.
    await act(async () => {
      store.set(runtimeAtom, LIVE_RUNTIME);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(seen.generation).toBe(afterFirstRebuild);
    await view.unmount();
  });

  it("ignores a connection error that still has a runtime behind it", async () => {
    vi.useFakeTimers();
    const store = createStore();
    // A live runtime whose websocket dropped. Remounting here would throw away
    // good local state to fix nothing, and the vendored reconnect path already
    // owns this case.
    store.set(runtimeAtom, LIVE_RUNTIME);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(seen.generation).toBe(0);
    await view.unmount();
  });

  /**
   * THE REGRESSION THIS GUARD EXISTS FOR. Without it the loop retries into the
   * void — a member who holds no machine here, a read-only shared surface, a
   * workspace whose box is gone all sit on `error` with a null runtime forever,
   * and a heavy provider is torn down and rebuilt every few seconds for as long
   * as the tab is open. Measured, not feared: it made `lody-tab-selection-sync`
   * 28% slower and pushed six of its cases over their deadline under load.
   */
  it("does not rebuild against a box that is not answering", async () => {
    vi.useFakeTimers();
    resetBoxGatewayHealth();
    const store = createStore();
    store.set(runtimeAtom, null);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(seen.generation).toBe(0);
    await view.unmount();
  });

  it("starts rebuilding the moment the box does answer", async () => {
    vi.useFakeTimers();
    resetBoxGatewayHealth();
    const store = createStore();
    store.set(runtimeAtom, null);
    const { seen, render: mountHost } = mount(store);
    const view = await mountHost();

    await act(async () => {
      store.set(lodyControlConnectionStateAtom, "error");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // Silent while nothing was there...
    expect(seen.generation).toBe(0);

    // ...and awake as soon as bytes come back from the box. This is the
    // difference between a guard and a budget: nothing was given up on.
    await act(async () => {
      reportBoxGatewayProbe("reached");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(runtimeBootRetryDelayMs(0));
    });
    expect(seen.generation).toBe(1);
    await view.unmount();
  });

  it("holds still until the surface knows which box it is talking to", async () => {
    vi.useFakeTimers();
    const store = createStore();
    store.set(runtimeAtom, null);
    store.set(lodyControlConnectionStateAtom, "error");
    const { seen, render: mountHost } = mount(store, null);
    const view = await mountHost();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(seen.generation).toBe(0);
    await view.unmount();
  });
});
