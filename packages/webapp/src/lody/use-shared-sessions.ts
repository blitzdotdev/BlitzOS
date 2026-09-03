/**
 * The grantee's half of sharing, in one hook
 * (plans/LODY-SHARING.md §8 steps 2-4, §10.2).
 *
 * It lives here rather than in `CloudApp.tsx` for the reason CLAUDE.md gives:
 * that file is over the 700-line warn and is split on touch. Everything below is
 * Lody-specific, so this is the seam — the same one `use-lody-rail.ts` is.
 *
 * TWO OUTPUTS, ONE SOURCE.
 *
 * - `rows` is what the rail's "Shared with you" section draws. The control
 *   plane's `received` list says WHICH sessions and at what level; the owner's
 *   own box says what they are called (`shared-sessions.ts`).
 * - `open` is the surface to mount, when the address names a shared session. It
 *   is `null` until a grant backs the address — a deep link to a session whose
 *   grant was revoked mounts nothing rather than dialling a box that will refuse
 *   it, and the same rule makes the first render after a reload wait for the
 *   grant list instead of guessing a level. It is `null` as well while the
 *   owner's machine is not running: the shared proxy answers 409 for a stopped
 *   box, and the surface's platform poller reads every non-OK answer as "still
 *   booting" and retries forever, which blanked the whole page and hid the
 *   member's own sessions behind it. The workspace view already says which
 *   machines run, so the decision is made here, before any box is dialled.
 *
 * With the flag off, or with no workspace, it reads nothing and fetches nothing.
 */
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceView } from "@blitzos/schema";
import type { ControlPlaneClient } from "../api.js";
import type { EndpointResolver } from "../resolver.js";
import { chatSharedFrom, type ChatAddress } from "../sessions-page-state.js";
import { LODY_SESSIONS_ENABLED } from "./flag.js";
import type { SharedSurfaceTarget } from "./LodySessionsRegion.js";
import { fetchLodyPlatformSnapshot } from "./platform-snapshot.js";
import { readSharedSessionTitles, type SharedSessionRow } from "./shared-sessions.js";

export interface SharedSessionsState {
  rows: SharedSessionRow[];
  open: SharedSurfaceTarget | null;
}

const EMPTY: SharedSessionRow[] = [];

/** `running` and nothing else: a provisioning box has no VM to proxy to yet,
 * and a stopped one has given its VM back, so both answer 409 on the shared
 * route. A member without a machine row answers the same way. */
function ownerMachineRunning(workspace: WorkspaceView, ownerMembershipId: string): boolean {
  const owner = workspace.members.find((member) => member.membershipId === ownerMembershipId);
  return owner?.machine?.state === "running";
}

export function useSharedSessions(options: {
  client: Pick<ControlPlaneClient, "listSessionShares">;
  /** The workspace whose grants these are, or `null` before one is selected. */
  workspace: WorkspaceView | null;
  resolver: EndpointResolver;
  chat: ChatAddress;
  /** Bumped by the share dialog so a grant made here shows up here. */
  revision?: number;
}): SharedSessionsState {
  const { client, workspace, resolver, chat } = options;
  const revision = options.revision ?? 0;
  const workspaceId = workspace?.id ?? null;
  const [rows, setRows] = useState<SharedSessionRow[]>(EMPTY);

  useEffect(() => {
    if (!LODY_SESSIONS_ENABLED || workspace === null || workspaceId === null) {
      setRows(EMPTY);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      let received;
      try {
        ({ received } = await client.listSessionShares(workspaceId));
      } catch {
        // A workspace whose grants cannot be read has no shared section, which
        // is the same thing a workspace with no grants has. Failing louder here
        // would put an error banner on the rail for a feature the member may
        // not use.
        if (!cancelled) setRows(EMPTY);
        return;
      }
      if (cancelled) return;
      const nameFor = new Map(
        workspace.members.map((member) => [member.membershipId, member.name]),
      );
      const base: SharedSessionRow[] = received.map((share) => ({
        sessionId: share.sessionId,
        ownerMembershipId: share.ownerMembershipId,
        level: share.level,
        ownerName: nameFor.get(share.ownerMembershipId) ?? share.ownerMembershipId,
        title: null,
        ownerMachineRunning: ownerMachineRunning(workspace, share.ownerMembershipId),
      }));
      // Drawn before any box is dialled: the rows are already correct about
      // which sessions exist and at what level, and a title is a label.
      setRows(base);
      if (base.length === 0) return;

      // Only a running box can answer for its titles; the rest keep their id.
      const awake = base.filter((row) => row.ownerMachineRunning);
      const owners = [...new Set(awake.map((row) => row.ownerMembershipId))];
      const titlesByOwner = new Map<string, Map<string, string>>();
      await Promise.all(
        owners.map(async (ownerMembershipId) => {
          const endpoints = resolver.resolveShared(workspace, ownerMembershipId);
          try {
            const snapshot = await fetchLodyPlatformSnapshot(endpoints.lodyPlatformUrl);
            if (snapshot === null) return;
            titlesByOwner.set(
              ownerMembershipId,
              await readSharedSessionTitles({
                syncUrl: endpoints.lodySyncUrl,
                workspaceId: snapshot.workspace.workspaceId,
              }),
            );
          } catch {
            // A box that is off, recycling, or on an image older than the share
            // claim answers nothing. The row keeps its id.
          }
        }),
      );
      if (cancelled) return;
      setRows(
        base.map((row) => {
          const title = titlesByOwner.get(row.ownerMembershipId)?.get(row.sessionId);
          return title === undefined ? row : { ...row, title };
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [client, resolver, revision, workspace, workspaceId]);

  const open = useMemo<SharedSurfaceTarget | null>(() => {
    if (!LODY_SESSIONS_ENABLED || workspace === null) return null;
    if (chat === null || chat === "landing") return null;
    const sharedFrom = chatSharedFrom(chat);
    if (sharedFrom === undefined) return null;
    const grant = rows.find(
      (row) => row.sessionId === chat.sessionId && row.ownerMembershipId === sharedFrom,
    );
    if (grant === undefined || !grant.ownerMachineRunning) return null;
    return {
      ownerMembershipId: grant.ownerMembershipId,
      sessionId: grant.sessionId,
      level: grant.level,
      endpoints: resolver.resolveShared(workspace, grant.ownerMembershipId),
    };
  }, [chat, resolver, rows, workspace]);

  return { rows, open };
}
