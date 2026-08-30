import { useEffect, useRef, useState } from 'react';
import type { SessionFileProvider } from '@/lib/session-file-provider';
import { useLatestRef } from './use-latest-ref';

export type CodeCollabLiveTextUpdate = {
  readonly text: string;
  // Monotonic counter — distinguishes "no update yet" (undefined) from
  // "an update arrived with the same text as before" so consumers can
  // re-trigger downstream effects on identical content if needed.
  readonly seq: number;
};

// Subscribes to `provider.subscribeText` for the currently-open file
// and returns the latest non-local text snapshot. Returns `undefined`
// until the first external commit arrives (the initial open is fetched
// elsewhere via `openFile`). Providers without `subscribeText` (legacy
// / historical) yield `undefined` forever, which
// callers should interpret as "no live text feed, treat the open
// snapshot as authoritative."
//
// Used by the editable Monaco viewer to detect when a provider-level
// refresh/save/conflict resolution publishes a newer text snapshot. The
// viewer then either auto-applies it to a clean buffer or surfaces a
// reload banner for dirty local edits.
export function useCodeCollabLiveText(
  provider: SessionFileProvider | null | undefined,
  pathOrFileId: string | null | undefined,
  options: { readonly enabled?: boolean } = {}
): CodeCollabLiveTextUpdate | undefined {
  const enabled = options.enabled ?? true;
  const [update, setUpdate] = useState<CodeCollabLiveTextUpdate | undefined>();
  const providerRef = useLatestRef(provider);
  const lastTextRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !provider || !pathOrFileId) {
      lastTextRef.current = undefined;
      setUpdate(undefined);
      return undefined;
    }
    lastTextRef.current = undefined;
    const subscribe = provider.subscribeText;
    if (!subscribe) return undefined;
    let seq = 0;
    const unsubscribe = subscribe.call(provider, pathOrFileId, (text) => {
      if (lastTextRef.current === text) return;
      lastTextRef.current = text;
      seq += 1;
      setUpdate({ text, seq });
    });
    return () => {
      unsubscribe();
      lastTextRef.current = undefined;
    };
    // `providerRef` is a stable `useLatestRef` MutableRefObject — its
    // identity never changes across renders, so listing it here is a
    // no-op at runtime but satisfies the exhaustive-deps lint rule.
  }, [enabled, pathOrFileId, provider, providerRef]);

  return update;
}
