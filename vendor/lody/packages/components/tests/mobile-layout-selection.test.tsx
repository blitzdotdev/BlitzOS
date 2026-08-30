// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { useIsMobile } from '../src/hooks/use-mobile';

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
}

function setNavigatorIdentity(userAgent: string, mobileHint?: boolean) {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: mobileHint === undefined ? undefined : { mobile: mobileHint },
  });
}

function LayoutProbe() {
  const isMobile = useIsMobile();
  return <div data-testid="layout">{isMobile ? 'mobile' : 'desktop'}</div>;
}

describe('mobile layout selection', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    root = undefined;
    container?.remove();
    container = undefined;
    Reflect.deleteProperty(window.navigator, 'userAgent');
    Reflect.deleteProperty(window.navigator, 'userAgentData');
    vi.restoreAllMocks();
  });

  function renderLayoutProbe() {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('max-width') && window.innerWidth < 768,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(<LayoutProbe />));
  }

  it('keeps the mobile renderer when a phone rotates past the desktop breakpoint', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
    );
    setViewportWidth(430);
    renderLayoutProbe();

    expect(container?.textContent).toBe('mobile');

    setViewportWidth(932);
    flushSync(() => window.dispatchEvent(new Event('resize')));

    expect(container?.textContent).toBe('mobile');
  });

  it('uses the mobile renderer for a wide phone reported by client hints', () => {
    setNavigatorIdentity('Mozilla/5.0 AppleWebKit/537.36 Chrome/140 Safari/537.36', true);
    setViewportWidth(915);
    renderLayoutProbe();

    expect(container?.textContent).toBe('mobile');
  });

  it('keeps a wide tablet on the desktop renderer', () => {
    setNavigatorIdentity(
      'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 Chrome/140 Safari/537.36'
    );
    setViewportWidth(1280);
    renderLayoutProbe();

    expect(container?.textContent).toBe('desktop');
  });
});
