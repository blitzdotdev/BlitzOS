import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import {
  EMOJIBASE_ASSET_DIRECTORY,
  EMOJIBASE_BUNDLED_LOCALES,
} from './src/lib/emojibase-assets';

/**
 * Ships the emoji picker's dataset with the app instead of fetching it.
 *
 * `frimousse` resolves its data as `${emojibaseUrl}/${locale}/{data,messages}.json`
 * and defaults that base to a public CDN. Lody's desktop and mobile apps are
 * local-first and are expected to work with no network at all, where that
 * default leaves the picker spinning forever — so every host build emits those
 * files itself and points the picker at them.
 *
 * It is a URL contract, not an import: the library builds those paths at
 * runtime, so a bundled `?url` asset (whose name is hashed) cannot satisfy it.
 * Hence a plugin that writes a real directory into the build output and serves
 * the same paths in dev.
 */

const EMOJIBASE_FILES = ['data.json', 'messages.json'] as const;

export type EmojibaseAsset = {
  /** Output path, relative to the build's asset root. */
  fileName: string;
  /** Absolute path inside the resolved `emojibase-data` package. */
  sourcePath: string;
};

/**
 * Every file the picker can ask for, resolved through `emojibase-data`'s own
 * module resolution so the plugin cannot drift from the installed version.
 */
export function buildEmojibaseAssets(resolveFrom: string = import.meta.url): EmojibaseAsset[] {
  const require = createRequire(resolveFrom);
  const packageJsonPath = require.resolve('emojibase-data/package.json');
  const packageRoot = path.dirname(packageJsonPath);

  return EMOJIBASE_BUNDLED_LOCALES.flatMap((locale) =>
    EMOJIBASE_FILES.map((file) => ({
      fileName: `${EMOJIBASE_ASSET_DIRECTORY}/${locale}/${file}`,
      sourcePath: path.join(packageRoot, locale, file),
    }))
  );
}

export function emojibaseAssetsPlugin(): Plugin {
  const assets = buildEmojibaseAssets();
  const byUrlPath = new Map(assets.map((asset) => [`/${asset.fileName}`, asset.sourcePath]));
  let isServing = false;

  return {
    name: 'lody-emojibase-assets',
    configResolved(config) {
      isServing = config.command === 'serve';
    },
    async buildStart() {
      // The dev server has no bundle to emit into — it serves the same paths
      // through the middleware below — and calling `emitFile` there only logs
      // "not supported in serve mode" on every reload.
      if (isServing) return;
      // Emitted with an explicit `fileName` so the locale directory survives
      // into the output; a hashed asset name would not match the URL the
      // picker builds.
      await Promise.all(
        assets.map(async (asset) =>
          this.emitFile({
            type: 'asset',
            fileName: asset.fileName,
            source: await readFile(asset.sourcePath),
          })
        )
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split('?')[0];
        const sourcePath = requestPath ? byUrlPath.get(requestPath) : undefined;
        if (!sourcePath) {
          next();
          return;
        }
        void readFile(sourcePath).then(
          (contents) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(contents);
          },
          () => next()
        );
      });
    },
  };
}
