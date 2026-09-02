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
    let tracked: LodyWorkspaceRuntime | null = null;
    const sync = (): void => {
      const next = store.get<LodyWorkspaceRuntime | null>(runtimeAtom);
      if (next === tracked) return;
      if (tracked !== null) liveRepos -= 1;
      tracked = next;
      if (tracked !== null) liveRepos += 1;
    };
    const unsubscribe = store.sub(runtimeAtom, sync);
    sync();
    return () => {
      unsubscribe();
      if (tracked !== null) liveRepos -= 1;
    };
  }, [store]);
}
