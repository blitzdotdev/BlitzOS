/**
 * WHAT THE SHELL DOES WHEN THE BOX GATEWAY IS NOT THERE (BUG-CV-01, BUG-CV-02).
 *
 * The field report, from canary workspace `zesty-swan`. Its box booted with a
 * cloudflared connector carrying zero ready connections: `readyConnections=0`,
 * `cloudflared_tunnel_total_requests=0` after nearly five hours of uptime, and
 * every `/workspaces/<ws>/webapp/7445/*` call answering 530 across eighteen
 * polls over more than seven minutes. Two defects followed from one dead
 * tunnel.
 *
 * BUG-CV-01, critical: the whole document went blank. The shell painted for
 * about five seconds — rail, "connecting · terminal", footer — and then
 * `body.innerText.length` went 87 to 0, on two loads out of two. The console
 * held `Failed to fetch dynamically imported module:
 * /assets/SessionSurface-CoBDK0FC.js` after a run of
 * `net::ERR_INSUFFICIENT_RESOURCES`. The chunk itself was fine: curled
 * directly it answered 200 with 3 583 733 bytes. The polls had exhausted the
 * browser's sockets, the lazy import lost the race, and nothing above it caught
 * the rejection — so React unmounted the tree. The degraded path it should have
 * fallen to ALREADY WORKED: blocking the same requests at the network layer
 * rendered "Sessions are unavailable on this workspace: Failed to fetch" on the
 * very same build.
 *
 * BUG-CV-02, major: the footer read `workspace running` throughout. The machine
 * WAS running; the status was true about the VM and useless about the
 * workspace, because nothing in the shell asked whether the box could be
 * reached.
 *
 * The properties below are the fix, in the order a member meets them.
 *
 * NO DAEMON AND NO NETWORK. Every fact here is the wiring between a status code
 * and a rendered string, which is where both defects were.
 */
import { Suspense, act, lazy } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE,
  boxGatewayFetch,
  boxGatewayHealth,
  resetBoxGatewayHealth,
} from "../src/box-gateway-health.js";
import { probeLodySessionsDoor } from "../src/lody/box-capability.js";
// STATIC, AND IT HAS TO BE. `platform.js` pulls Convex and the vendored Lody
// providers behind it, which is seconds of transform on a loaded box. Imported
// inside the poller's own `it()` that cost lands INSIDE the 5 s test timeout,
// and the test fails on module weight rather than on the property — which is
// measured in a millisecond once the module is there.
import { useLodyPlatformSnapshot } from "../src/lody/platform.js";
import { SurfaceLoadBoundary } from "../src/lody/SurfaceLoadBoundary.js";
import {
  workspaceStatusLine,
  WORKSPACE_UNREACHABLE_STATUS,
} from "../src/shell/workspace-status-line.js";
import type { BoxEndpoints } from "../src/resolver.js";
import { render } from "./dom.js";

/** The exact console line the field report carried. */
const CHUNK_FAILURE =
  "Failed to fetch dynamically imported module: /assets/SessionSurface-CoBDK0FC.js";

const PLATFORM_URL = "https://cp.invalid/workspaces/ws-1/webapp/7445/lody/platform";

/** The daemon's own catalog, the shape `parseLodyPlatformSnapshot` accepts. */
const CATALOG = JSON.stringify({
  identity: { userId: "local:11111111-1111-1111-1111-111111111111" },
  machine: { machineId: "m-1" },
  workspaces: [
    { workspaceId: "lw_1", name: "Lody", slug: "local", role: "owner", state: "active" },
  ],
});

const ENDPOINTS = {
  terminalUrl: "https://cp.invalid/workspaces/ws-1/webapp/7681/",
  filesBase: "https://cp.invalid/workspaces/ws-1/webapp/5000/",
  lodySyncUrl: "wss://cp.invalid/workspaces/ws-1/webapp/7445/lody/sync",
  lodyRpcUrl: "https://cp.invalid/workspaces/ws-1/webapp/7445/lody/rpc",
  lodyControlUrl: "https://cp.invalid/workspaces/ws-1/webapp/7445/lody/control",
  lodyProjectUrl: "https://cp.invalid/workspaces/ws-1/webapp/7445/lody/project",
  lodyPlatformUrl: PLATFORM_URL,
} satisfies BoxEndpoints;

/** What the control plane's proxy answers while the tunnel has no connector. */
const answering = (status: number): typeof fetch =>
  vi.fn(async () => new Response("error code: 530", { status }));

beforeEach(() => {
  resetBoxGatewayHealth();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  resetBoxGatewayHealth();
});

describe("a rejected session-surface chunk", () => {
  /**
   * The whole region, with the import made to fail the way the field report's
   * did. `vi.doMock` with a throwing factory is a dynamic import that rejects,
   * which is what a chunk the browser could not fetch is.
   *
   * The second evaluation SUCCEEDS, so the retry has something to find. In a
   * browser it may not — a module map records a failed fetch — and that is why
   * the retry's failure has to land on the same notice rather than anywhere
   * else.
   */
  async function mountFailingRegion(): Promise<{
    view: Awaited<ReturnType<typeof render>>;
    attempts: () => number;
  }> {
    vi.resetModules();
    vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
    let attempts = 0;
    vi.doMock("../src/lody/SessionSurface.js", () => {
      attempts += 1;
      if (attempts === 1) throw new Error(CHUNK_FAILURE);
      return { default: () => <div data-testid="surface">the surface</div> };
    });
    const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");
    const view = await render(
      <LodySessionsRegion
        endpoints={ENDPOINTS}
        sessions="present"
        viewerName="Me"
        viewerAvatarUrl={null}
        workspaceTitle="Workspace"
        visible
        railHost={null}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    return { view, attempts: () => attempts };
  }

  it("renders the degraded notice in the failure's own words", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The boundary alone, against a `lazy()` that rejects with the exact line
    // the browser wrote. Straight to the component, because a mocked module's
    // failure would reach it wearing the test runner's words instead.
    const Chunk = lazy(async () => await Promise.reject(new Error(CHUNK_FAILURE)));
    const view = await render(
      <SurfaceLoadBoundary onRetry={() => undefined}>
        <Suspense fallback={null}>
          <Chunk />
        </Suspense>
      </SurfaceLoadBoundary>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // THE REGRESSION, stated as the field measured it: the container must not
    // go empty. `bodyLen 87 -> 0` is the defect; anything rendered is the fix.
    expect(view.container.childElementCount).toBeGreaterThan(0);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Sessions are unavailable on this workspace");
    // In the words of whatever failed, so a member's screenshot names the cause.
    expect(text).toContain(CHUNK_FAILURE);

    await view.unmount();
  });

  it("keeps the region on screen when its own import rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { view, attempts } = await mountFailingRegion();

    expect(attempts()).toBe(1);
    expect(view.container.childElementCount).toBeGreaterThan(0);
    expect(view.container.textContent ?? "").toContain(
      "Sessions are unavailable on this workspace",
    );

    await view.unmount();
  });

  it("mounts the surface when the member retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { view, attempts } = await mountFailingRegion();

    const retry = view.container.querySelector("button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => {
      retry?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    // A FRESH `lazy()` PER ATTEMPT is what makes this possible: React records a
    // rejected payload on the component object and re-throws it forever, so
    // reusing one would only reproduce the failure.
    expect(attempts()).toBe(2);
    expect(view.container.querySelector("[data-testid='surface']")).not.toBeNull();

    await view.unmount();
  });
});

describe("every read of the box gateway", () => {
  it("carries a deadline, so a dead tunnel cannot hold the socket", async () => {
    let init: RequestInit | undefined;
    const fetcher: typeof fetch = async (target, options) => {
      expect(target).toBe("https://cp.invalid/webapp/7445/ports");
      init = options;
      return new Response("{}", { status: 200 });
    };
    await boxGatewayFetch("https://cp.invalid/webapp/7445/ports", fetcher);

    // A caller that passed no signal of its own still gets one, which is the
    // half the polls were missing: a request with no deadline holds its socket
    // for as long as the tab lives.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("reports what it saw, so the shell learns the box is unreachable", async () => {
    const dead = answering(530);
    expect(boxGatewayHealth()).toBe("unknown");
    for (let attempt = 0; attempt < BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE; attempt += 1) {
      await boxGatewayFetch(PLATFORM_URL, dead);
    }
    expect(boxGatewayHealth()).toBe("unreachable");

    // One answer from the box clears it. Recovery needs no new poll: the reads
    // the shell already sends are the evidence in both directions.
    await boxGatewayFetch(PLATFORM_URL, answering(200));
    expect(boxGatewayHealth()).toBe("reachable");
  });

  it("does not read a cold daemon's 503 as a dead tunnel", async () => {
    // The Lody bridge answers 503 itself until the daemon writes its catalog.
    // A 503 came FROM the box, so it is proof the box is reachable — folding it
    // in would put "box unreachable" in the footer of every booting workspace.
    const cold = answering(503);
    for (let attempt = 0; attempt < BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE; attempt += 1) {
      await boxGatewayFetch(PLATFORM_URL, cold);
    }
    expect(boxGatewayHealth()).toBe("reachable");
  });

  it("counts a transport failure but not the caller's own abort", async () => {
    const throwing: typeof fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    for (let attempt = 0; attempt < BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE; attempt += 1) {
      await expect(boxGatewayFetch(PLATFORM_URL, throwing)).rejects.toThrow("Failed to fetch");
    }
    expect(boxGatewayHealth()).toBe("unreachable");

    resetBoxGatewayHealth();
    // A workspace switch aborts its polls. That is not evidence about a box,
    // and counting it would make every navigation look like an outage.
    const controller = new AbortController();
    controller.abort();
    for (let attempt = 0; attempt < BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE; attempt += 1) {
      await expect(
        boxGatewayFetch(PLATFORM_URL, throwing, controller.signal),
      ).rejects.toThrow("Failed to fetch");
    }
    expect(boxGatewayHealth()).toBe("unknown");
  });
});

describe("the footer's workspace status", () => {
  it("says the machine's state and nothing else while the box answers", () => {
    expect(workspaceStatusLine("running", "reachable")).toBe("workspace running");
    expect(workspaceStatusLine("running", "unknown")).toBe("workspace running");
    expect(workspaceStatusLine(undefined, "unreachable")).toBe("workspace pending");
  });

  it("qualifies only `running`, because the other states already say it", () => {
    // A box that is resuming is unreachable by definition, and "waking" is the
    // word the member can act on. The contradiction is in one state only.
    expect(workspaceStatusLine("resuming", "unreachable")).toBe("workspace resuming");
    expect(workspaceStatusLine("parked", "unreachable")).toBe("workspace parked");
    expect(workspaceStatusLine("provisioning", "unreachable")).toBe("workspace provisioning");
  });

  it("stops saying `workspace running` once the box's own polls report 530", async () => {
    // THE WHOLE DEFECT, END TO END. The probe the shell already sends is the
    // only new input; the sentence in the footer is the only new output.
    const dead = answering(530);
    for (let attempt = 0; attempt < BOX_GATEWAY_FAILURES_BEFORE_UNREACHABLE; attempt += 1) {
      expect(await probeLodySessionsDoor(PLATFORM_URL, { fetchImpl: dead })).toBe("retry");
    }
    expect(workspaceStatusLine("running", boxGatewayHealth())).toBe(
      WORKSPACE_UNREACHABLE_STATUS,
    );
    expect(WORKSPACE_UNREACHABLE_STATUS).toContain("unreachable");
  });
});

describe("the platform snapshot poller", () => {
  it("never has two reads in flight against a box that does not answer", async () => {
    // THE MECHANISM THAT BLANKED THE PAGE. This was a `setInterval` at 500 ms,
    // which fires on the clock whether or not the previous read has answered.
    // Against a tunnel with no connector every tick added a request that would
    // never come back — two a second, for as long as the tab lived — until the
    // browser had no sockets left for the chunk the shell actually needed.
    vi.useFakeTimers();
    let reads = 0;
    const hanging: typeof fetch = () => {
      reads += 1;
      return new Promise(() => undefined);
    };
    function Probe() {
      useLodyPlatformSnapshot(PLATFORM_URL, hanging);
      return null;
    }

    const view = await render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // One read, thirty seconds later. The next one is scheduled when this one
    // lands, and not before.
    expect(reads).toBe(1);
    await view.unmount();
  });

  /**
   * THE OTHER HALF OF THE FRESH-WORKSPACE BUG. The poller retried a not-ok
   * STATUS with backoff but settled permanently on a THROW, and its own comment
   * admitted the conflation: "A transport failure settles here as well, and
   * always has." On a box whose tunnel is seconds from coming up — which is
   * every freshly provisioned workspace — the first read throws, and that
   * settled the surface on the degraded notice for the lifetime of the tab.
   * Only a catalog the box served and this shell cannot read is terminal.
   */
  it("keeps polling through a transport failure, and settles when the box answers", async () => {
    vi.useFakeTimers();
    resetBoxGatewayHealth();
    let reads = 0;
    const comingUp: typeof fetch = async () => {
      reads += 1;
      if (reads <= 2) throw new TypeError("Failed to fetch");
      return new Response(CATALOG, { status: 200 });
    };
    const seen: { snapshot: unknown; error: string | null } = { snapshot: null, error: null };
    function Probe() {
      const state = useLodyPlatformSnapshot(PLATFORM_URL, comingUp);
      seen.snapshot = state.snapshot;
      seen.error = state.error;
      return null;
    }

    const view = await render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // The tunnel came up and so did the surface — no notice, no reload, and no
    // workspace switch to re-run the effect.
    expect(reads).toBeGreaterThan(2);
    expect(seen.error).toBeNull();
    expect(seen.snapshot).not.toBeNull();
    await view.unmount();
  });

  it("still settles for good on a catalog it cannot parse", async () => {
    vi.useFakeTimers();
    resetBoxGatewayHealth();
    let reads = 0;
    // The box answered, in bytes this shell cannot read. Asking again would
    // only hide the cause behind a spinner.
    const malformed: typeof fetch = async () => {
      reads += 1;
      return new Response("{not json", { status: 200 });
    };
    const seen: { error: string | null } = { error: null };
    function Probe() {
      seen.error = useLodyPlatformSnapshot(PLATFORM_URL, malformed).error;
      return null;
    }

    const view = await render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(seen.error).not.toBeNull();
    expect(reads).toBe(1);
    await view.unmount();
  });
});
