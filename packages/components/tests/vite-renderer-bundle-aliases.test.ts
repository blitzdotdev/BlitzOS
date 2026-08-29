import { describe, expect, it } from 'vitest';

import {
  isMermaidRuntimeDependency,
  rendererBundleAliases,
  resolveBeautifulMermaidChunk,
} from '../vite-renderer-bundle-aliases';

describe('renderer bundle aliases', () => {
  it('isolates beautiful-mermaid and elkjs from the startup graph', () => {
    expect(isMermaidRuntimeDependency('/node_modules/beautiful-mermaid/dist/index.js')).toBe(true);
    expect(isMermaidRuntimeDependency('/node_modules/elkjs/lib/elk.bundled.js')).toBe(true);
    expect(isMermaidRuntimeDependency('/node_modules/mermaid/dist/mermaid.js')).toBe(false);
    expect(isMermaidRuntimeDependency('/packages/components/src/components/ai-gui/view.tsx')).toBe(
      false
    );
  });

  it('points meowdown and prosekit at the shared mermaid and shiki entries', () => {
    expect(rendererBundleAliases().some((alias) => alias.find === 'shiki/bundle/full')).toBe(true);
    expect(
      resolveBeautifulMermaidChunk('./beautiful-mermaid-chunk-Cc6FHgAa.js')
        ?.replaceAll('\\', '/')
        .endsWith('/beautiful-mermaid/dist/index.js')
    ).toBe(true);
  });
});
