import type { Plugin } from 'vite';

// Mermaid is rendered behind a dynamic import, but a manual chunk can still
// become an entry dependency when it captures a package shared with the app.
// Check the final graph so dependency changes cannot silently move the diagram
// runtime back onto a renderer's startup path.
export function mermaidLazyBoundaryGuardPlugin(): Plugin {
  return {
    name: 'mermaid-lazy-boundary-guard',
    apply: 'build',
    writeBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === 'chunk');
      const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const mermaidChunkFiles = new Set(
        chunks.filter((chunk) => chunk.name === 'mermaid-deps').map((chunk) => chunk.fileName)
      );

      if (mermaidChunkFiles.size === 0) {
        throw new Error(
          `mermaid-lazy-boundary-guard: the expected mermaid-deps chunk is missing. ` +
            `Keep Mermaid isolated behind its guarded dynamic import.`
        );
      }

      const offenders: string[] = [];
      for (const entry of chunks.filter((chunk) => chunk.isEntry)) {
        const pending = [...entry.imports];
        const visited = new Set<string>();
        while (pending.length > 0) {
          const importedFile = pending.pop();
          if (!importedFile || visited.has(importedFile)) continue;
          visited.add(importedFile);
          if (mermaidChunkFiles.has(importedFile)) {
            offenders.push(entry.fileName);
            break;
          }
          const importedChunk = chunksByFileName.get(importedFile);
          if (importedChunk) pending.push(...importedChunk.imports);
        }
      }

      if (offenders.length > 0) {
        throw new Error(
          `mermaid-lazy-boundary-guard: mermaid-deps is statically reachable from ` +
            `entry chunk(s) ${offenders.join(', ')}. Do not assign dependencies shared ` +
            `with the startup graph (for example d3) to the Mermaid manual chunk.`
        );
      }

      const html = bundle['index.html'];
      const htmlSource = html?.type === 'asset' ? String(html.source) : '';
      if (/\bmermaid-deps-[^"']+\.js\b/.test(htmlSource)) {
        throw new Error(
          `mermaid-lazy-boundary-guard: index.html eagerly references mermaid-deps. ` +
            `The chunk must only be requested when a diagram is rendered.`
        );
      }
    },
  };
}
