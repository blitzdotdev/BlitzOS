import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LodySurfacePool,
  type LodySurfacePoolTarget,
} from "../src/lody/LodySurfacePool.js";
import type {
  LodySessionSurfaceApi,
  LodySessionSurfaceHostProps,
  LodySessionSurfacePoolHostProps,
} from "../src/lody/SessionSurface.js";
import { render, settle } from "./dom.js";
import { createLodySurfaceIdentityClaims } from "../src/lody/surface-identity-claims.js";

interface SurfaceRecorder {
  surfaces: readonly LodySessionSurfaceHostProps[];
}

function RecordingHost(
  recorder: SurfaceRecorder,
): (props: LodySessionSurfacePoolHostProps) => React.ReactNode {
  return function Host(props) {
    recorder.surfaces = props.surfaces;
    return props.surfaces.map((surface) => (
      <div
        key={surface.surfaceKey}
        data-entry={surface.surfaceKey}
        data-active={surface.active}
        data-hidden={surface.hidden}
      />
    ));
  };
}

function target(
  name: string,
  desiredSessionId: string | null,
): LodySurfacePoolTarget {
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
    desiredSessionId,
    desiredArchive: false,
    ...(desiredSessionId === null ? {} : { initialSessionId: desiredSessionId }),
  };
}

function current(recorder: SurfaceRecorder): LodySessionSurfaceHostProps {
  const found = recorder.surfaces.find((surface) => surface.active === true);
  if (found === undefined) throw new Error("the pool has no active surface");
  return found;
}

function identity(name: string) {
  return { machineId: `machine-${name}`, lwWorkspaceId: `lw_${name}` };
}

async function claimIdentity(
  surface: LodySessionSurfaceHostProps,
  value: ReturnType<typeof identity>,
): Promise<boolean> {
  if (surface.onIdentityClaim === undefined) throw new Error("surface has no identity claim");
  return await surface.onIdentityClaim(value, new AbortController().signal);
}

function apiAt(initialSessionId: string | null): LodySessionSurfaceApi & {
  openSession: ReturnType<typeof vi.fn>;
  openLanding: ReturnType<typeof vi.fn>;
  openArchive: ReturnType<typeof vi.fn>;
} {
  let sessionId = initialSessionId;
  let archive = false;
  return {
    openSession: vi.fn((next: string) => {
      sessionId = next;
      archive = false;
    }),
    openLanding: vi.fn(() => {
      sessionId = null;
      archive = false;
    }),
    openArchive: vi.fn(() => {
      sessionId = null;
      archive = true;
    }),
    activeSessionId: () => sessionId,
    isArchiveOpen: () => archive,
    unsupportedIpcChannels: () => [],
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
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the React surface pool adapter", () => {
  it("accepts API and route publication only from the active ownership token", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const railHost = document.createElement("div");
    const apis: Array<LodySessionSurfaceApi | null> = [];
    const routes: Array<string | null> = [];
    const identityClaims = createLodySurfaceIdentityClaims();
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={railHost}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="ownership-test"
        onApiReady={(api) => apis.push(api)}
        onActiveSessionChange={(sessionId) => routes.push(sessionId)}
      />
    );
    const view = await render(tree(target("a", "session-a")));
    const aSurface = current(recorder);
    const apiA = apiAt("session-a");
    await act(async () => {
      await claimIdentity(aSurface, identity("a"));
      aSurface.onApiReady?.(apiA);
    });
    expect(routes.at(-1)).toBe("session-a");

    await act(async () => view.root.render(tree(target("b", "session-b"))));
    const bSurface = current(recorder);
    expect(bSurface.surfaceKey).not.toBe(aSurface.surfaceKey);
    const retainedA = recorder.surfaces.find((item) => item.surfaceKey === aSurface.surfaceKey);
    expect(retainedA?.active).toBe(false);
    expect(retainedA?.railHost).toBe(railHost);
    expect(bSurface.railHost).toBe(railHost);
    const publishedBeforePoison = apis.length;
    const routesBeforePoison = routes.length;
    aSurface.onApiReady?.(apiAt("poison"));
    aSurface.onActiveSessionChange?.("poison");
    expect(apis).toHaveLength(publishedBeforePoison);
    expect(routes).toHaveLength(routesBeforePoison);

    const apiB = apiAt("session-b");
    await act(async () => {
      await claimIdentity(bSurface, identity("b"));
      bSurface.onApiReady?.(apiB);
    });
    expect(apis.at(-1)).toBe(apiB);
    expect(routes.at(-1)).toBe("session-b");

    await act(async () => view.root.render(tree(target("a", "session-a"))));
    expect(current(recorder).surfaceKey).toBe(aSurface.surfaceKey);
    expect(current(recorder).endpoints).toBe(aSurface.endpoints);
    expect(apis.at(-1)).toBe(apiA);
    expect(routes.at(-1)).toBe("session-a");
    await view.unmount();
  });

  it("navigates a retained router to a changed shell address without remounting", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const identityClaims = createLodySurfaceIdentityClaims();
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="active-address-test"
      />
    );
    const view = await render(tree(target("a", "old-session")));
    const surface = current(recorder);
    const api = apiAt("old-session");
    await act(async () => {
      await claimIdentity(surface, identity("a"));
      surface.onApiReady?.(api);
    });

    await act(async () => view.root.render(tree(target("a", "deep-link-session"))));
    await settle();
    expect(current(recorder).surfaceKey).toBe(surface.surfaceKey);
    expect(api.openSession).toHaveBeenCalledWith("deep-link-session");
    await view.unmount();
  });

  it("follows an archive URL change while the same surface is already active", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const identityClaims = createLodySurfaceIdentityClaims();
    const first = target("a", "session-a");
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="active-archive-test"
      />
    );
    const view = await render(tree(first));
    const surface = current(recorder);
    const api = apiAt("session-a");
    await act(async () => {
      await claimIdentity(surface, identity("a"));
      surface.onApiReady?.(api);
    });

    await act(async () => view.root.render(tree({ ...first, desiredArchive: true })));
    expect(current(recorder).surfaceKey).toBe(surface.surfaceKey);
    expect(api.openArchive).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it("shrinks when another document publishes the keep-alive storage change", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const identityClaims = createLodySurfaceIdentityClaims();
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="storage-test"
      />
    );
    const view = await render(tree(target("a", null)));
    const firstA = current(recorder);
    await act(async () => { await claimIdentity(firstA, identity("a")); });
    await act(async () => view.root.render(tree(target("b", null))));
    const b = current(recorder);
    await act(async () => { await claimIdentity(b, identity("b")); });
    expect(recorder.surfaces).toHaveLength(2);

    window.localStorage.setItem("blitz.lody.keepalive", "off");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "blitz.lody.keepalive",
        newValue: "off",
        storageArea: window.localStorage,
      }));
    });
    expect(recorder.surfaces).toHaveLength(1);
    expect(current(recorder).surfaceKey).toBe(b.surfaceKey);
    await view.unmount();
  });

  it("remounts when either bridge-construction function changes", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const identityClaims = createLodySurfaceIdentityClaims();
    const first = target("a", null);
    first.endpoints.fetchImpl = globalThis.fetch.bind(globalThis);
    const second = target("a", null);
    second.endpoints.fetchImpl = globalThis.fetch.bind(globalThis);
    const third = target("a", null);
    third.endpoints.fetchImpl = second.endpoints.fetchImpl;
    third.endpoints.webSocketConstructor = class ReplacementWebSocket extends WebSocket {};
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="constructor-test"
      />
    );
    const view = await render(tree(first));
    const firstSurface = current(recorder);
    await act(async () => view.root.render(tree(second)));
    const secondSurface = current(recorder);
    expect(secondSurface.surfaceKey).not.toBe(firstSurface.surfaceKey);
    expect(secondSurface.endpoints.fetchImpl).toBe(second.endpoints.fetchImpl);
    await act(async () => view.root.render(tree(third)));
    expect(current(recorder).surfaceKey).not.toBe(secondSurface.surfaceKey);
    expect(current(recorder).endpoints.webSocketConstructor)
      .toBe(third.endpoints.webSocketConstructor);
    await view.unmount();
  });

  it("reactivates a retained identity when a new endpoint resolves to it", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const identityClaims = createLodySurfaceIdentityClaims();
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{}}
        identityClaims={identityClaims}
        claimantId="duplicate-test"
      />
    );
    const view = await render(tree(target("old-a", null)));
    const oldA = current(recorder);
    await act(async () => { await claimIdentity(oldA, identity("a")); });
    await act(async () => view.root.render(tree(target("new-a", null))));
    const provisional = current(recorder);
    let granted = true;
    await act(async () => {
      granted = await claimIdentity(provisional, identity("a"));
    });
    expect(granted).toBe(false);
    expect(current(recorder).surfaceKey).toBe(oldA.surfaceKey);
    expect(recorder.surfaces.some((surface) => surface.surfaceKey === provisional.surfaceKey))
      .toBe(false);
    await view.unmount();
  });
});
