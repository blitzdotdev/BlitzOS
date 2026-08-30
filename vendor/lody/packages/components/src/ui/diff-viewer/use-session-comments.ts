'use client';

import { useState, useCallback, useMemo } from 'react';
import type { DiffLineAnnotation } from '@pierre/diffs';
import type {
  CommentAnnotationMeta,
  CommentAnchor,
  GitHubReviewThread,
  DiffCommentSide,
} from './session-comment-types';

interface UseSessionCommentsOptions {
  /** File path for this diff viewer */
  path: string;
  /** GitHub review threads for this file */
  githubThreads?: GitHubReviewThread[];
  /** Whether comments are enabled */
  commentsEnabled?: boolean;
  /** Turn ID for conversation mode */
  turnId?: string;
  /** Diff mode */
  mode?: 'conversation' | 'base';
}

export interface DraftState {
  anchor: CommentAnchor;
}

interface UseSessionCommentsResult {
  /** Line annotations to pass to @pierre/diffs */
  lineAnnotations: DiffLineAnnotation<CommentAnnotationMeta>[];
  /** Current draft state */
  draft: DraftState | null;
  /** Currently hovered line info */
  hoveredLine: { side: DiffCommentSide; lineNumber: number } | null;
  /** Start a new comment draft at the given anchor */
  startDraft: (side: DiffCommentSide, lineNumber: number, lineContent?: string) => void;
  /** Cancel the current draft */
  cancelDraft: () => void;
  /** Set hovered line */
  setHoveredLine: (line: { side: DiffCommentSide; lineNumber: number } | null) => void;
  /** Find GitHub threads at a given position */
  getGitHubThreadsAtLine: (side: DiffCommentSide, lineNumber: number) => GitHubReviewThread[];
}

function githubSideToLody(side: 'LEFT' | 'RIGHT'): DiffCommentSide {
  return side === 'RIGHT' ? 'additions' : 'deletions';
}

export function useSessionComments({
  path,
  githubThreads = [],
  commentsEnabled = false,
  turnId,
  mode,
}: UseSessionCommentsOptions): UseSessionCommentsResult {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [hoveredLine, setHoveredLine] = useState<{
    side: DiffCommentSide;
    lineNumber: number;
  } | null>(null);

  const startDraft = useCallback(
    (side: DiffCommentSide, lineNumber: number, lineContent?: string) => {
      setDraft({
        anchor: {
          anchorType: 'diff',
          path,
          side,
          lineNumber,
          lineContent,
          turnId,
          mode,
        },
      });
    },
    [path, turnId, mode]
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  const getGitHubThreadsAtLine = useCallback(
    (side: DiffCommentSide, lineNumber: number) =>
      githubThreads.filter((t) => {
        const ghSide = githubSideToLody(t.anchor.side);
        return ghSide === side && t.anchor.line === lineNumber;
      }),
    [githubThreads]
  );

  const lineAnnotations = useMemo(() => {
    if (!commentsEnabled) return [];

    const annotations: DiffLineAnnotation<CommentAnnotationMeta>[] = [];
    const seen = new Set<string>();

    for (const thread of githubThreads) {
      const side = githubSideToLody(thread.anchor.side);
      const lineNumber = thread.anchor.line;
      const key = `${side}-${lineNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        annotations.push({
          side,
          lineNumber,
          metadata: {
            key,
            threadId: String(thread.id),
            kind: 'github-thread',
            source: 'github',
          },
        });
      }
    }

    // Add annotation for current draft
    if (draft) {
      const { side, lineNumber } = draft.anchor;
      if (side) {
        const key = `${side}-${lineNumber}`;
        if (!seen.has(key)) {
          annotations.push({
            side: side as 'additions' | 'deletions',
            lineNumber,
            metadata: {
              key,
              kind: 'draft',
              source: 'github',
            },
          });
        }
      }
    }

    return annotations;
  }, [commentsEnabled, githubThreads, draft]);

  return {
    lineAnnotations,
    draft,
    hoveredLine,
    startDraft,
    cancelDraft,
    setHoveredLine,
    getGitHubThreadsAtLine,
  };
}
