// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMarkdownMermaidConfig,
  MarkdownRenderer,
} from '../src/components/ai-gui/markdown-renderer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestIntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds = [];

  disconnect() {}
  observe() {}
  takeRecords() {
    return [];
  }
  unobserve() {}
}

(
  globalThis as typeof globalThis & { IntersectionObserver: typeof IntersectionObserver }
).IntersectionObserver = TestIntersectionObserver as typeof IntersectionObserver;

const STREAM_CHUNK_COUNT = 48;

const buildStreamingMarkdownChunks = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const id = String(index).padStart(3, '0');
    return [
      `### Streaming section ${id}`,
      `Check agent-${id}@example.com and https://example.com/sessions/${id}?from=stream.`,
      `Also compare www.example.com/docs/${id} while this response keeps growing.`,
    ].join('\n');
  }).map((chunk) => `${chunk}\n\n`);

const countCumulativePrefixChars = (chunks: readonly string[]): number => {
  let prefixLength = 0;
  let total = 0;

  for (const chunk of chunks) {
    prefixLength += chunk.length;
    total += prefixLength;
  }

  return total;
};

describe('MarkdownRenderer streaming rendering', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  const renderMarkdown = async (
    text: string,
    props: Partial<ComponentProps<typeof MarkdownRenderer>> = {}
  ): Promise<void> => {
    if (!root) {
      throw new Error('Expected test root to be initialized');
    }

    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text, ...props }));
    });
  };

  const waitForElement = async (selector: string): Promise<Element> => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 1000) {
      const element = container?.querySelector(selector);
      if (element) {
        return element;
      }

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 20));
      });
    }

    throw new Error(`Expected element matching ${selector}`);
  };

  it('uses the GFM autolink path for email literals', async () => {
    await renderMarkdown('Contact agent-000@example.com before checking https://example.com.');

    expect(container?.querySelector('a[href="mailto:agent-000@example.com"]')).not.toBeNull();
  });

  it('keeps raw HTML escaped by default', async () => {
    await renderMarkdown('Hello <strong>raw</strong>.');

    expect(container?.querySelector('[data-streamdown="strong"]')).toBeNull();
    expect(container?.textContent).toContain('<strong>raw</strong>');
  });

  it('labels the icon-only code copy button', async () => {
    await renderMarkdown('```ts\nconst answer = 42;\n```');

    const copyButton = await waitForElement('[data-streamdown="code-block-copy-button"]');
    expect(copyButton.getAttribute('aria-label')).toBe('Copy code');
  });

  it('renders sanitized raw HTML when allowHtml is enabled', async () => {
    await renderMarkdown('Hello <strong>raw</strong>.', { allowHtml: true });

    expect(container?.querySelector('[data-streamdown="strong"]')?.textContent).toBe('raw');
  });

  it('renders Streamdown native LaTeX and Mermaid blocks', async () => {
    await renderMarkdown(
      [
        'Inline LaTeX $E = mc^2$ should render.',
        '',
        '```mermaid',
        'graph TD',
        '  A-->B',
        '```',
      ].join('\n')
    );

    expect(container?.querySelector('.katex')).not.toBeNull();
    expect(await waitForElement('[data-streamdown="mermaid-block"]')).not.toBeNull();
  });

  it('does not parse dollars inside code spans or link labels as LaTeX', async () => {
    await renderMarkdown(
      [
        'See [upload.$key.tsx](/home/agent/project/src/routes/api/upload.$key.tsx:9)',
        'and `r2.$.tsx` before checking the next file.',
      ].join(' ')
    );

    expect(container?.querySelector('.katex')).toBeNull();
    expect(container?.textContent).toContain('upload.$key.tsx');
    expect(container?.textContent).toContain('r2.$.tsx');
    const fileLinkButton = container?.querySelector(
      'button[title="/home/agent/project/src/routes/api/upload.$key.tsx:9"]'
    );
    expect(fileLinkButton).not.toBeNull();
  });

  it('uses Mermaid theme variables with readable dark-mode foregrounds and lines', () => {
    const lightConfig = createMarkdownMermaidConfig('light');
    const darkConfig = createMarkdownMermaidConfig('dark');

    expect(lightConfig.theme).toBe('base');
    expect(darkConfig.theme).toBe('base');
    expect(darkConfig.darkMode).toBe(true);
    expect(darkConfig.themeVariables).toMatchObject({
      primaryTextColor: '#f8fafc',
      lineColor: '#cbd5e1',
      textColor: '#e2e8f0',
    });
    expect(darkConfig.themeVariables).not.toBe(lightConfig.themeVariables);
  });

  it('keeps incomplete streaming Markdown rendered without per-word animation spans', async () => {
    await renderMarkdown(
      ['Streaming words are still arriving.', '', '```ts', 'const answer = 42;'].join('\n'),
      { isStreaming: true }
    );

    expect(container?.textContent).toContain('Streaming words are still arriving.');
    expect(await waitForElement('[data-streamdown="code-block"]')).not.toBeNull();
    expect(container?.querySelector('[data-sd-animate]')).toBeNull();
  });

  it('does not render Streamdown caret placeholders while streaming', async () => {
    await renderMarkdown('Streaming text should not reserve a cursor placeholder.', {
      isStreaming: true,
    });

    expect(container?.innerHTML).not.toContain('--streamdown-caret');
    expect(container?.innerHTML).not.toContain('content-[var(--streamdown-caret)]');
  });

  it('keeps GFM autolinks available across streaming renders', async () => {
    const chunks = buildStreamingMarkdownChunks(STREAM_CHUNK_COUNT);
    const finalText = chunks.join('');
    let streamingText = '';
    let cumulativeRenderedInputChars = 0;

    const streamingStartedAt = performance.now();
    for (const chunk of chunks) {
      streamingText += chunk;
      cumulativeRenderedInputChars += streamingText.length;
      await renderMarkdown(streamingText, { isStreaming: true });
    }
    const streamingElapsedMs = performance.now() - streamingStartedAt;

    const amplification = cumulativeRenderedInputChars / finalText.length;
    const finalEmail = `mailto:agent-${String(STREAM_CHUNK_COUNT - 1).padStart(3, '0')}@example.com`;
    const finalOnlyContainer = document.createElement('div');
    document.body.appendChild(finalOnlyContainer);
    const finalOnlyRoot = createRoot(finalOnlyContainer);
    let finalOnlyElapsedMs = 0;

    try {
      const finalOnlyStartedAt = performance.now();
      await act(async () => {
        finalOnlyRoot.render(createElement(MarkdownRenderer, { text: finalText }));
      });
      finalOnlyElapsedMs = performance.now() - finalOnlyStartedAt;
      expect(finalOnlyContainer.querySelector(`a[href="${finalEmail}"]`)).not.toBeNull();
    } finally {
      await act(async () => {
        finalOnlyRoot.unmount();
      });
      finalOnlyContainer.remove();
    }

    expect(streamingText).toBe(finalText);
    expect(cumulativeRenderedInputChars).toBe(countCumulativePrefixChars(chunks));
    expect(amplification).toBeGreaterThan(20);
    expect(container?.querySelector(`a[href="${finalEmail}"]`)).not.toBeNull();

    console.info(
      [
        'markdown streamdown streaming render',
        `finalChars=${finalText.length}`,
        `cumulativeRenderedInputChars=${cumulativeRenderedInputChars}`,
        `amplification=${amplification.toFixed(1)}x`,
        `streamingElapsedMs=${streamingElapsedMs.toFixed(1)}`,
        `finalOnlyElapsedMs=${finalOnlyElapsedMs.toFixed(1)}`,
      ].join(' ')
    );
  });
});
