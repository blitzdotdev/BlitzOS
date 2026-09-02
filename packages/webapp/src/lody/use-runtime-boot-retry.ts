/**
 * Rebuilds the workspace runtime when its one-shot boot failed against a box
 * that was not ready yet.
 *
 * THE HOLE THIS FILLS. `RuntimeProvider` creates the runtime once
 * (`vendor/lody/packages/components/src/providers/runtime-provider.tsx:255`),
 * and its catch does this:
 *
 *     setRuntime(null);
 *     setControlConnectionState('error');
 *
 * and then nothing. Its dependency list holds the workspace slug, the workspace
 * id and a flag that only Electron's `dual` sync mode moves, so on a browser
 * against a box there is no input left that can change and no second attempt.
 * A freshly provisioned workspace is exactly where that bites: the gateway
 * comes up minutes before the ~300 MB session daemon behind it, the boot lands
 * in the gap, and `runtimeAtom` stays `null` for the lifetime of the tab.
 * `LodyAgentConfigGate.run` returns at its first line for good and the member
 * reads "Starting sessions on this workspace…" forever — while a terminal in
 * the same rail opens instantly, because ttyd never needed the daemon.
 *
 * WHY A REMOUNT AND NOT A PATCH. `vendor/lody/BLITZ-PATCHES.md`: "nothing in
 * `vendor/lody` is edited except at a declared seam… stub around it from there
 * — do not patch the vendor tree." A changing `key` is the React-level way to
 * ask a component to do its one-shot work again, and it costs nothing here
 * because the thing being discarded is a runtime that failed to build.
 *
 * WHY IT WATCHES TWO ATOMS AND NOT ONE. `error` alone is the wrong trigger:
 * the same atom carries a live connection dropping, and remounting the runtime
 * on every websocket blip would throw away good local state to fix nothing.
 * The boot failure is the one that ALSO leaves `runtimeAtom` null — a runtime
 * that exists and lost its socket is the vendored reconnect path's business,
 * not ours. Both conditions together name exactly the latch and nothing else.
 *
 * WHY IT NEVER GIVES UP. A retry budget would be a third latch of the same
 * shape as the two this change removed: it would decide, at a fixed moment,
 * that a box which is merely slow is a box that is never coming. The interval
 * grows instead, so a daemon that needs three minutes is waited out at the same
 * cost as one that needs thirty seconds.
 */
import { useEffect, useState } from "react";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { lodyControlConnectionStateAtom } from "@lody/components/atoms/control-connection";
import { boxGatewayHealth, subscribeBoxGatewayHealth } from "../box-gateway-health.js";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";

/**
 * The wait before each rebuild, and the ceiling it settles at.
 *
 * The first two are short because the overwhelmingly common cause is a daemon
 * that is seconds from listening, and a member watching a new workspace should
 * not have to earn the surface by waiting. It flattens at 30 s — the interval
 * `box-gateway-health` already spends on a box it believes is cold — so a
 * workspace whose daemon never arrives costs two rebuilds a minute forever
 * rather than a tightening spin.
 */
export const RUNTIME_BOOT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000];

/**
 * How long a rebuilt provider is given to reach a verdict before this hook
 * looks at the atoms itself.
 *
 * Two seconds: longer than the local IndexedDB repo takes to open on a healthy
 * box, so a boot that is going to work is never judged mid-flight, and short
 * enough that a rebuild which failed silently is not sat on. It is a backstop,
 * not the mechanism — the provider's own state change is what normally wakes
 * the loop.
 */
const REBUILD_SETTLE_MS = 2_000;

/** The wait before rebuild number `attempt`, clamped to the ceiling. Exported
 * so a test names the same delay this hook will use rather than restating it. */
export function runtimeBootRetryDelayMs(attempt: number): number {
  const last = RUNTIME_BOOT_RETRY_DELAYS_MS.length - 1;
  // SAFETY: `RUNTIME_BOOT_RETRY_DELAYS_MS` is a non-empty literal above and the
  // index is clamped to its bounds, so this element exists.
  return RUNTIME_BOOT_RETRY_DELAYS_MS[Math.min(attempt, last)] as number;
}

/**
 * A generation counter to hang on `<RuntimeProvider key={...}>`.
 *
 * Starts at 0 and only ever grows, so the provider mounts once on a healthy box
 * and is rebuilt once per failed boot after that.
 */
export function useLodyRuntimeBootRetry(store: LodyAtomStore, machineId: string | null): number {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (machineId === null) return undefined;
    let attempt = 0;
    let timer: number | undefined;

    const clear = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const read = (): void => {
      const runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      // A runtime that exists is a boot that worked, whatever its socket is
      // doing. Forget the backoff — the next failure is a new outage, not the
      // continuation of this one — and drop any rebuild still pending, because
      // tearing down a runtime that just arrived is the opposite of the job.
      if (runtime !== null) {
        attempt = 0;
        clear();
        return;
      }
      // Any other state is a boot in progress. Stand down and let it finish;
      // a rebuild under a live attempt would restart the very thing being
      // waited for. The backoff is kept, so if this attempt also ends in
      // `error` the next wait is the longer one.
      if (store.get(lodyControlConnectionStateAtom) !== "error") {
        clear();
        return;
      }
      // AND ONLY WHERE A REBUILD COULD PLAUSIBLY SUCCEED.
      //
      // Without this the loop retries into the void: a member who holds no
      // machine here, a read-only shared surface, a workspace whose box is
      // gone — every one of them sits on `error` with a null runtime forever,
      // and this would tear down and rebuild a heavy provider every few
      // seconds for as long as the tab is open. Measured, not feared: it made
      // `lody-tab-selection-sync` 28% slower and pushed six of its cases over
      // their deadline under full-suite load.
      //
      // Reachability is the evidence, and it is the same signal latches 1 and 2
      // now consult. `reachable` means bytes came back FROM THE BOX, which is
      // exactly the condition under which "the daemon is still starting" is a
      // live hypothesis. This is NOT a budget — it never decides that a box
      // which is merely slow is a box that is never coming; it only declines to
      // rebuild against an address nothing is answering. The subscription below
      // wakes the loop the moment that changes.
      if (boxGatewayHealth() !== "reachable") {
        clear();
        return;
      }
      // One rebuild in flight at a time.
      if (timer !== undefined) return;
      const delay = runtimeBootRetryDelayMs(attempt);
      attempt += 1;
      timer = window.setTimeout(() => {
        timer = undefined;
        setGeneration((previous) => previous + 1);
        // AND LOOK AGAIN ON OUR OWN CLOCK. The rebuilt provider normally moves
        // this atom through `idle` and back, which re-enters here through the
        // subscription — but a rebuild that fails without changing either atom
        // would leave no event to wake on, and the retry would stall exactly
        // the way the one-shot boot does. Depending on someone else's state
        // change to keep a recovery loop alive is the shape of bug this file
        // exists to remove, so the loop drives itself.
        timer = window.setTimeout(() => {
          timer = undefined;
          read();
        }, REBUILD_SETTLE_MS);
      }, delay);
    };

    const unsubscribeState = store.sub(lodyControlConnectionStateAtom, read);
    const unsubscribeRuntime = store.sub(runtimeAtom, read);
    // The third input, and the one that turns the guard above from a refusal
    // into a wait: a box that starts answering is exactly when a failed boot
    // becomes worth retrying.
    const unsubscribeHealth = subscribeBoxGatewayHealth(read);
    read();
    return () => {
      clear();
      unsubscribeState();
      unsubscribeRuntime();
      unsubscribeHealth();
    };
    // KEYED ON THE BOX. A different machine is a different boot with its own
    // budget; `generation` is deliberately absent, so the backoff survives the
    // remounts this hook itself causes.
  }, [store, machineId]);

  return generation;
}
