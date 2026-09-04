import { describe, expect, it } from 'vitest';
import {
  browserAddress,
  browserFrameUrl,
  browserTargetFromFocus,
  browserTargetFromFrameUrl,
  parseBrowserAddress,
} from '../src/browser/browser-target.js';

// The files base the resolver hands out ends in the dufs root, `workspace/`.
const filesBase = 'https://app.example/workspaces/ws-1/webapp/7445/workspace/';

describe('parseBrowserAddress', () => {
  it('reads a port, with or without a host and path', () => {
    expect(parseBrowserAddress('3000')).toEqual({ kind: 'port', port: 3000, path: '/' });
    expect(parseBrowserAddress('localhost:5173/docs?x=1')).toEqual({ kind: 'port', port: 5173, path: '/docs?x=1' });
    expect(parseBrowserAddress('http://127.0.0.1:8080')).toEqual({ kind: 'port', port: 8080, path: '/' });
    // A reserved box port is not a preview.
    expect(parseBrowserAddress('7445')).toBeNull();
  });

  it('reads a file under /workspace, absolute or relative', () => {
    expect(parseBrowserAddress('/workspace/site/index.html')).toEqual({ kind: 'file', file: '/workspace/site/index.html' });
    expect(parseBrowserAddress('site/index.html')).toEqual({ kind: 'file', file: '/workspace/site/index.html' });
    expect(parseBrowserAddress('/etc/passwd')).toBeNull();
    expect(parseBrowserAddress('/workspace/a/../../etc/passwd')).toBeNull();
  });

  it('reads an https app URL, with or without its scheme', () => {
    expect(parseBrowserAddress('https://demo.app.teenyapp.com/x')).toEqual({ kind: 'url', url: 'https://demo.app.teenyapp.com/x' });
    expect(parseBrowserAddress('demo.app.teenyapp.com')).toEqual({ kind: 'url', url: 'https://demo.app.teenyapp.com' });
    expect(parseBrowserAddress('http://demo.app.teenyapp.com')).toBeNull();
    expect(parseBrowserAddress('')).toBeNull();
  });
});

describe('browserFrameUrl', () => {
  it('routes a port through the gateway preview proxy and a file through its workspace surface', () => {
    expect(browserFrameUrl({ kind: 'port', port: 3000, path: '/docs' }, filesBase))
      .toBe('https://app.example/workspaces/ws-1/webapp/7445/preview/3000/docs');
    expect(browserFrameUrl({ kind: 'file', file: '/workspace/site/a b.html' }, filesBase))
      .toBe('https://app.example/workspaces/ws-1/webapp/7445/workspace/site/a%20b.html');
  });

  it('embeds an allowlisted app and refuses any other host', () => {
    expect(browserFrameUrl({ kind: 'url', url: 'https://demo.app.teenyapp.com/' }, filesBase))
      .toBe('https://demo.app.teenyapp.com/');
    expect(browserFrameUrl({ kind: 'url', url: 'https://example.com/' }, filesBase)).toBeNull();
  });
});

describe('browserTargetFromFrameUrl', () => {
  it('reads a same-origin frame back into the target it shows', () => {
    expect(browserTargetFromFrameUrl(
      'https://app.example/workspaces/ws-1/webapp/7445/preview/3000/about?tab=2', filesBase,
    )).toEqual({ kind: 'port', port: 3000, path: '/about?tab=2' });
    expect(browserTargetFromFrameUrl(
      'https://app.example/workspaces/ws-1/webapp/7445/workspace/site/a%20b.html', filesBase,
    )).toEqual({ kind: 'file', file: '/workspace/site/a b.html' });
    expect(browserTargetFromFrameUrl('https://app.example/somewhere/else', filesBase)).toBeNull();
    expect(browserTargetFromFrameUrl('https://demo.app.teenyapp.com/', filesBase)).toBeNull();
  });
});

describe('browserAddress and browserTargetFromFocus', () => {
  it('shows each kind the way it was typed', () => {
    expect(browserAddress({ kind: 'port', port: 3000, path: '/' })).toBe('localhost:3000');
    expect(browserAddress({ kind: 'port', port: 3000, path: '/docs' })).toBe('localhost:3000/docs');
    expect(browserAddress({ kind: 'file', file: '/workspace/x.html' })).toBe('/workspace/x.html');
    expect(browserAddress({ kind: 'url', url: 'https://demo.app.teenyapp.com/' })).toBe('https://demo.app.teenyapp.com/');
  });

  it('drops the focus fields the panel does not show', () => {
    expect(browserTargetFromFocus({ kind: 'file', file: '/workspace/x.html', title: 'x', requestedAt: 1 }))
      .toEqual({ kind: 'file', file: '/workspace/x.html' });
  });
});
