import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseCodeCollabLspResult,
  type CodeCollabLspLocation,
  type CodeCollabLspResult,
} from '@/lib/code-collab-lsp-result';
import { hasSessionFileLspProvider, type SessionFileProvider } from '@/lib/session-file-provider';
import { useLatestRef } from './use-latest-ref';

export type { CodeCollabLspLocation, CodeCollabLspResult };

export type CodeCollabLspState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly action: 'definition' | 'references' }
  | {
      readonly kind: 'result';
      readonly action: 'definition' | 'references';
      readonly result: CodeCollabLspResult;
    }
  | {
      readonly kind: 'error';
      readonly action: 'definition' | 'references';
      readonly message: string;
    };

export type UseCodeCollabLspInput = {
  readonly provider: SessionFileProvider | null | undefined;
  readonly fileId: string | null | undefined;
  readonly enabled: boolean;
};

export type UseCodeCollabLspResult = {
  readonly state: CodeCollabLspState;
  readonly onGoToDefinition: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly onFindReferences: (position: {
    readonly line: number;
    readonly character: number;
  }) => void;
  readonly dismiss: () => void;
};

export function useCodeCollabLsp(input: UseCodeCollabLspInput): UseCodeCollabLspResult {
  const { provider, fileId, enabled } = input;
  const providerRef = useLatestRef(provider);
  const fileIdRef = useLatestRef(fileId);

  const [state, setState] = useState<CodeCollabLspState>({ kind: 'idle' });
  // Monotonic request token: every `fire` increments and captures it.
  // The completion path checks the captured token against the current
  // value and drops its setState if a newer request (or a fileId switch
  // / unmount that incremented the token) has happened in the meantime.
  // This both avoids stale-result overwrites and silences React's
  // "state update on unmounted" warning when the user navigates away —
  // the unmount cleanup below bumps the token, which invalidates every
  // in-flight request without needing a separate mounted flag.
  const requestTokenRef = useRef(0);

  const fire = useCallback(
    (
      action: 'definition' | 'references',
      position: { readonly line: number; readonly character: number }
    ) => {
      if (!enabled) return;
      const currentProvider = providerRef.current;
      const currentFileId = fileIdRef.current;
      if (!hasSessionFileLspProvider(currentProvider) || !currentFileId) return;
      requestTokenRef.current += 1;
      const myToken = requestTokenRef.current;
      const apply = (next: CodeCollabLspState) => {
        if (requestTokenRef.current !== myToken) return;
        setState(next);
      };
      apply({ kind: 'pending', action });
      void (async () => {
        try {
          const fn =
            action === 'definition'
              ? currentProvider.requestLspDefinition
              : currentProvider.requestLspReferences;
          const raw = await fn.call(currentProvider, currentFileId, position);
          const parsed = parseCodeCollabLspResult(raw);
          if (!parsed) {
            apply({ kind: 'error', action, message: 'Malformed LSP response' });
            return;
          }
          apply({ kind: 'result', action, result: parsed });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          apply({ kind: 'error', action, message });
        }
      })();
    },
    // `providerRef` / `fileIdRef` are stable `useLatestRef`
    // MutableRefObjects — listing them is a no-op at runtime but
    // satisfies the exhaustive-deps lint rule, which can't detect
    // ref stability through a custom hook return value.
    [enabled, providerRef, fileIdRef]
  );

  const onGoToDefinition = useCallback(
    (position: { readonly line: number; readonly character: number }) =>
      fire('definition', position),
    [fire]
  );
  const onFindReferences = useCallback(
    (position: { readonly line: number; readonly character: number }) =>
      fire('references', position),
    [fire]
  );
  const dismiss = useCallback(() => {
    requestTokenRef.current += 1;
    setState({ kind: 'idle' });
  }, []);

  // Reset state + invalidate any in-flight request when the targeted
  // file changes. The token increment guarantees the late response from
  // the previous fileId is discarded.
  useEffect(() => {
    requestTokenRef.current += 1;
    setState({ kind: 'idle' });
  }, [fileId, provider]);

  useEffect(() => {
    return () => {
      requestTokenRef.current += 1;
    };
  }, []);

  return { state, onGoToDefinition, onFindReferences, dismiss };
}
