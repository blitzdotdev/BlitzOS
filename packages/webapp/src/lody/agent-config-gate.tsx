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
} from "./local-projects.js";
import {
  applyDefaultSessionProject,
  createDefaultSessionProjectResolver,
} from "./workdir-default.js";
import type { LodyAtomStore, LodyRuntimeEndpoints, LodyWorkspaceRuntime } from "./runtime.js";

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
 * one room round trip; the rail is NOT gated, so the surface is never blank.
 *
 * IT OPENS ON FAILURE. A bootstrap that throws still lets the member through to
 * whatever configs the daemon already has: blanking the surface forever would
 * be a worse failure than the one being prevented.
 */
export function LodyAgentConfigGate(props: {
  store: LodyAtomStore;
  machineId: string;
  endpoints: LodyRuntimeEndpoints;
  children: ReactNode;
}) {
  const { store, machineId, endpoints } = props;
  const [ready, setReady] = useState(false);
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
    const resolveDefaultProject = createDefaultSessionProjectResolver(
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
      const withDefaults = applyDefaultSessionProject(runtime, resolveDefaultProject);
      if (withDefaults !== runtime) {
        store.set(runtimeAtom, withDefaults);
        return;
      }
      started = runtime;
      void (async () => {
        await bootstrapLodyAgentConfigs(store, runtime, machineId);
        // The gate opens HERE, not at the end: everything below is about what
        // the composer offers, not about whether a send can resolve its config.
        open();
        // Before anything can be archived: the daemon's archive path reads the
        // legacy `machineMeta.localProjects` field and the box's registrar only
        // ever writes the Flock row, so without this mirror a worktree session
        // archives into nothing and leaves the member's uncommitted work on
        // disk. See `local-projects.ts` for the upstream anchor.
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
  return ready ? props.children : null;
}
