import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  acquireWorkspaceCatalog,
  EMPTY_WORKSPACE_CATALOG,
  type WorkspaceCatalogSnapshot,
} from '@/lib/workspace-catalog-room';

/**
 * The workspace document's catalogs. Every consumer in a workspace reads one
 * shared, ref-counted room, so the snapshot object is identity-stable across
 * mounts as well as renders.
 */
export function useWorkspaceCatalog(): WorkspaceCatalogSnapshot {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const [snapshot, setSnapshot] = useState<WorkspaceCatalogSnapshot>(EMPTY_WORKSPACE_CATALOG);

  useEffect(() => {
    if (!runtime) {
      setSnapshot(EMPTY_WORKSPACE_CATALOG);
      return undefined;
    }
    const lease = acquireWorkspaceCatalog(runtime, setSnapshot);
    setSnapshot(lease.snapshot);
    return lease.release;
  }, [runtime]);

  return snapshot;
}
