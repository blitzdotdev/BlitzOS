export type IndexAsset = {
  extension: 'css' | 'js';
  hash: string;
};

export type UpdateCheckState = {
  check: 'interval' | 'refocus';
  currentHash: string | null;
  targetHash: string | null;
  visible: boolean;
  targetAlreadyReloaded: boolean;
};

export type UpdateAction = 'ignore' | 'reload' | 'toast';

const INDEX_ASSET_PATTERN = /\/assets\/index-([A-Za-z0-9_-]+)\.(css|js)(?=["'?#\s>]|$)/gu;

export function extractIndexAsset(
  source: string,
  extension?: IndexAsset['extension'],
): IndexAsset | null {
  for (const match of source.matchAll(INDEX_ASSET_PATTERN)) {
    if (extension && match[2] !== extension) continue;
    return {
      extension: match[2] as IndexAsset['extension'],
      hash: match[1]!,
    };
  }
  return null;
}

export function decideUpdateAction(state: UpdateCheckState): UpdateAction {
  if (
    !state.currentHash
    || !state.targetHash
    || state.currentHash === state.targetHash
  ) return 'ignore';

  if (!state.visible) return 'ignore';
  if (state.check === 'refocus' && !state.targetAlreadyReloaded) return 'reload';
  return 'toast';
}
