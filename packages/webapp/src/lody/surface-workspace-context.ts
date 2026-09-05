/** Keeps the runtime's workspace scope alive above React Activity. */
import { setWorkspaceContextAtom } from "@lody/components/atoms/workspace-context";
import type { LodyAtomStore } from "./runtime.js";

export interface LodySurfaceWorkspaceSnapshot {
  workspace: { slug: string | null; workspaceId: string };
}

/**
 * This owner lives above Activity and holds the daemon identity until the whole
 * surface is evicted.
 */
export function seedLodySurfaceWorkspaceContext(
  store: LodyAtomStore,
  snapshot: LodySurfaceWorkspaceSnapshot,
): () => void {
  const slug = snapshot.workspace.slug ?? "local";
  const workspaceId = snapshot.workspace.workspaceId;
  store.set(setWorkspaceContextAtom, { slug, workspaceId });
  return () => {
    store.set(setWorkspaceContextAtom, { slug: null, workspaceId: null });
  };
}
