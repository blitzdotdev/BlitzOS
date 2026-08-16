import type { V2WorkspaceRecord } from './api-adapter.js';
import type { BoxEndpoints, EndpointResolver } from './resolver.js';

export type WorkspaceEndpoints = BoxEndpoints & {
  label: string;
  wire: V2WorkspaceRecord['wire'];
};

export function terminalWebSocketUrl(value: string): string {
  const target = new URL(value, window.location.href);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = `${target.pathname.replace(/\/+$/u, '')}/ws`;
  target.search = '';
  target.hash = '';
  return target.toString();
}

export function rememberWorkspaceEndpoints(
  entries: Map<string, WorkspaceEndpoints>,
  records: V2WorkspaceRecord[],
  resolver: EndpointResolver,
  authoritative = false,
): void {
  if (authoritative) {
    const ids = new Set(records.map(({ id }) => id));
    for (const id of entries.keys()) {
      if (!ids.has(id)) entries.delete(id);
    }
  }
  for (const record of records) {
    const endpoints = resolver.resolve(record.wire);
    entries.set(record.id, {
      ...endpoints,
      terminalUrl: terminalWebSocketUrl(endpoints.terminalUrl),
      label: record.ingressLabel,
      wire: record.wire,
    });
  }
}
