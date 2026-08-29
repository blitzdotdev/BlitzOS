// Node-only path contract for the local workspace catalog file. The CLI owns
// reads/writes (apps/cli/src/lib/local-workspace-catalog.ts); the Electron
// main process reads it to surface the implicit local-platform workspace.
// Shared here so both sides agree on one path instead of duplicating it.
import path from 'node:path';
import { getLodyDataDir } from './installation-profile';
import type { PlatformKind } from '../platform-kind';

export function getLocalWorkspaceCatalogPath(platform?: PlatformKind): string {
  return path.join(getLodyDataDir(platform), 'workspace-catalog.json');
}
