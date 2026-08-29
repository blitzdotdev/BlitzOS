import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

// Shared by every browser/Electron client that still targets runtimes without
// native top-level await. It lives beside the other public component build
// helpers so its Vite types and runtime dependencies have a declared owner.

type TopLevelAwaitOptions = {
  promiseExportName?: string;
  promiseImportName?: (index: number) => string;
};

type TopLevelAwaitPluginFactory = (options?: TopLevelAwaitOptions) => Plugin;

const require = createRequire(import.meta.url);
const moduleExports = require('./vite-top-level-await-fixed.cjs') as
  | TopLevelAwaitPluginFactory
  | { default: TopLevelAwaitPluginFactory };

const topLevelAwaitFixed: TopLevelAwaitPluginFactory =
  typeof moduleExports === 'function' ? moduleExports : moduleExports.default;

export default topLevelAwaitFixed;
