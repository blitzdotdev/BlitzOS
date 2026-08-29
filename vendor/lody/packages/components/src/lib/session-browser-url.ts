import {
  buildManagedPreviewViewerUrl,
  removePreviewQueryParamFromSearch,
  type PreviewTarget,
} from '@lody/shared';

const isManagedCapabilityParam = (name: string): boolean =>
  name.startsWith('__lody_preview_') || name.startsWith('__lody_local_preview_');

const removeManagedCapabilityParams = (url: URL): void => {
  for (const name of [...url.searchParams.keys()]) {
    if (isManagedCapabilityParam(name)) {
      url.search = removePreviewQueryParamFromSearch(url.search, name);
    }
  }
};

export const samePreviewTargetOrigin = (
  left: PreviewTarget | undefined,
  right: PreviewTarget
): boolean =>
  !!left &&
  left.protocol === right.protocol &&
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.port === right.port;

export const buildManagedViewerUrl = (publicUrl: string, target: PreviewTarget): string =>
  buildManagedPreviewViewerUrl(publicUrl, target).toString();

// Inverse of toManagedLogicalUrl: the viewer URL for the page the frame is
// currently on, carrying over the capability params from the acquire-time URL.
export const buildManagedViewerUrlForLogicalUrl = (
  viewerUrl: string,
  logicalUrl: string
): string => {
  const viewer = new URL(viewerUrl);
  const logical = new URL(logicalUrl);
  const next = new URL(`${logical.pathname}${logical.search}${logical.hash}`, viewer);
  for (const [name, value] of viewer.searchParams) {
    if (isManagedCapabilityParam(name)) {
      next.searchParams.set(name, value);
    }
  }
  return next.toString();
};

export const toManagedLogicalUrl = (viewerLocation: string, logicalUrl: string): string => {
  const logical = new URL(logicalUrl);
  const viewer = new URL(viewerLocation, logical);
  logical.pathname = viewer.pathname;
  logical.search = viewer.search;
  logical.hash = viewer.hash;
  removeManagedCapabilityParams(logical);
  return logical.toString();
};

export const getManagedPageKey = (urlOrPath: string, logicalBaseUrl: string): string => {
  const url = new URL(urlOrPath, logicalBaseUrl);
  removeManagedCapabilityParams(url);
  return `${url.pathname}${url.search}${url.hash}`;
};
