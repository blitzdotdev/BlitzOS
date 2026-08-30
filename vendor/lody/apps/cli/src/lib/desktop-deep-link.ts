/**
 * Deep links the CLI hands to the desktop app through the OS `lody://` handler.
 *
 * The desktop side parses these in
 * `packages/components/src/lib/desktop-open-local-project-deep-link.ts`; keep the
 * host, path, and parameter names in sync with that resolver (both sides pin the
 * exact URL shape in their unit tests).
 */

import { getInstallationProfile } from '@lody/shared/node/installation-profile';

export type OpenLocalProjectDeepLinkInput = {
  machineId: string;
  localProjectId: string;
  /**
   * Omitted when the CLI cannot tell which workspace slug the project belongs
   * to. The app then falls back to the workspace it is already showing, which
   * is correct whenever the machine only serves one workspace.
   */
  workspaceSlug?: string | null;
};

export function buildOpenLocalProjectDeepLink(input: OpenLocalProjectDeepLinkInput): string {
  const search = new URLSearchParams({
    machine: input.machineId,
    project: input.localProjectId,
  });

  const workspaceSlug = input.workspaceSlug?.trim();
  if (workspaceSlug) {
    search.set('workspaceSlug', workspaceSlug);
  }

  return `${getInstallationProfile().desktopProtocol}://chat/new?${search.toString()}`;
}
