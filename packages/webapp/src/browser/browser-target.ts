/**
 * What the browser panel can show, and how each is reached.
 *
 * Three kinds, one per thing an address bar entry or `blitz browser open` can
 * name. A PORT on the box is embedded through the gateway's `/preview/<port>/`
 * proxy; a FILE under /workspace through the gateway's `/workspace/` surface,
 * where dufs serves that directory with real content types; an app URL
 * directly, when its host is one we embed (`isEmbeddablePreviewUrl`). The
 * first two are the page's own origin, so the panel can read the frame's
 * location back and keep the address bar true; an app frame is cross-origin
 * and reports its location through `blitz-browser:location` (see the panel).
 */
import { isPreviewAppUrl, isPreviewFile, isPreviewPath, isPreviewPort } from '@blitzos/schema';
import { isEmbeddablePreviewUrl, previewUrl, type PreviewFocus } from '../preview';

export type BrowserTarget =
  | { kind: 'port'; port: number; path: string }
  | { kind: 'file'; file: string }
  | { kind: 'url'; url: string };

const WORKSPACE_ROOT = '/workspace/';
const LOCAL_PORT = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d+)(\/.*)?$/u;

/** One typed address: `3000`, `localhost:3000/docs`, `/workspace/site/x.html`,
 * `site/x.html`, `https://demo.app.teenyapp.com`. Null when it is none of those. */
export function parseBrowserAddress(input: string): BrowserTarget | null {
  const text = input.trim();
  if (text === '') return null;
  if (/^\d+$/u.test(text)) return portTarget(Number(text), '/');
  const local = LOCAL_PORT.exec(text);
  if (local !== null) return portTarget(Number(local[1]), local[2] ?? '/');
  if (/^https?:\/\//iu.test(text)) return isPreviewAppUrl(text) ? { kind: 'url', url: text } : null;
  if (text.startsWith('/')) return isPreviewFile(text) ? { kind: 'file', file: text } : null;
  // A bare host is an app; anything else is a file relative to the workspace.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/u.test(text)) return parseBrowserAddress(`https://${text}`);
  const file = `${WORKSPACE_ROOT}${text}`;
  return isPreviewFile(file) ? { kind: 'file', file } : null;
}

function portTarget(port: number, path: string): BrowserTarget | null {
  return isPreviewPort(port) && isPreviewPath(path) ? { kind: 'port', port, path } : null;
}

/** What the address bar shows for a target. */
export function browserAddress(target: BrowserTarget): string {
  if (target.kind === 'port') return `localhost:${target.port}${target.path === '/' ? '' : target.path}`;
  if (target.kind === 'file') return target.file;
  return target.url;
}

/** The URL the iframe loads, or null for an app host we do not embed. */
export function browserFrameUrl(target: BrowserTarget, filesBase: string): string | null {
  if (target.kind === 'port') return previewUrl(filesBase, target.port, target.path);
  if (target.kind === 'file') {
    return `${filesBase}${target.file.slice(WORKSPACE_ROOT.length).split('/').map(encodeURIComponent).join('/')}`;
  }
  return isEmbeddablePreviewUrl(target.url) ? target.url : null;
}

/** The target a same-origin frame is showing, read back from its location, so
 * the address bar follows navigation inside a port or file. Null for a URL that
 * is not one of the gateway's two surfaces. */
export function browserTargetFromFrameUrl(href: string, filesBase: string): BrowserTarget | null {
  const base = new URL(filesBase);
  const url = new URL(href);
  if (url.origin !== base.origin) return null;
  const gatewayRoot = base.pathname.slice(0, -WORKSPACE_ROOT.length + 1);
  if (url.pathname.startsWith(base.pathname)) {
    return { kind: 'file', file: `${WORKSPACE_ROOT}${decodeURIComponent(url.pathname.slice(base.pathname.length))}` };
  }
  const preview = new RegExp(`^${gatewayRoot.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}preview/(\\d+)(/.*)?$`, 'u')
    .exec(url.pathname);
  if (preview === null) return null;
  return { kind: 'port', port: Number(preview[1]), path: `${preview[2] ?? '/'}${url.search}` };
}

/** The panel's target for a focus the box raised. */
export function browserTargetFromFocus(focus: PreviewFocus): BrowserTarget {
  if (focus.kind === 'port') return { kind: 'port', port: focus.port, path: focus.path };
  if (focus.kind === 'file') return { kind: 'file', file: focus.file };
  return { kind: 'url', url: focus.url };
}

export function sameBrowserTarget(a: BrowserTarget | null, b: BrowserTarget | null): boolean {
  return a !== null && b !== null && browserAddress(a) === browserAddress(b);
}
