import { useState, type DragEvent as ReactDragEvent, type RefObject } from 'react';
import type { WorkspaceRegion } from './storage';
import {
  dropSideFor,
  landingBox,
  paneDropTarget,
  type Box,
  type PaneDropTarget,
  type TabCellBox,
} from './workspace-drag';

/** The panes draw their own drag ghost, so the browser's snapshot is replaced
 * with a 1×1 transparent GIF rather than left to double up on it. */
const BLANK_DRAG_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export type TabDrag = {
  sessionId: string;
  label: string;
  pointer: { x: number; y: number };
  target: PaneDropTarget;
  box: Box;
};

export type WorkspaceTabDrag = {
  tabDrag: TabDrag | null;
  beginTabDrag: (sessionId: string, event: ReactDragEvent<HTMLElement>) => void;
  trackTabDrag: (event: ReactDragEvent<HTMLElement>) => void;
  dropTabDrag: (event: ReactDragEvent<HTMLElement>) => void;
  clearTabDrag: () => void;
  dropTargetLabel: (target: PaneDropTarget) => string;
};

/** Tab drag lives entirely in the panes: the tab strips are the handles, the
 * pane under the pointer is the target, and the answer the hint draws is the
 * same one the drop applies — so the landing rectangle can never promise a
 * layout the drop will not produce. */
export function useWorkspaceTabDrag({
  panesRef,
  visibleRegions,
  enabled,
  labelFor,
  onDrop,
}: {
  panesRef: RefObject<HTMLDivElement | null>;
  visibleRegions: readonly WorkspaceRegion[];
  enabled: boolean;
  labelFor: (sessionId: string) => string;
  onDrop: (sessionId: number, target: PaneDropTarget) => void;
}): WorkspaceTabDrag {
  const [tabDrag, setTabDrag] = useState<TabDrag | null>(null);

  const stripElement = (region: WorkspaceRegion): HTMLElement | null => (
    panesRef.current?.querySelector<HTMLElement>(
      `.webapp-pane-strip[data-region="${region}"]`,
    ) ?? null
  );
  const regionUnderPointer = (clientX: number): WorkspaceRegion | null => {
    let fallback: WorkspaceRegion | null = null;
    for (const region of visibleRegions) {
      const rect = stripElement(region)?.getBoundingClientRect();
      if (rect === undefined) continue;
      fallback = region;
      if (clientX >= rect.left && clientX <= rect.right) return region;
    }
    return fallback;
  };
  const cellBoxes = (region: WorkspaceRegion): TabCellBox[] => [
    ...(stripElement(region)?.querySelectorAll<HTMLElement>('.webapp-tab-cell') ?? []),
  ].flatMap((cell) => {
    const id = Number(cell.dataset.sessionId);
    if (!Number.isSafeInteger(id)) return [];
    const rect = cell.getBoundingClientRect();
    return [{ id, left: rect.left, width: rect.width }];
  });

  const resolve = (event: ReactDragEvent<HTMLElement>): PaneDropTarget | null => {
    const container = panesRef.current;
    if (tabDrag === null || container === null) return null;
    const region = regionUnderPointer(event.clientX);
    if (region === null) return null;
    const strip = stripElement(region);
    if (strip === null) return null;
    const stripRect = strip.getBoundingClientRect();
    const target = paneDropTarget(
      region,
      dropSideFor(stripRect, event.clientX),
      cellBoxes(region),
      event.clientX,
      Number(tabDrag.sessionId),
    );
    // A split is measured from the column it lands in only while both columns
    // are on screen. With a single pane, either edge creates the second column
    // — the same-region edge by displacing the neighbours — so the hint claims
    // its own half of the container instead of the whole pane.
    const settled = target.kind === 'split'
      && (visibleRegions.length === 1 || !visibleRegions.includes(target.region))
      ? null
      : stripElement(target.kind === 'split' ? target.region : region)
        ?.getBoundingClientRect() ?? null;
    setTabDrag({
      ...tabDrag,
      pointer: { x: event.clientX, y: event.clientY },
      target,
      box: landingBox(target, container.getBoundingClientRect(), settled, stripRect.bottom),
    });
    return target;
  };

  return {
    tabDrag,
    beginTabDrag: (sessionId, event) => {
      if (!enabled) {
        event.preventDefault();
        return;
      }
      const transfer = event.dataTransfer;
      if (transfer) {
        transfer.effectAllowed = 'move';
        transfer.setData('text/plain', sessionId);
        const ghost = new Image();
        ghost.src = BLANK_DRAG_IMAGE;
        transfer.setDragImage?.(ghost, 0, 0);
      }
      setTabDrag({
        sessionId,
        label: labelFor(sessionId),
        pointer: { x: event.clientX, y: event.clientY },
        target: { kind: 'tab', region: 'main', beforeId: null },
        box: { left: 0, top: 0, width: 0, height: 0 },
      });
    },
    trackTabDrag: (event) => { resolve(event); },
    dropTabDrag: (event) => {
      const target = resolve(event);
      const dragged = tabDrag;
      setTabDrag(null);
      if (target === null || dragged === null) return;
      event.preventDefault();
      const id = Number(dragged.sessionId);
      if (Number.isSafeInteger(id)) onDrop(id, target);
    },
    clearTabDrag: () => setTabDrag(null),
    dropTargetLabel: (target) => {
      const column = target.region === 'main' ? 'left pane' : 'right pane';
      if (target.kind === 'split') {
        return visibleRegions.length > 1 && visibleRegions.includes(target.region)
          ? `Move to ${column}`
          : `Split ${target.region === 'main' ? 'left' : 'right'}`;
      }
      return `Tab · ${column}`;
    },
  };
}
