import { useCallback, useEffect, useState } from 'react';

/** What a workspace is connected to, held locally so a press shows at once.
 *
 * The list arrives as a prop off the workspace poll, which trails a Connect by
 * up to five seconds. Re-seeding on the prop's CONTENT, not on every poll,
 * is what lets the optimistic press survive until the server agrees: an
 * unchanged list re-renders without touching local state, and a changed one is
 * the server's newer answer. */
export function useConnectedProviders(
  serverConnections: readonly string[],
): [readonly string[], (name: string, connected: boolean) => void] {
  const [local, setLocal] = useState<readonly string[]>(serverConnections);
  // A space, because a provider name never holds one: the control plane admits
  // letters, digits, dot, dash and underscore, so the key splits back cleanly.
  const serverKey = serverConnections.join(' ');
  // The key is the dependency, not the array: the poll hands back a new array
  // every five seconds, and depending on the array would undo an optimistic
  // press before the server had answered.
  useEffect(() => {
    setLocal(serverKey === '' ? [] : serverKey.split(' '));
  }, [serverKey]);
  const note = useCallback((name: string, connected: boolean) => {
    setLocal((current) => (connected
      ? (current.includes(name) ? current : [...current, name])
      : current.filter((entry) => entry !== name)));
  }, []);
  return [local, note];
}
