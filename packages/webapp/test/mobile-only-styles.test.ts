/**
 * These source checks prove the phone fixes do not move desktop layout. Each
 * changed declaration must stay inside its max-width query unless its desktop
 * value is deliberately boxless.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, '..', 'src', name), 'utf8');
const maxWidthPattern = /@media \(max-width: \d+px\) \{([\s\S]*?)\n\}/gu;

function maxWidthCss(css: string): string {
  return [...css.matchAll(maxWidthPattern)].map((block) => block[1] ?? '').join('\n');
}

function desktopCss(css: string): string {
  return css.replace(maxWidthPattern, '');
}

function ruleBodies(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'gu');
  return [...css.matchAll(pattern)].map((match) => match[1] ?? '');
}

function declares(css: string, selector: string, property: string, value: string): boolean {
  const declaration = new RegExp(
    `(?:^|;)\\s*${property}\\s*:\\s*${value}\\s*(?:;|$)`,
    'u',
  );
  return ruleBodies(css, selector).some((body) => declaration.test(body));
}

function expectOnlyBelowBreakpoint(
  css: string,
  file: string,
  selector: string,
  property: string,
  value: string,
): void {
  const declaration = `${property}: ${value}`;
  expect(
    declares(maxWidthCss(css), selector, property, value),
    `${file}: ${selector} must declare ${declaration} inside a max-width query`,
  ).toBe(true);
  expect(
    declares(desktopCss(css), selector, property, value),
    `${file}: ${selector} must not declare ${declaration} outside a max-width query`,
  ).toBe(false);
}

describe('mobile-only stylesheet changes', () => {
  it('keeps the full-width rail and scrim removal mobile-only', () => {
    const css = source('strip-rail.css');
    expectOnlyBelowBreakpoint(css, 'strip-rail.css', '.shell-nav', 'width', '100%');
    // The full-width nav covers the viewport, so a scrim would cover nothing.
    // It is deleted rather than hidden, and `ShellNav` stops rendering it.
    expect(
      css.includes('shell-nav-scrim'),
      'strip-rail.css: the scrim must be deleted, not hidden',
    ).toBe(false);
  });

  it('keeps the create-workspace scroller and action layout mobile-only', () => {
    const css = source('create-workspace-dialog.css');
    expectOnlyBelowBreakpoint(
      css,
      'create-workspace-dialog.css',
      '.create-workspace-dialog',
      'overflow-y',
      'auto',
    );
    expectOnlyBelowBreakpoint(
      css,
      'create-workspace-dialog.css',
      '.create-workspace-header',
      'position',
      'sticky',
    );
    expectOnlyBelowBreakpoint(
      css,
      'create-workspace-dialog.css',
      '.create-workspace-actions',
      'justify-content',
      'stretch',
    );
    expect(
      declares(maxWidthCss(css), '.create-workspace-actions--blueprint', 'display', 'flex'),
      'create-workspace-dialog.css: blueprint actions must stay side by side on mobile',
    ).toBe(true);
  });

  it('keeps the member machine wrapper boxless on desktop', () => {
    const css = source('workspace-details-dialog.css');
    expect(
      declares(desktopCss(css), '.workspace-member-machine', 'display', 'contents'),
      'workspace-details-dialog.css: the desktop member machine wrapper must use display: contents',
    ).toBe(true);
    expectOnlyBelowBreakpoint(
      css,
      'workspace-details-dialog.css',
      '.workspace-member-machine',
      'display',
      'flex',
    );
  });
});
