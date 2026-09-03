/** Page-local runtime instrumentation used by cleanup tests and the probe. */
import { useEffect } from "react";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import type { LodyAtomStore, LodyWorkspaceRuntime } from "./runtime.js";

let liveRepos = 0;

export function lodyLiveRepoCount(): number {
  return liveRepos;
}

export function useTrackLodyRuntimeRepo(store: LodyAtomStore): void {
  useEffect(() => {
    // A retained surface owns at most one live repo. `runtimeAtom` itself may
    // briefly clear while Activity disconnects the route context, even though
    // the surface owner and repo remain mounted. Count the owning surface from
    // its first published runtime until that surface unmounts.
    let ownsRepo = false;
    const sync = (): void => {
      const next = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (next === null || ownsRepo) return;
      ownsRepo = true;
      liveRepos += 1;
    };
    const unsubscribe = store.sub(runtimeAtom, sync);
    sync();
    return () => {
      unsubscribe();
      if (ownsRepo) liveRepos -= 1;
    };
  }, [store]);
}
