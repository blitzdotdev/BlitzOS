import { useEffect, useState } from 'react';

/** Which provider row `blitz connections open <provider>` pointed at, and when
 * the box raised it (`requestedAt`, so the same provider asked for twice is a
 * new target). */
export type ConnectionsFocusTarget = {
  workspaceId: string;
  provider: string;
  version: number;
};

/**
 * The one hop between the shell, which reads the box's `connections-focus`
 * marker, and the Connections tab, which highlights the row it names.
 *
 * WHY IT IS NOT A PROP. The tab lives inside the workspace-details dialog, and
 * the shell mounts that dialog through `shell/ShellDialogs`, which carries the
 * dialog's own props and nothing per-tab. Threading one through would make
 * every host of the dialog carry a provider name it has no other use for.
 *
 * WHY THE LATEST TARGET IS RETAINED, not just dispatched. The shell publishes
 * the target and opens the dialog in the same event, so the tab MOUNTS AFTER
 * the publish: a subscriber that attached on mount would never see the event
 * that opened it. Reading the retained target at mount is what makes the
 * marker land on the provider rather than on the list.
 */
let latest: ConnectionsFocusTarget | null = null;
const listeners = new Set<(target: ConnectionsFocusTarget) => void>();

export function publishConnectionsFocus(target: ConnectionsFocusTarget): void {
  latest = target;
  for (const listener of [...listeners]) listener(target);
}

/** Test seam: a target retained from a previous case is a row highlighted in
 * the next one. */
export function clearConnectionsFocus(): void {
  latest = null;
}

/** The target for one workspace, or null. A target raised by another
 * workspace's box is not this workspace's row. */
export function useConnectionsFocusTarget(
  workspaceId: string,
): ConnectionsFocusTarget | null {
  const [target, setTarget] = useState<ConnectionsFocusTarget | null>(
    () => (latest !== null && latest.workspaceId === workspaceId ? latest : null),
  );
  useEffect(() => {
    const listener = (next: ConnectionsFocusTarget) => {
      if (next.workspaceId === workspaceId) setTarget(next);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [workspaceId]);
  return target;
}
