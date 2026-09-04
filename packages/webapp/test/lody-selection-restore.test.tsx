/**
 * A WORKSPACE SWITCH MUST REOPEN THE SESSION IT LEFT, NOT THE LANDING.
 *
 * The field report: switch away from a workspace with a session open, come
 * back, and the surface shows "New session" — the selection is gone until a
 * reload, which then restores it. The address was never lost (a reload reads it
 * back); the SURFACE dropped it.
 *
 * The own-box memory router starts at `/chat` (the landing) and its first
 * resolved address is `null`. `SessionSurface` reports that null to the shell,
 * `use-lody-rail`'s `mirror(null)` turns it into `openLanding()`, and the
 * restored `{ sessionId }` address is erased — permanently, because `CloudApp`
 * then records the landing as where the workspace was left. Whether the
 * imperative `openSession` wins that race is timing luck.
 *
 * The fix removes the race at its source: the shell hands the restored session
 * to `LodySessionsRegion`, which opens the OWNED surface's router on it (the
 * same door the shared surface already uses for `sharedOpen.sessionId`). The
 * first resolved address is then the session, so nothing null is ever mirrored
 * back. This pins the region's contract: the owned surface is handed the
 * restored id, and a shared surface never is.
 */
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoxEndpoints } from "../src/resolver.js";
import type { SharedSurfaceTarget } from "../src/lody/LodySessionsRegion.js";
import { render } from "./dom.js";

function boxAt(host: string): BoxEndpoints {
  return {
    terminalUrl: `https://${host}/webapp/7681/`,
    filesBase: `https://${host}/webapp/5000/`,
    lodySyncUrl: `wss://${host}/webapp/7445/lody/sync`,
    lodyRpcUrl: `https://${host}/webapp/7445/lody/rpc`,
    lodyControlUrl: `https://${host}/webapp/7445/lody/control`,
    lodyProjectUrl: `https://${host}/webapp/7445/lody/project`,
    lodyPlatformUrl: `https://${host}/webapp/7445/lody/platform`,
  } satisfies BoxEndpoints;
}

const BOX_A = boxAt("box-a.invalid");
const OWNER_BOX = boxAt("owner-box.invalid");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

interface SurfaceRecord {
  initialSessionId: string | undefined;
  shared: { sessionId: string } | undefined;
}

/**
 * Mounts the region with a stand-in surface that records, once per instance,
 * the two address-bearing props the fix is about. Recorded from a `useState`
 * initialiser so it is the MOUNT that is observed, not a render.
 */
async function mountRegion() {
  vi.resetModules();
  vi.stubEnv("VITE_BLITZ_LODY_SESSIONS", "true");
  const records: SurfaceRecord[] = [];
  vi.doMock("../src/lody/SessionSurface.js", () => ({
    default: (props: { initialSessionId?: string; shared?: { sessionId: string } }) => {
      useState(() => {
        records.push({ initialSessionId: props.initialSessionId, shared: props.shared });
        return null;
      });
      return <div data-testid="surface" />;
    },
  }));
  const { LodySessionsRegion } = await import("../src/lody/LodySessionsRegion.js");

  const base = {
    sessions: "present" as const,
    viewerName: "Me",
    viewerAvatarUrl: null,
    workspaceTitle: "Workspace",
    visible: true,
    railHost: null,
  };
  const view = await render(
    <LodySessionsRegion endpoints={BOX_A} {...base} initialSessionId="sess-1" />,
  );
  return { records, base, view, LodySessionsRegion };
}

describe("restoring the selected session across a switch", () => {
  it("opens the owned surface on the restored session", async () => {
    const { records, view } = await mountRegion();
    expect(records).toEqual([{ initialSessionId: "sess-1", shared: undefined }]);
    await view.unmount();
  });

  it("never hands an own-box selection to a shared surface", async () => {
    const { records, base, view, LodySessionsRegion } = await mountRegion();
    const sharedOpen: SharedSurfaceTarget = {
      ownerMembershipId: "owner-1",
      sessionId: "shared-sess",
      level: "rw",
      endpoints: OWNER_BOX,
    };
    // The same shell selection is present, but the address on screen is a shared
    // session on another member's box: the owned surface's restore must not ride
    // along, or it would fight the shared open.
    await act(async () =>
      view.root.render(
        <LodySessionsRegion
          endpoints={BOX_A}
          {...base}
          initialSessionId="sess-1"
          sharedOpen={sharedOpen}
        />,
      ),
    );
    const shared = records.find((r) => r.shared !== undefined);
    expect(shared).toEqual({ initialSessionId: undefined, shared: { sessionId: "shared-sess" } });
    await view.unmount();
  });
});
