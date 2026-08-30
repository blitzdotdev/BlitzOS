// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFireOncePerCycle, useFireOncePerKey } from '../src/hooks/use-fire-once';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('useFireOncePerCycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  const fired: string[] = [];

  function Harness({ active, keys }: { active: boolean; keys: string[] }) {
    const shouldFire = useFireOncePerCycle(active);
    const perLifetime = useFireOncePerKey();
    React.useEffect(() => {
      if (!active) return;
      for (const key of keys) {
        if (shouldFire(key)) fired.push(key);
        if (perLifetime(key)) fired.push(`lifetime:${key}`);
      }
    }, [active, keys, perLifetime, shouldFire]);
    return null;
  }

  function render(active: boolean, keys: string[]) {
    act(() => {
      root.render(<Harness active={active} keys={keys} />);
    });
  }

  beforeEach(() => {
    fired.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('fires each key once while the cycle stays active', () => {
    render(true, ['a']);
    render(true, ['a', 'b']);
    render(true, ['b', 'a']);

    expect(fired.filter((entry) => !entry.startsWith('lifetime:'))).toEqual(['a', 'b']);
  });

  it('forgets every key when the cycle ends, unlike the per-lifetime guard', () => {
    render(true, ['a']);
    render(false, ['a']);
    render(true, ['a']);

    expect(fired).toEqual(['a', 'lifetime:a', 'a']);
  });

  it('does not fire while inactive', () => {
    render(false, ['a']);

    expect(fired).toEqual([]);
  });

  it('resets during render, so a restarted cycle fires before any effect runs', () => {
    const onFire = vi.fn();

    // The clear happens in the render pass, not the hook's own effect, so a
    // cycle that restarts within one commit sequence is already forgotten by
    // the time consumer effects read the guard — whatever the hook order.
    function SingleKeyHarness({ active }: { active: boolean }) {
      const shouldFire = useFireOncePerCycle(active);
      React.useEffect(() => {
        if (active && shouldFire('only')) onFire();
      }, [active, shouldFire]);
      return null;
    }

    act(() => root.render(<SingleKeyHarness active />));
    act(() => root.render(<SingleKeyHarness active={false} />));
    act(() => root.render(<SingleKeyHarness active />));

    expect(onFire).toHaveBeenCalledTimes(2);
  });
});
