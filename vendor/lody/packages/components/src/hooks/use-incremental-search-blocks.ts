import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionHistory } from '@lody/shared';
import { extractSearchBlocksForMessage, type SessionSearchBlock } from '@/lib/session-chat-search';

/** How many messages to process before yielding to the event loop. */
const CHUNK_SIZE = 20;

const EMPTY_BLOCKS: SessionSearchBlock[] = [];

/**
 * Fingerprint a message for change detection.
 * Uses ID + item count so we can detect when a streaming message gets new items appended.
 */
const messageFingerprint = (msg: SessionHistory): string => {
  const items = Array.isArray(msg.items) ? msg.items.length : 0;
  return `${msg.id}:${items}`;
};

type CacheEntry = {
  fingerprint: string;
  blocks: SessionSearchBlock[];
};

/**
 * Incrementally builds session search blocks with three optimizations:
 *
 * 1. **Lazy**: returns empty until `isSearchOpen` is true.
 * 2. **Incremental**: caches per-message blocks; only reprocesses messages
 *    whose fingerprint changed or that are new.
 * 3. **Yielding**: processes messages in chunks, yielding control between
 *    chunks via `setTimeout(0)` so the main thread stays responsive.
 */
export function useIncrementalSearchBlocks(
  sessionHistory: readonly SessionHistory[],
  isSearchOpen: boolean
): SessionSearchBlock[] {
  const [blocks, setBlocks] = useState<SessionSearchBlock[]>(EMPTY_BLOCKS);

  // Per-message cache keyed by message index → { fingerprint, blocks }
  const cacheRef = useRef<CacheEntry[]>([]);
  // Abort handle for in-flight async builds
  const abortRef = useRef<AbortController | null>(null);
  // Track block count from last successful build to detect actual changes
  const lastBuiltLengthRef = useRef(0);

  const buildBlocks = useCallback(
    async (history: readonly SessionHistory[], signal: AbortSignal) => {
      const cache = cacheRef.current;
      let allBlocks: SessionSearchBlock[] = [];
      let anyChanged = false;

      // Shrink cache if history got shorter (e.g. session switch)
      if (cache.length > history.length) {
        cache.length = history.length;
        anyChanged = true;
      }

      for (let i = 0; i < history.length; i++) {
        if (signal.aborted) return;

        const message = history[i]!;
        const fp = messageFingerprint(message);
        const cached = cache[i];

        if (cached && cached.fingerprint === fp) {
          allBlocks.push(...cached.blocks);
        } else {
          const messageBlocks = extractSearchBlocksForMessage(message, i);
          cache[i] = { fingerprint: fp, blocks: messageBlocks };
          allBlocks.push(...messageBlocks);
          anyChanged = true;
        }

        // Yield every CHUNK_SIZE messages to keep the main thread responsive
        if ((i + 1) % CHUNK_SIZE === 0 && i + 1 < history.length) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      if (signal.aborted) return;

      if (anyChanged || allBlocks.length !== lastBuiltLengthRef.current) {
        setBlocks(allBlocks);
        lastBuiltLengthRef.current = allBlocks.length;
      }
    },
    []
  );

  useEffect(() => {
    // Cancel any in-flight build
    abortRef.current?.abort();
    abortRef.current = null;

    if (!isSearchOpen) {
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    void buildBlocks(sessionHistory, controller.signal);

    return () => {
      controller.abort();
    };
  }, [isSearchOpen, sessionHistory, buildBlocks]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return isSearchOpen ? blocks : EMPTY_BLOCKS;
}
