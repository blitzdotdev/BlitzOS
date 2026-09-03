import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function apiAt(initialSessionId: string | null): LodySessionSurfaceApi & {
  openSession: ReturnType<typeof vi.fn>;
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

afterEach(() => {
  window.localStorage.clear();
});

describe("the React surface pool adapter", () => {
  it("accepts API and route publication only from the active ownership token", async () => {
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const railHost = document.createElement("div");
    const apis: Array<LodySessionSurfaceApi | null> = [];
    const routes: Array<string | null> = [];
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={railHost}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
        onApiReady={(api) => apis.push(api)}
        onActiveSessionChange={(sessionId) => routes.push(sessionId)}
      />
    );
    const view = await render(tree(target("a", "session-a")));
    const aSurface = current(recorder);
    const apiA = apiAt("session-a");
    await act(async () => {
      aSurface.onIdentity?.(identity("a"));
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
      bSurface.onIdentity?.(identity("b"));
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
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
      />
    );
    const view = await render(tree(target("a", "old-session")));
    const surface = current(recorder);
    const api = apiAt("old-session");
    await act(async () => {
      surface.onIdentity?.(identity("a"));
      surface.onApiReady?.(api);
    });

    await act(async () => view.root.render(tree(target("a", "deep-link-session"))));
    await settle();
    expect(current(recorder).surfaceKey).toBe(surface.surfaceKey);
    expect(api.openSession).toHaveBeenCalledWith("deep-link-session");
    await view.unmount();
  });

  it("uses exact single-surface replacement when the runtime switch is off", async () => {
    window.localStorage.setItem("blitz.lody.keepalive", "off");
    const recorder: SurfaceRecorder = { surfaces: [] };
    const Host = RecordingHost(recorder);
    const tree = (next: LodySurfacePoolTarget) => (
      <LodySurfacePool
        Surface={Host}
        target={next}
        viewer={{ name: "Me", avatarUrl: null }}
        visible
        railHost={null}
        rail={{ terminals: [], activeTerminalId: "", onSelectTerminal: () => {} }}
      />
    );
    const view = await render(tree(target("a", null)));
    const firstA = current(recorder);
    await act(async () => firstA.onIdentity?.(identity("a")));
    await act(async () => view.root.render(tree(target("b", null))));
    expect(recorder.surfaces).toHaveLength(1);
    const b = current(recorder);
    await act(async () => b.onIdentity?.(identity("b")));
    await act(async () => view.root.render(tree(target("a", null))));
    expect(recorder.surfaces).toHaveLength(1);
    expect(current(recorder).surfaceKey).not.toBe(firstA.surfaceKey);
    await view.unmount();
  });
});
