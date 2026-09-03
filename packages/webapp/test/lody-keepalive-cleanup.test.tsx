import { act, StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LodySurfacePool, type LodySurfacePoolTarget } from "../src/lody/LodySurfacePool.js";
import type {
  LodySessionSurfaceHostProps,
  LodySessionSurfacePoolHostProps,
} from "../src/lody/SessionSurface.js";
import { render, settle } from "./dom.js";
import { createLodySurfaceRuntimeLifecycle } from "../src/lody/surface-runtime-lifecycle.js";

interface ResourceLedger {
  sockets: Set<string>;
  intervals: Map<string, ReturnType<typeof setInterval>>;
  repos: Set<string>;
  openDatabases: Set<string>;
  disposed: Set<string>;
  surfaces: readonly LodySessionSurfaceHostProps[];
}

interface DebugRepoWindow extends Window {
  repo?: { entryId: string };
}

function debugRepoWindow(): DebugRepoWindow {
  // SAFETY: the test installs and reads only its own optional `repo` property;
  // every native Window member remains the original jsdom implementation.
  return window as DebugRepoWindow;
}

function boxTarget(name: string): LodySurfacePoolTarget {
  const origin = `https://${name}.invalid`;
  return {
    kind: "owned",
    endpoints: {
      syncUrl: `wss://${name}.invalid/lody/sync`,
      rpcUrl: `${origin}/lody/rpc`,
      controlUrl: `${origin}/lody/control`,
      projectUrl: `${origin}/lody/project`,
      platformUrl: `${origin}/lody/platform`,
      filesBase: `${origin}/workspace/`,
    },
    workspaceTitle: name,
    readOnly: false,
    desiredSessionId: null,
    desiredArchive: false,
  };
}

function boxName(surface: LodySessionSurfaceHostProps): string {
  return new URL(surface.endpoints.platformUrl).hostname.split(".")[0] ?? "missing";
}

function ResourceSurface(props: {
  surface: LodySessionSurfaceHostProps;
  ledger: ResourceLedger;
}) {
  const initial = useRef(props.surface).current;
  useEffect(() => {
    const name = boxName(initial);
    const id = initial.surfaceKey;
    const controller = new AbortController();
    const repoOwner = { entryId: id };
    let started = false;
    void initial.onIdentityClaim?.(
      { machineId: `machine-${name}`, lwWorkspaceId: `lw_${name}` },
      controller.signal,
    ).then((granted) => {
      if (!granted || controller.signal.aborted) return;
      if (props.ledger.openDatabases.has(name)) {
        throw new Error(`indexeddb_double_open:${name}`);
      }
      started = true;
      props.ledger.openDatabases.add(name);
      props.ledger.sockets.add(id);
      props.ledger.repos.add(id);
      const timer = setInterval(() => {}, 60_000);
      props.ledger.intervals.set(id, timer);
      debugRepoWindow().repo = repoOwner;
    });
    return () => {
      controller.abort();
      if (!started) {
        initial.onSurfaceReleased?.();
        return;
      }
      props.ledger.sockets.delete(id);
      props.ledger.repos.delete(id);
      props.ledger.openDatabases.delete(name);
      const heldTimer = props.ledger.intervals.get(id);
      if (heldTimer !== undefined) clearInterval(heldTimer);
      props.ledger.intervals.delete(id);
      props.ledger.disposed.add(id);
      if (debugRepoWindow().repo === repoOwner) delete debugRepoWindow().repo;
      initial.onSurfaceReleased?.();
    };
  }, [initial, props.ledger]);
  return <div data-resource={initial.surfaceKey} />;
}

function ResourceHost(ledger: ResourceLedger) {
  return function Host(props: LodySessionSurfacePoolHostProps) {
    ledger.surfaces = props.surfaces;
    return props.surfaces.map((surface) => (
      <ResourceSurface key={surface.surfaceKey} surface={surface} ledger={ledger} />
    ));
  };
}

function active(ledger: ResourceLedger): LodySessionSurfaceHostProps {
  const surface = ledger.surfaces.find((item) => item.active === true);
  if (surface === undefined) throw new Error("resource pool has no active surface");
  return surface;
}

interface BarrierLedger {
  surfaces: readonly LodySessionSurfaceHostProps[];
  events: string[];
  openIdentities: Set<string>;
  firstAEntryId: string | null;
  destroyFirstA: Promise<void>;
  releaseFirstA: () => void;
}

function createBarrierLedger(): BarrierLedger {
  let releaseFirstA = (): void => {};
  const destroyFirstA = new Promise<void>((resolve) => {
    releaseFirstA = resolve;
  });
  return {
    surfaces: [],
    events: [],
    openIdentities: new Set(),
    firstAEntryId: null,
    destroyFirstA,
    releaseFirstA,
  };
}

function BarrierSurface(props: { surface: LodySessionSurfaceHostProps; ledger: BarrierLedger }) {
  const initial = useRef(props.surface).current;
  useEffect(() => {
    const name = boxName(initial);
    const identity = name === "b" ? "b" : "a";
    const controller = new AbortController();
    let opened = false;
    void initial.onIdentityClaim?.(
      { machineId: `machine-${identity}`, lwWorkspaceId: `lw_${identity}` },
      controller.signal,
    ).then((granted) => {
      if (!granted || controller.signal.aborted) return;
      if (props.ledger.openIdentities.has(identity)) {
        throw new Error(`indexeddb_double_open:${identity}`);
      }
      opened = true;
      props.ledger.openIdentities.add(identity);
      props.ledger.events.push(`create:${name}`);
      if (identity === "a" && props.ledger.firstAEntryId === null) {
        props.ledger.firstAEntryId = initial.surfaceKey;
      }
    });
    return () => {
      controller.abort();
      void (async () => {
        if (opened) {
          props.ledger.events.push(`destroy-start:${name}`);
          if (initial.surfaceKey === props.ledger.firstAEntryId) {
            await props.ledger.destroyFirstA;
          }
          props.ledger.openIdentities.delete(identity);
          props.ledger.events.push(`destroyed:${name}`);
        }
        initial.onSurfaceReleased?.();
      })();
    };
  }, [initial, props.ledger]);
  return null;
}

function BarrierHost(ledger: BarrierLedger) {
  return function Host(props: LodySessionSurfacePoolHostProps) {
    ledger.surfaces = props.surfaces;
    return props.surfaces.map((surface) => (
      <BarrierSurface key={surface.surfaceKey} surface={surface} ledger={ledger} />
    ));
  };
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: fine)",
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  delete debugRepoWindow().repo;
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("surface eviction cleanup", () => {
  it("waits for mid-construction runtime disposal before releasing surface authority", async () => {
    type FakeRuntime = { dispose: () => Promise<void> };
    let resolveConstruction: ((runtime: FakeRuntime) => void) | undefined;
    let resolveDestroy: (() => void) | undefined;
    const construction = new Promise<FakeRuntime>((resolve) => {
      resolveConstruction = resolve;
    });
    const destroy = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const order: string[] = [];
    const dispose = vi.fn(async () => {
      order.push("repo-destroy-start");
      await destroy;
      order.push("repo-destroyed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let surfaces: readonly LodySessionSurfaceHostProps[] = [];
    function SlowRuntimeSurface({ surface }: { surface: LodySessionSurfaceHostProps }) {
      const initial = useRef(surface).current;
      const lifecycle = useRef(
        createLodySurfaceRuntimeLifecycle({ constructionWarningMs: 1_000 }),
      ).current;
      useEffect(() => {
        const name = boxName(initial);
        const controller = new AbortController();
        let runtime: FakeRuntime | null = null;
        let unmounted = false;
        void initial.onIdentityClaim?.(
          { machineId: `machine-${name}`, lwWorkspaceId: `lw_${name}` },
          controller.signal,
        ).then(async (granted) => {
          if (!granted || controller.signal.aborted) return;
          order.push(`construction-started:${name}`);
          lifecycle.onRuntimeLifecycle({ attemptId: 1, phase: "starting" });
          const created = name === "a"
            ? await construction
            : { dispose: async () => {} };
          runtime = created;
          lifecycle.onRuntimeLifecycle({ attemptId: 1, phase: "created" });
          order.push(`created:${name}`);
          if (!unmounted) return;
          await created.dispose();
          lifecycle.onRuntimeLifecycle({ attemptId: 1, phase: "disposed" });
          order.push(`disposed:${name}`);
        });
        return () => {
          controller.abort();
          unmounted = true;
          if (runtime !== null) {
            void runtime.dispose().finally(() => {
              lifecycle.onRuntimeLifecycle({ attemptId: 1, phase: "disposed" });
              order.push(`disposed:${name}`);
            });
          }
          lifecycle.releaseAfterRuntime(() => {
            order.push(`client-aborted:${name}`, `bridge-disposed:${name}`);
            initial.onSurfaceReleased?.();
            order.push(`identity-released:${name}`);
          });
        };
      }, [initial, lifecycle]);
      return null;
    }
    function Host(props: LodySessionSurfacePoolHostProps) {
      surfaces = props.surfaces;
      return props.surfaces.map((surface) => (
        <SlowRuntimeSurface key={surface.surfaceKey} surface={surface} />
      ));
    }
    const tree = (target: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={target}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
      />
    );
    const view = await render(tree(boxTarget("a")));
    await settle();
    expect(order).toContain("construction-started:a");
    await act(async () => view.root.render(tree(boxTarget("b"))));
    await settle();
    await act(async () => view.root.render(tree(boxTarget("c"))));
    await settle();
    expect(surfaces.some((surface) => boxName(surface) === "a")).toBe(false);
    expect(order).not.toContain("client-aborted:a");

    resolveConstruction?.({ dispose });
    await settle();
    expect(order).toContain("created:a");
    expect(order).toContain("repo-destroy-start");
    expect(order).not.toContain("client-aborted:a");
    expect(dispose).toHaveBeenCalledTimes(1);

    resolveDestroy?.();
    await settle();
    expect(order.indexOf("bridge-disposed:a"))
      .toBeGreaterThan(order.indexOf("disposed:a"));
    expect(order.indexOf("identity-released:a"))
      .toBeGreaterThan(order.indexOf("bridge-disposed:a"));
    expect(consoleError).not.toHaveBeenCalled();
    await view.unmount();
    await settle();
  });

  it("releases immediately when RuntimeProvider starts no construction attempt", () => {
    const lifecycle = createLodySurfaceRuntimeLifecycle();
    const release = vi.fn();
    lifecycle.releaseAfterRuntime(release);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("distinguishes StrictMode attempts and never releases at the warning bound", async () => {
    vi.useFakeTimers();
    try {
      const slow = vi.fn();
      const release = vi.fn();
      let nextAttemptId = 10;
      const lifecycle = createLodySurfaceRuntimeLifecycle({
        constructionWarningMs: 10,
        onConstructionSlow: slow,
      });
      function StrictRuntimeAttempt() {
        useEffect(() => {
          nextAttemptId += 1;
          const attemptId = nextAttemptId;
          lifecycle.onRuntimeLifecycle({ attemptId, phase: "starting" });
          return () => lifecycle.onRuntimeLifecycle({ attemptId, phase: "failed" });
        }, []);
        return null;
      }
      const view = await render(
        <StrictMode>
          <StrictRuntimeAttempt />
        </StrictMode>,
      );
      expect(nextAttemptId).toBe(12);
      lifecycle.releaseAfterRuntime(release);
      await vi.advanceTimersByTimeAsync(10);
      expect(slow).toHaveBeenCalledTimes(1);
      expect(slow).toHaveBeenCalledWith({ attemptId: 12, timeoutMs: 10 });
      expect(release).not.toHaveBeenCalled();
      await view.unmount();
      await Promise.resolve();
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases every owned resource and permits the same identity to open again", async () => {
    const ledger: ResourceLedger = {
      sockets: new Set(),
      intervals: new Map(),
      repos: new Set(),
      openDatabases: new Set(),
      disposed: new Set(),
      surfaces: [],
    };
    const Host = ResourceHost(ledger);
    const tree = (target: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={target}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
      />
    );
    const view = await render(tree(boxTarget("a")));
    await settle();
    const firstA = active(ledger);
    await act(async () => view.root.render(tree(boxTarget("b"))));
    await settle();
    const b = active(ledger);
    const hiddenA = ledger.surfaces.find((surface) => surface.surfaceKey === firstA.surfaceKey);
    if (hiddenA === undefined) throw new Error("A was not retained");

    await act(async () => hiddenA.onContinuityLost?.());
    await settle();
    expect(ledger.disposed).toContain(firstA.surfaceKey);
    expect(ledger.sockets).not.toContain(firstA.surfaceKey);
    expect(ledger.intervals.has(firstA.surfaceKey)).toBe(false);
    expect(ledger.repos).not.toContain(firstA.surfaceKey);
    expect(ledger.openDatabases.has("a")).toBe(false);
    expect(debugRepoWindow().repo).toEqual({ entryId: b.surfaceKey });

    // The first A released its IndexedDB ownership before this second A mount.
    // The ResourceSurface throws if that ordering is wrong.
    await act(async () => view.root.render(tree(boxTarget("a"))));
    await settle();
    const secondA = active(ledger);
    expect(secondA.surfaceKey).not.toBe(firstA.surfaceKey);
    expect(ledger.openDatabases.has("a")).toBe(true);

    await view.unmount();
    await settle();
    expect(ledger.sockets.size).toBe(0);
    expect(ledger.intervals.size).toBe(0);
    expect(ledger.repos.size).toBe(0);
    expect(ledger.openDatabases.size).toBe(0);
    expect(debugRepoWindow().repo).toBeUndefined();
  });

  it("does not reopen an invalidated identity until asynchronous destroy resolves", async () => {
    const ledger = createBarrierLedger();
    const Host = BarrierHost(ledger);
    const tree = (target: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={target}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
      />
    );
    const view = await render(tree(boxTarget("a-old")));
    await settle();
    await act(async () => view.root.render(tree(boxTarget("b"))));
    await settle();
    const hiddenA = ledger.surfaces.find((surface) => boxName(surface) === "a-old");
    if (hiddenA === undefined) throw new Error("old A was not retained");

    await act(async () => hiddenA.onContinuityLost?.());
    await settle();
    await act(async () => view.root.render(tree(boxTarget("a-new"))));
    await settle();
    expect(ledger.events).toContain("destroy-start:a-old");
    expect(ledger.events).not.toContain("destroyed:a-old");
    expect(ledger.events).not.toContain("create:a-new");

    ledger.releaseFirstA();
    await settle();
    await settle();
    expect(ledger.events).toContain("destroyed:a-old");
    expect(ledger.events).toContain("create:a-new");
    expect(ledger.events.indexOf("create:a-new"))
      .toBeGreaterThan(ledger.events.indexOf("destroyed:a-old"));

    await view.unmount();
    await settle();
    expect(ledger.openIdentities.size).toBe(0);
  });
});
