/**
 * Curated drop-in replacement for shiki's `./langs.mjs` module, used ONLY by the
 * standalone single-file viewer build (`vite.standalone.config.ts` aliases shiki's
 * `langs.mjs` to this file).
 *
 * Why this exists: `@pierre/diffs` loads grammars via `bundledLanguages[lang]()`,
 * and shiki's real `bundledLanguages` is a map of ALL 383 grammar loaders. Each
 * loader is a `() => import('@shikijs/langs/<id>')`, so the bundler code-splits
 * every grammar into its own chunk. When the standalone build inlines all chunks
 * into one HTML file (`vite-plugin-singlefile`), that would pull in ~12 MB of
 * grammars. By replacing the loader map with a curated subset, only these grammars
 * (plus their transitive sub-grammar deps) enter the bundle.
 *
 * The shape (`bundledLanguages`, `bundledLanguagesBase`, `bundledLanguagesAlias`,
 * `bundledLanguagesInfo`) mirrors shiki's real export so shiki's index re-export
 * and `createHighlighter` keep working. For every curated id we import the exact
 * same `@shikijs/langs/<id>` module shiki would, so highlighting behavior is
 * identical to the full build — we only remove the languages we don't ship.
 *
 * The literal `() => import('@shikijs/langs/<id>')` calls MUST stay literal so the
 * bundler can statically resolve them; do not build the path from a variable.
 *
 * Languages outside this set degrade to plain text (see `bundledLanguages` Proxy):
 * the file still renders, just without syntax colors.
 */
// Minimal local types mirroring shiki's `DynamicImportLanguageRegistration` so this
// shim does not depend on shiki's exported type surface.
type GrammarLoader = () => Promise<{ default: unknown }>;

interface CuratedLangInfo {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly import: GrammarLoader;
}

// Canonical shiki ids + their real aliases. Aliases cover the names that
// `@pierre/diffs`' `getFiletypeFromFileName` actually emits (e.g. `sh`/`bash`/`zsh`
// → `shellscript`, `dockerfile` → `docker`, `makefile` → `make`, `yml` → `yaml`).
const CURATED: readonly CuratedLangInfo[] = [
  {
    id: 'typescript',
    name: 'TypeScript',
    aliases: ['ts'],
    import: () => import('@shikijs/langs/typescript'),
  },
  { id: 'tsx', name: 'TSX', import: () => import('@shikijs/langs/tsx') },
  {
    id: 'javascript',
    name: 'JavaScript',
    aliases: ['js'],
    import: () => import('@shikijs/langs/javascript'),
  },
  { id: 'jsx', name: 'JSX', import: () => import('@shikijs/langs/jsx') },
  { id: 'json', name: 'JSON', import: () => import('@shikijs/langs/json') },
  { id: 'jsonc', name: 'JSON with Comments', import: () => import('@shikijs/langs/jsonc') },
  { id: 'json5', name: 'JSON5', import: () => import('@shikijs/langs/json5') },
  {
    id: 'markdown',
    name: 'Markdown',
    aliases: ['md'],
    import: () => import('@shikijs/langs/markdown'),
  },
  { id: 'mdx', name: 'MDX', import: () => import('@shikijs/langs/mdx') },
  { id: 'css', name: 'CSS', import: () => import('@shikijs/langs/css') },
  { id: 'scss', name: 'SCSS', import: () => import('@shikijs/langs/scss') },
  { id: 'sass', name: 'Sass', import: () => import('@shikijs/langs/sass') },
  { id: 'less', name: 'Less', import: () => import('@shikijs/langs/less') },
  { id: 'html', name: 'HTML', import: () => import('@shikijs/langs/html') },
  { id: 'vue', name: 'Vue', import: () => import('@shikijs/langs/vue') },
  { id: 'svelte', name: 'Svelte', import: () => import('@shikijs/langs/svelte') },
  { id: 'astro', name: 'Astro', import: () => import('@shikijs/langs/astro') },
  { id: 'python', name: 'Python', aliases: ['py'], import: () => import('@shikijs/langs/python') },
  { id: 'go', name: 'Go', import: () => import('@shikijs/langs/go') },
  { id: 'rust', name: 'Rust', aliases: ['rs'], import: () => import('@shikijs/langs/rust') },
  { id: 'java', name: 'Java', import: () => import('@shikijs/langs/java') },
  {
    id: 'kotlin',
    name: 'Kotlin',
    aliases: ['kt', 'kts'],
    import: () => import('@shikijs/langs/kotlin'),
  },
  { id: 'swift', name: 'Swift', import: () => import('@shikijs/langs/swift') },
  { id: 'c', name: 'C', import: () => import('@shikijs/langs/c') },
  { id: 'cpp', name: 'C++', aliases: ['c++'], import: () => import('@shikijs/langs/cpp') },
  {
    id: 'csharp',
    name: 'C#',
    aliases: ['cs', 'c#'],
    import: () => import('@shikijs/langs/csharp'),
  },
  {
    id: 'objective-c',
    name: 'Objective-C',
    aliases: ['objc'],
    import: () => import('@shikijs/langs/objective-c'),
  },
  {
    id: 'objective-cpp',
    name: 'Objective-C++',
    aliases: ['objcpp'],
    import: () => import('@shikijs/langs/objective-cpp'),
  },
  { id: 'ruby', name: 'Ruby', aliases: ['rb'], import: () => import('@shikijs/langs/ruby') },
  { id: 'php', name: 'PHP', import: () => import('@shikijs/langs/php') },
  {
    id: 'shellscript',
    name: 'Shell',
    aliases: ['bash', 'sh', 'shell', 'zsh'],
    import: () => import('@shikijs/langs/shellscript'),
  },
  { id: 'yaml', name: 'YAML', aliases: ['yml'], import: () => import('@shikijs/langs/yaml') },
  { id: 'toml', name: 'TOML', import: () => import('@shikijs/langs/toml') },
  { id: 'ini', name: 'INI', aliases: ['properties'], import: () => import('@shikijs/langs/ini') },
  { id: 'sql', name: 'SQL', import: () => import('@shikijs/langs/sql') },
  {
    id: 'graphql',
    name: 'GraphQL',
    aliases: ['gql'],
    import: () => import('@shikijs/langs/graphql'),
  },
  {
    id: 'docker',
    name: 'Dockerfile',
    aliases: ['dockerfile'],
    import: () => import('@shikijs/langs/docker'),
  },
  { id: 'xml', name: 'XML', import: () => import('@shikijs/langs/xml') },
  { id: 'diff', name: 'Diff', import: () => import('@shikijs/langs/diff') },
  { id: 'lua', name: 'Lua', import: () => import('@shikijs/langs/lua') },
  { id: 'dart', name: 'Dart', import: () => import('@shikijs/langs/dart') },
  {
    id: 'proto',
    name: 'Protocol Buffers',
    aliases: ['protobuf'],
    import: () => import('@shikijs/langs/proto'),
  },
  {
    id: 'make',
    name: 'Makefile',
    aliases: ['makefile'],
    import: () => import('@shikijs/langs/make'),
  },
];

export const bundledLanguagesInfo = CURATED;

export const bundledLanguagesBase: Record<string, GrammarLoader> = Object.fromEntries(
  CURATED.map((info) => [info.id, info.import])
);

export const bundledLanguagesAlias: Record<string, GrammarLoader> = Object.fromEntries(
  CURATED.flatMap((info) => (info.aliases ?? []).map((alias) => [alias, info.import]))
);

const resolvedLoaders: Record<string, GrammarLoader> = {
  ...bundledLanguagesBase,
  ...bundledLanguagesAlias,
};

// A loader for any language we did not bundle: resolve to an empty TextMate
// grammar so `@pierre/diffs` renders the file as plain text instead of throwing
// an unhandled "language not found" rejection. `text`/`ansi` are handled inside
// shiki itself and never reach this map.
function plainTextLoader(lang: string): GrammarLoader {
  return () =>
    Promise.resolve({
      default: [
        {
          name: lang,
          scopeName: `source.${lang}.plain`,
          patterns: [],
          repository: {},
        },
      ],
    });
}

export const bundledLanguages: Record<string, GrammarLoader> = new Proxy<
  Record<string, GrammarLoader>
>(resolvedLoaders, {
  get(target, prop, receiver) {
    if (typeof prop !== 'string') {
      return Reflect.get(target, prop, receiver);
    }
    if (prop === 'then') {
      // Guard against accidental promise-unwrapping of this object.
      return undefined;
    }
    const existing = Reflect.get(target, prop, receiver);
    if (existing != null) {
      return existing;
    }
    return plainTextLoader(prop);
  },
});
