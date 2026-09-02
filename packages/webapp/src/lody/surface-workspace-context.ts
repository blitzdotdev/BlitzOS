/** Keeps the runtime's workspace scope alive above React Activity. */
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtom,
} from "@lody/components/atoms/workspace-context";
import type { LodyAtomStore } from "./runtime.js";

export interface LodySurfaceWorkspaceSnapshot {
  workspace: { slug: string | null; workspaceId: string };
}

/**
 * The vendored route publishes this pair for RuntimeProvider, but Activity
 * destroys that route effect while hidden and its cleanup clears both atoms.
 * This owner lives above Activity and restores the daemon identity in the same
 * Jotai transaction until the whole surface is actually evicted.
 */
export function seedLodySurfaceWorkspaceContext(
  store: LodyAtomStore,
  snapshot: LodySurfaceWorkspaceSnapshot,
): () => void {
  const slug = snapshot.workspace.slug ?? "local";
  const workspaceId = snapshot.workspace.workspaceId;
  const repair = (): void => {
    if (
      store.get(currentWorkspaceSlugAtom) !== slug
      || store.get(currentWorkspaceIdAtom) !== workspaceId
    ) {
      store.set(setWorkspaceContextAtom, { slug, workspaceId });
    }
  };
  repair();
  const releaseSlug = store.sub(currentWorkspaceSlugAtom, repair);
  const releaseId = store.sub(currentWorkspaceIdAtom, repair);
  return () => {
    releaseSlug();
    releaseId();
  };
}
