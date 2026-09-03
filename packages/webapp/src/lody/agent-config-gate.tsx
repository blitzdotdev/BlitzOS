/**
 * The agent-config bootstrap, and the gate it holds over the chat surface
 * (plans/LODY-RUNTIME-DESIGN.md §12.2).
 *
 * Its own module rather than a component inside `SessionSurface.tsx` for one
 * reason: it is the fix for a race, and a race needs a test that can drive it
 * without the vendored chat pages, Monaco, and the 3.5 MB of renderer those
 * pull in. Everything here reads one atom and our own seam.
 *
 * It also owns the one thing that has to be true of the runtime BEFORE a
 * session can be started: a chat with no repo picked must work in `/workspace`
 * (`workdir-default.ts`). That belongs here and not in `runtime.ts` because the
 * product surface does not build its runtime there — their `RuntimeProvider`
 * does, and this is the only place of ours that holds the atom it writes.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { bootstrapLodyAgentConfigs, refreshLodyAcpCapabilities } from "./agent-configs.js";
import {
  mirrorLocalProjectsToMachineMeta,
  publishBoxReposAsWorkspaceRepos,
  registerWorkspaceRepositories,
} from "./local-projects.js";
import { applyDefaultSessionProject, createSessionProjectDefaults } from "./workdir-default.js";
import type { LodyAtomStore, LodyRuntimeEndpoints, LodyWorkspaceRuntime } from "./runtime.js";

/**
 * How long a boot may take before the gate stops calling itself slow.
 *
 * NOT A POLICY NUMBER. It is the vendored provider's own
 * `META_FIRST_SYNC_TIMEOUT_MS` (`providers/create-workspace-runtime.ts:207`, a
 * module-private `120_000`), which is the longest a legitimate first boot can
 * take: the runtime this gate waits on cannot be published later than its own
 * first-sync wait allows. Restated rather than imported because the seam does
 * not export it. Before it elapses "starting" is the truth; after it, the boot
 * is not slow, it is over.
 *
 * It gates the WORDING and the reload button, never the children — a deadline
 * that opened the gate would put the composer back in the window this whole
 * file exists to close.
 */
export const SURFACE_BOOT_DEADLINE_MS = 120_000;

/**
 * Boxes whose bootstrap has already SUCCEEDED this page lifetime, so a revisit
 * opens the gate at once instead of holding the surface behind the same round
 * trips again.
 *
 * WHY THIS IS SAFE WHERE A SNAPSHOT CACHE WOULD NOT BE. The key is the box's
 * own IDENTITY — machineId and `lw_` workspace id, both minted by the daemon —
 * not its URL. A rescue reboot that wipes the daemon's data dir mints a new
 * identity at the same URL, so the rebuilt box MISSES this cache and gets the
 * full gated bootstrap; nothing here can pin a surface to a dead identity (the
 * exact class seam patch 17 closed). And the rows the gate exists to guarantee
 * are durable on the daemon: a bootstrap that pushed once this page lifetime
 * has nothing left to win by blocking the composer a second time.
 *
 * The bootstrap still RUNS on a revisit — in the background, behind the open
 * gate — because it is idempotent by construction (`agent-configs.ts`) and the
 * gate already opens on its failure. Only success is remembered.
 */
const settledBootstraps = new Set<string>();

function bootstrapMemoKey(machineId: string, workspaceId: string): string {
  return `${machineId} ${workspaceId}`;
}

export function resetAgentConfigGateMemoForTests(): void {
  settledBootstraps.clear();
}

/**
 * Runs the agent-config bootstrap once the runtime is live, and HOLDS THE CHAT
 * SURFACE BACK until the daemon has the rows (plans/LODY-RUNTIME-DESIGN.md §12).
 *
 * Keyed on the runtime instance rather than run at mount: `RuntimeProvider`
 * creates the runtime asynchronously and re-creates it whenever the workspace
 * changes, and the configs live in that runtime's machine Flock room. It is
 * cheap to repeat and idempotent by construction (`agent-configs.ts`), so a
 * re-run after a reconnect is a no-op rather than a duplicate row.
 *
 * WHY IT IS A GATE AND NOT JUST AN EFFECT. Phase 3 rendered the router beside
 * this, so the chat landing was live while the bootstrap was still in flight,
 * and a member could send in that window. Two different things went wrong there
 * and both are the canary finding:
 *
 * - With NO row yet, `handleSubmit` refuses at
 *   `chat-landing.tsx:2922` with "Choose an agent before starting" — the send
 *   button is not disabled while configs load (`getChatLandingSubmitDisabled`
 *   has no agent-config term) and the Enter path does not even consult it.
 * - With the row written LOCALLY but not yet on the daemon, the session
 *   dispatches naming a config the daemon cannot resolve, and the launch
 *   resolver fails open with no `runtimeOverrides` — the managed claude runtime
 *   instead of the box shim, and `acp_auth_required` on the first reply.
 *
 * `bootstrapLodyAgentConfigs` now pushes before it resolves, so awaiting it here
 * closes both. The cost is first-mount latency on the chat surface, measured in
 * one room round trip.
 *
 * IT OPENS ON FAILURE. A bootstrap that throws still lets the member through to
 * whatever configs the daemon already has: blanking the surface forever would
 * be a worse failure than the one being prevented.
 *
 * AND IT NEVER RENDERS NOTHING (the fresh-box finding, 2026-09-01). The version
 * that returned `null` while shut reasoned that "the rail is NOT gated, so the
 * surface is never blank" — but the rail is not the surface. The rail is a
 * PORTAL raised in `SessionSurface` ABOVE this gate, so on a box whose daemon
 * had not finished starting the member got a live rail over a completely empty
 * content area: no landing composer, no tab strip, no message, forever.
 * Reproduced against canary on a real Chromium by stalling `/lody/sync` alone —
 * `/lody/platform` is answered by the bridge, so the capability probe reads
 * `present`, `SessionSurface` mounts, the rail draws, and every one of the
 * gate's two awaits below is left hanging with nothing to log and no fallback.
 *
 * Two hangs reach it and neither is an error anyone can catch:
 *
 * - `runtimeAtom` never gets a runtime, because their `RuntimeProvider` boots
 *   once and does not retry. `run` returns at its first line for good.
 * - `openFlockDoc` or `flockRowPutIfAbsent` never settles. A REJECTION is fine
 *   — the `catch` below opens the gate — but a promise that never answers is
 *   not a rejection.
 *
 * So the shut state is a rendered state now: it says the surface is starting,
 * and past {@link SURFACE_BOOT_DEADLINE_MS} it says so is no longer true and
 * offers the reload the member would otherwise have had to guess at. What it
 * must never be again is empty.
 */
export function LodyAgentConfigGate(props: {
  store: LodyAtomStore;
  machineId: string;
  endpoints: LodyRuntimeEndpoints;
  children: ReactNode;
}) {
  const { store, machineId, endpoints } = props;
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  // KEYED ON THE BOX, NOT ON THE OBJECT (wave 3, ADJ2).
  //
  // `endpoints` is a fresh literal on every render of the shell — `CloudApp`
  // re-renders on a keystroke, a poll and a tab switch — so an effect keyed on
  // its identity tore this subscription down and re-ran the whole bootstrap
  // each time: a Flock round trip, a machine-meta mirror, a project publish and
  // an ACP capability sweep per shell render. What the effect actually depends
  // on is WHICH BOX it is talking to, and `projectUrl` names exactly that. The
  // object itself travels through a ref, so the run always uses the current one.
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;
  const { projectUrl } = endpoints;
  useEffect(() => {
    let cancelled = false;
    let started: LodyWorkspaceRuntime | null = null;
    const aborter = new AbortController();
    const open = (): void => {
      if (!cancelled) setReady(true);
    };
    const sessionProjectDefaults = createSessionProjectDefaults(
      endpoints,
      machineId,
      endpoints.filesRoot,
    );
    const run = (): void => {
      const runtime = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (runtime === null || cancelled || runtime === started) return;
      // BEFORE anything else, and before a session can be started: a chat with
      // no repo picked has to be told it works in `/workspace`, or the daemon
      // runs it in its own chat-storage directory and every relative file chip
      // in that session opens on nothing (`workdir-default.ts`). The runtime
      // this surface uses is built by their `RuntimeProvider`, so the writer is
      // decorated by swapping the atom's value rather than at construction.
      // This re-enters through the subscription with the decorated runtime,
      // which `applyDefaultSessionProject` returns unchanged — so the bootstrap
      // below runs once, on the runtime the composer will actually write with.
      const withDefaults = applyDefaultSessionProject(runtime, sessionProjectDefaults);
      if (withDefaults !== runtime) {
        store.set(runtimeAtom, withDefaults);
        return;
      }
      started = runtime;
      // A box this page has already bootstrapped opens at once; the re-run
      // below is background belt-and-braces. See `settledBootstraps`.
      const memoKey = bootstrapMemoKey(machineId, runtime.workspaceId);
      if (settledBootstraps.has(memoKey)) open();
      void (async () => {
        await bootstrapLodyAgentConfigs(store, runtime, machineId);
        settledBootstraps.add(memoKey);
        // The gate opens HERE, not at the end: everything below is about what
        // the composer offers, not about whether a send can resolve its config.
        open();
        // Every `/workspace` repository the box has not registered yet, before
        // the mirror below publishes the set to the picker. The box's own
        // registrar is the durable half and needs a box image to change; this
        // is the half a deploy can fix, and the half that runs at the moment the
        // member is about to pick a project. See `local-projects.ts`.
        await registerWorkspaceRepositories(
          endpointsRef.current,
          machineId,
          runtime.workspaceId,
          endpoints.filesRoot,
        );
        // Before anything can be archived: the daemon's archive path reads the
        // legacy `machineMeta.localProjects` field and the box's registrar only
        // ever writes the Flock row, so without this mirror a worktree session
        // archives into nothing and leaves the member's uncommitted work on
        // disk. It is ALSO the only field the composer's project picker reads,
        // so this is what puts the repos registered above on that list. See
        // `local-projects.ts` for both upstream anchors.
        await mirrorLocalProjectsToMachineMeta(runtime, machineId);
        // And before a worktree session can be created at all: the landing
        // drops `githubRepoFullName` from a session's ProjectRef unless the
        // name is in the workspace's connected-repo list, and without that
        // field the session is a chat to the rail and to the daemon's diff
        // stats alike. See `local-projects.ts`.
        await publishBoxReposAsWorkspaceRepos(store, endpointsRef.current, runtime, machineId);
        // Second, and only after the rows exist: the capabilities pass keys off
        // them. A config that fails to report costs the composer that agent's
        // selectors and nothing else, so it is warned about rather than raised
        // — the same call upstream's own pass makes (`:2477`).
        await refreshLodyAcpCapabilities(runtime, machineId, {
          signal: aborter.signal,
          onError: (cause, configId) => {
            console.warn("lody: ACP capability refresh failed", { configId, cause });
          },
        });
      })().catch((cause: unknown) => {
        // Warned, not raised. A member whose agent configs failed to seed can
        // still open a session against a config the daemon already has; blanking
        // the surface would take that away too.
        if (!cancelled) console.warn("lody: agent-config bootstrap failed", cause);
        open();
      });
    };
    const unsubscribe = store.sub(runtimeAtom, run);
    run();
    return () => {
      cancelled = true;
      aborter.abort();
      unsubscribe();
    };
  }, [store, machineId, projectUrl]);

  // The deadline runs only while the gate is shut, and it is torn down the
  // moment it opens: a surface that is already live has nothing to report.
  useEffect(() => {
    if (ready) return undefined;
    const timer = setTimeout(() => {
      // The one line the next round of this bug gets to read. Neither hang
      // raises anything, so without it the console of a blank surface is
      // indistinguishable from the console of a healthy one.
      console.warn("lody: the session surface did not finish starting", {
        machineId,
        afterMs: SURFACE_BOOT_DEADLINE_MS,
      });
      setStalled(true);
    }, SURFACE_BOOT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [machineId, ready]);

  if (ready) return props.children;
  return <LodySurfaceStarting stalled={stalled} />;
}

/**
 * What the content area says while the gate is shut.
 *
 * It fills the surface rather than banding it, because while the gate is shut
 * it IS the surface: `.lody-surface > *` gives every child the pane's height,
 * which is the treatment `.lody-surface__notice` already carries for the
 * unavailable-sessions message beside it.
 */
function LodySurfaceStarting({ stalled }: { stalled: boolean }) {
  if (!stalled) {
    return (
      <div className="lody-surface__notice" role="status">
        Starting sessions on this workspace…
      </div>
    );
  }
  return (
    <div className="lody-surface__notice" role="alert">
      <p className="lody-surface__notice-title">Sessions did not finish starting</p>
      <p>
        This workspace is running, but its session daemon has not answered yet. Reload
        to start it again.
      </p>
      <button
        type="button"
        className="lody-surface__notice-action"
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  );
}
