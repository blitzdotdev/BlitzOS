import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

/**
 * One drop target: "accept these transfers here, and say while a pointer is
 * dragging one over me".
 *
 * The bookkeeping looks trivial and is not. `dragleave` fires when the pointer
 * crosses into a CHILD element, so a zone that flips its highlight off there
 * flickers over every nested node; the depth counter is what makes enter/leave
 * pair up. And every handler must ignore transfers it does not accept WITHOUT
 * preventing the default — that is how several zones share one subtree, each
 * claiming its own kind of drag.
 *
 * Zones compose by chaining their handlers on the same element: a zone that
 * accepts a transfer stops its propagation, so an ancestor zone accepting the
 * same kind does not double-count it.
 */
export type DropZoneOptions = {
  /** While false the zone ignores everything and reports no active drag. */
  enabled: boolean;
  /**
   * Whether this zone wants the transfer. Called during dragenter/over/leave,
   * where only `dataTransfer.types` is readable — the payload stays protected
   * until the drop.
   */
  accepts: (dataTransfer: DataTransfer) => boolean;
  onDrop: (dataTransfer: DataTransfer) => void;
};

export type DropZone = {
  /** True while an accepted drag is over the zone. */
  isActive: boolean;
  handlers: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void;
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
};

export function useDropZone({ enabled, accepts, onDrop }: DropZoneOptions): DropZone {
  const depthRef = useRef(0);
  const [isActive, setIsActive] = useState(false);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setIsActive(false);
  }, []);

  useEffect(() => {
    if (!enabled) reset();
  }, [enabled, reset]);

  const claim = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!enabled || !accepts(event.dataTransfer)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [accepts, enabled]
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.dataTransfer.dropEffect = 'copy';
      depthRef.current += 1;
      setIsActive(true);
    },
    [claim]
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      event.dataTransfer.dropEffect = 'copy';
    },
    [claim]
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setIsActive(false);
    },
    [claim]
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!claim(event)) return;
      reset();
      onDrop(event.dataTransfer);
    },
    [claim, onDrop, reset]
  );

  return {
    isActive,
    handlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}

/** Run several zones' handlers on one element, in order. */
export function mergeDropZoneHandlers(...zones: DropZone[]): DropZone['handlers'] {
  const run = (key: keyof DropZone['handlers']) => (event: DragEvent<HTMLElement>) => {
    for (const zone of zones) zone.handlers[key](event);
  };
  return {
    onDragEnter: run('onDragEnter'),
    onDragOver: run('onDragOver'),
    onDragLeave: run('onDragLeave'),
    onDrop: run('onDrop'),
  };
}
