/**
 * "This session was opened" — the seam that heals a session created before the
 * default project existed (`workdir-default.ts` §3).
 *
 * WHY THE ADDRESS AND NOT THE WRITER. §2's seam is
 * `LodyWorkspaceWriter.startSession`, because creating a session IS a write. An
 * OPEN is not a write at all: a member who opens a broken session and reads it
 * never writes anything, and that member is exactly the one the report is about.
 * The one place an open is observable is the surface's resolved address —
 * `SessionSurface` already subscribes to it for the rail highlight — so that is
 * what drives this. It fires once per open, it names the session, and every
 * repeat is absorbed one level down by `createSessionProjectBackfiller`.
 *
 * WHY IT ALSO WATCHES THE SESSION'S META. The address can resolve before the
 * document does: on a page load that lands straight on a session, the runtime is
 * still syncing when the route settles, and a meta that has not arrived is a
 * session this must not touch. `sessionMetaAtomFamily` is the cache the rail and
 * the session page already read (filled by `docMetaSubscriptionAtom`, which
 * `RuntimeProvider` mounts), so its change event is the signal that the document
 * landed — a subscription rather than a poll. Our own write fires it once more,
 * and that repeat ends against the settled decision.
 *
 * A GRANTEE NEVER WRITES. `shared` means this surface is mounted against another
 * member's box for one session they shared (plans/LODY-SHARING.md §10.2), and
 * that session's meta belongs to its owner: the workspace root a grantee would
 * name is a path on somebody else's machine, chosen by somebody else's product
 * decision. So the whole hook is inert there — the same rule that keeps the
 * agent-config bootstrap off a shared surface.
 */
import { useEffect, useMemo, useRef } from "react";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { sessionMetaAtomFamily } from "@lody/components/atoms/doc-meta";
import { getSessionRoomId } from "@lody/shared";
import {
  createDefaultSessionProjectResolver,
  createSessionProjectBackfiller,
} from "./workdir-default.js";
import type { LodyAtomStore, LodyRuntimeEndpoints, LodyWorkspaceRuntime } from "./runtime.js";

export interface SessionProjectBackfillInput {
  store: LodyAtomStore;
  endpoints: LodyRuntimeEndpoints;
  /** `null` until `/lody/platform` answers. */
  machineId: string | null;
  /** The session the surface is showing, or `null` on the chat landing. */
  sessionId: string | null;
  /** This surface is mounted against another member's box. */
  shared: boolean;
}

export function useDefaultSessionProjectBackfill(input: SessionProjectBackfillInput): void {
  const { store, machineId, sessionId, shared } = input;
  // KEYED ON THE BOX, NOT ON THE OBJECT, for the reason `agent-config-gate.tsx`
  // states: `endpoints` is a fresh literal on every render of the shell, and a
  // memo keyed on its identity would build a new registrar per keystroke.
  const endpointsRef = useRef(input.endpoints);
  endpointsRef.current = input.endpoints;
  const { projectUrl, filesRoot } = input.endpoints;
  const backfill = useMemo(
    () =>
      machineId === null
        ? null
        : createSessionProjectBackfiller(
            createDefaultSessionProjectResolver(endpointsRef.current, machineId, filesRoot),
          ),
    [machineId, projectUrl, filesRoot],
  );
  useEffect(() => {
    if (backfill === null || sessionId === null || shared) return undefined;
    let cancelled = false;
    const run = (): void => {
      const runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (runtime === null || cancelled) return;
      void backfill(runtime, sessionId).catch((cause: unknown) => {
        // Warned, not raised. A session that could not be repaired is the
        // session the member already has; taking the surface down would be a
        // worse answer than the missing Files tab.
        console.warn("lody: session project backfill failed", { sessionId, cause });
      });
    };
    run();
    const unsubscribeRuntime = store.sub(runtimeAtom, run);
    const unsubscribeMeta = store.sub(sessionMetaAtomFamily(getSessionRoomId(sessionId)), run);
    return () => {
      cancelled = true;
      unsubscribeRuntime();
      unsubscribeMeta();
    };
  }, [store, backfill, sessionId, shared]);
}
