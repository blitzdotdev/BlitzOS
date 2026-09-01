import { describe, expect, it, vi } from 'vitest';

vi.mock('beautiful-mermaid', () => ({
  renderMermaidSVGAsync: async (source: string) => {
    if (!source.includes('A-->B')) {
      throw new Error(`Invalid mermaid header: "${source.split('\n')[0]}"`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" data-diagram="flowchart"></svg>`;
  },
}));

vi.mock('mermaid', () => {
  throw new Error('mermaid.js must not load after the renderer unifies on beautiful-mermaid');
});

const { createMarkdownMermaidConfig, createMarkdownMermaidPlugin } =
  await import('../src/components/ai-gui/markdown-mermaid');

describe('markdown mermaid plugin', () => {
  it('renders a flowchart through beautiful-mermaid', async () => {
    const plugin = createMarkdownMermaidPlugin();
    const result = await plugin
      .getMermaid(createMarkdownMermaidConfig('dark'))
      .render('diagram-1', ['graph TD', '  A-->B'].join('\n'));

    expect(result.svg).toContain('data-diagram="flowchart"');
  });

  it('keeps dark-mode mermaid colors readable', () => {
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

  it('falls back to a themed multi-line code block for unsupported diagram types', async () => {
    const plugin = createMarkdownMermaidPlugin();
    const result = await plugin
      .getMermaid(createMarkdownMermaidConfig('dark'))
      .render('diagram-2', ['pie title Pets', '  "Dogs" : 40', '  "Cats" : 60'].join('\n'));

    expect(result.svg).not.toContain('Diagram unavailable');
    // One tspan per source line, so the fallback actually renders multi-line.
    expect(result.svg.match(/<tspan/g)).toHaveLength(3);
    expect(result.svg).toContain('pie title Pets');
    // Dark theme surface/text colors, not the old light amber panel.
    expect(result.svg).toContain('fill="#111827"');
    expect(result.svg).toContain('fill="#e2e8f0"');
  });

  it('escapes markup in the fallback source listing', async () => {
    const plugin = createMarkdownMermaidPlugin();
    const result = await plugin
      .getMermaid(createMarkdownMermaidConfig('light'))
      .render('diagram-3', 'pie title <script>alert(1)</script>');

    expect(result.svg).not.toContain('<script>');
    expect(result.svg).toContain('&lt;script&gt;');
  });
});
