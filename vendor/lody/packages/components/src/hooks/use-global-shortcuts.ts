import { useCallback, useEffect, useState } from 'react';
import type {
  GlobalShortcutBinding,
  GlobalShortcutId,
  SetGlobalShortcutResult,
} from '@lody/shared';
import { getGlobalShortcuts, setGlobalShortcut } from '@/lib/native-global-shortcuts';

/**
 * Reads the current OS-level global shortcuts from the Electron main process and exposes
 * a rebind action. On non-Electron runtimes the list stays empty (the bridge is absent),
 * so callers should only surface the UI when `getRuntime() === 'electron'`.
 */
export function useGlobalShortcuts() {
  const [shortcuts, setShortcuts] = useState<GlobalShortcutBinding[]>([]);

  const refresh = useCallback(async () => {
    setShortcuts(await getGlobalShortcuts());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBinding = useCallback(
    async (id: GlobalShortcutId, binding: string | null): Promise<SetGlobalShortcutResult> => {
      const result = await setGlobalShortcut(id, binding);
      // Re-read on success so the row reflects the persisted binding; on failure the
      // main process kept the old binding, so the stale value we still show is correct.
      if (result.ok) await refresh();
      return result;
    },
    [refresh]
  );

  return { shortcuts, setBinding, refresh };
}
