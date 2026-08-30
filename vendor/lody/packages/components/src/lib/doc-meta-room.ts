import {
  AGENT_CONFIG_DOC_PREFIX,
  isSessionDocRoomId,
  MACHINE_DOC_PREFIX,
  SESSION_DOC_PREFIX,
} from '@lody/shared';

export type DocMetaRoomKind = 'session' | 'machine' | 'agentConfig';

export function getDocMetaRoomKind(roomId: string): DocMetaRoomKind | undefined {
  if (isSessionDocRoomId(roomId)) return 'session';
  if (roomId.startsWith(MACHINE_DOC_PREFIX)) return 'machine';
  if (roomId.startsWith(AGENT_CONFIG_DOC_PREFIX)) return 'agentConfig';
  return undefined;
}

export function deriveDocMetaEntityId(roomId: string): string | undefined {
  const kind = getDocMetaRoomKind(roomId);
  if (kind === 'session') return roomId.slice(SESSION_DOC_PREFIX.length);
  if (kind === 'machine') return roomId.slice(MACHINE_DOC_PREFIX.length);
  if (kind === 'agentConfig') return roomId.slice(AGENT_CONFIG_DOC_PREFIX.length);
  return undefined;
}

export function withDerivedDocMetaId<T extends Record<string, unknown>>(
  roomId: string,
  meta: T
): T {
  if (typeof meta.id === 'string' && meta.id !== '') {
    return meta;
  }

  const id = deriveDocMetaEntityId(roomId);
  return id ? ({ ...meta, id } as T) : meta;
}
