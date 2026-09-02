import { act, useEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LodySurfacePool, type LodySurfacePoolTarget } from "../src/lody/LodySurfacePool.js";
import type {
  LodySessionSurfaceHostProps,
  LodySessionSurfacePoolHostProps,
} from "../src/lody/SessionSurface.js";
import { render, settle } from "./dom.js";

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
    if (props.ledger.openDatabases.has(name)) {
      throw new Error(`indexeddb_double_open:${name}`);
    }
    props.ledger.openDatabases.add(name);
    props.ledger.sockets.add(id);
    props.ledger.repos.add(id);
    const timer = setInterval(() => {}, 60_000);
    props.ledger.intervals.set(id, timer);
    const repoOwner = { entryId: id };
    debugRepoWindow().repo = repoOwner;
    initial.onIdentity?.({ machineId: `machine-${name}`, lwWorkspaceId: `lw_${name}` });
    return () => {
      props.ledger.sockets.delete(id);
      props.ledger.repos.delete(id);
      props.ledger.openDatabases.delete(name);
      const heldTimer = props.ledger.intervals.get(id);
      if (heldTimer !== undefined) clearInterval(heldTimer);
      props.ledger.intervals.delete(id);
      props.ledger.disposed.add(id);
      if (debugRepoWindow().repo === repoOwner) delete debugRepoWindow().repo;
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

afterEach(() => {
  delete debugRepoWindow().repo;
  window.localStorage.clear();
});

describe("surface eviction cleanup", () => {
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
});
