// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeDropZoneHandlers, useDropZone } from '../src/hooks/use-drop-zone';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no DataTransfer, and the zone only ever reads `types`. */
function transferOf(...types: string[]) {
  return { types, dropEffect: 'none' } as unknown as DataTransfer;
}

function fire(node: Element, type: string, dataTransfer: DataTransfer) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

describe('useDropZone', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function Harness({
    enabled = true,
    onDrop,
  }: {
    enabled?: boolean;
    onDrop: (dataTransfer: DataTransfer) => void;
  }) {
    const files = useDropZone({
      enabled,
      accepts: (dataTransfer) => dataTransfer.types.includes('Files'),
      onDrop,
    });
    const sessions = useDropZone({
      enabled,
      accepts: (dataTransfer) => dataTransfer.types.includes('x-session'),
      onDrop,
    });
    return (
      <div data-testid="page" {...mergeDropZoneHandlers(files, sessions)}>
        <div data-testid="child" data-files={String(files.isActive)}>
          <span data-testid="grandchild" data-sessions={String(sessions.isActive)} />
        </div>
      </div>
    );
  }

  const state = (testid: string, attribute: string) =>
    container.querySelector(`[data-testid="${testid}"]`)?.getAttribute(attribute);
  const node = (testid: string) =>
    container.querySelector(`[data-testid="${testid}"]`) as Element;

  it('stays active while the pointer crosses into nested children', async () => {
    const dropped: string[][] = [];
    await act(async () => {
      root.render(<Harness onDrop={(transfer) => dropped.push([...transfer.types])} />);
    });

    fire(node('child'), 'dragenter', transferOf('x-session'));
    expect(state('grandchild', 'data-sessions')).toBe('true');

    // Entering a child fires `dragleave` on the one being left; only the
    // matching count of leaves may switch the zone off.
    fire(node('grandchild'), 'dragenter', transferOf('x-session'));
    fire(node('child'), 'dragleave', transferOf('x-session'));
    expect(state('grandchild', 'data-sessions')).toBe('true');

    fire(node('grandchild'), 'dragleave', transferOf('x-session'));
    expect(state('grandchild', 'data-sessions')).toBe('false');

    fire(node('child'), 'dragenter', transferOf('x-session'));
    fire(node('child'), 'drop', transferOf('x-session'));
    expect(dropped).toEqual([['x-session']]);
    expect(state('grandchild', 'data-sessions')).toBe('false');
  });

  it('leaves a transfer it does not accept to the other zone', async () => {
    const dropped: string[][] = [];
    await act(async () => {
      root.render(<Harness onDrop={(transfer) => dropped.push([...transfer.types])} />);
    });

    fire(node('child'), 'dragenter', transferOf('Files'));
    expect(state('child', 'data-files')).toBe('true');
    expect(state('grandchild', 'data-sessions')).toBe('false');

    fire(node('child'), 'drop', transferOf('Files'));
    expect(dropped).toEqual([['Files']]);
  });

  it('does not claim a drag it cannot accept', async () => {
    await act(async () => {
      root.render(<Harness onDrop={() => undefined} />);
    });

    const event = fire(node('child'), 'dragover', transferOf('text/plain'));
    // Not prevented, so the browser keeps its own handling — that is what lets
    // an unrelated drop target below or above this one still work.
    expect(event.defaultPrevented).toBe(false);
  });

  it('drops its active state when the zone is disabled mid-drag', async () => {
    await act(async () => {
      root.render(<Harness onDrop={() => undefined} />);
    });
    fire(node('child'), 'dragenter', transferOf('x-session'));
    expect(state('grandchild', 'data-sessions')).toBe('true');

    await act(async () => {
      root.render(<Harness enabled={false} onDrop={() => undefined} />);
    });
    expect(state('grandchild', 'data-sessions')).toBe('false');
  });
});
