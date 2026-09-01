import i18next from 'i18next';
import type {
  CodeCollabContentUnavailableReason,
  CodeCollabFileKind,
  CodeCollabFileSourceState,
} from '@lody/shared';
import type {
  SessionFileOpenResult,
  SessionFileProviderEntry,
  SessionFileProviderState,
} from './session-file-provider';

export type SessionFileProviderTone = 'default' | 'positive' | 'muted' | 'warning' | 'danger';

export type SessionFileProviderStateModel = {
  readonly title: string;
  readonly tone: SessionFileProviderTone;
  readonly message?: string;
};

export type SessionFileEntryModel = {
  readonly title: string;
  readonly detail: string;
  readonly kindLabel: string;
  readonly sourceLabel: string;
  readonly canOpen: boolean;
  readonly canEdit: boolean;
  readonly openDisabledReason?: string;
  readonly editDisabledReason?: string;
  readonly unavailableLabel?: string;
  readonly repairHint?: string;
  readonly tone: SessionFileProviderTone;
};

export type SessionFileOpenResultModel = {
  readonly title: string;
  readonly tone: SessionFileProviderTone;
  readonly message?: string;
  readonly repairHint?: string;
};

// View-model labels intentionally read from the global i18next instance
// rather than threading `t` through every callsite. Callers all subscribe
// to language changes via `useTranslation()`, so re-rendering on language
// switch already triggers a fresh view-model evaluation.
//
// Falls back to the English `defaultValue` (with manual `{{name}}` style
// interpolation) when i18next has not been initialized yet — this keeps
// vitest suites that import this module without bootstrapping i18n
// working without forcing every test file to set up an i18n test bed.
const t = (key: string, defaultValue: string, options?: Record<string, unknown>): string => {
  if (!i18next.isInitialized) {
    return interpolateFallback(defaultValue, options);
  }
  const result = i18next.t(key, { defaultValue, ...(options ?? {}) });
  return typeof result === 'string' ? result : interpolateFallback(defaultValue, options);
};

function interpolateFallback(template: string, options?: Record<string, unknown>): string {
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = options[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function getSessionFileProviderStateModel(
  state: SessionFileProviderState
): SessionFileProviderStateModel {
  if (!state.ready) {
    return {
      title: providerKindLabel(state.kind),
      tone: 'muted',
      ...(state.message ? { message: state.message } : {}),
    };
  }
  return {
    title: providerKindLabel(state.kind),
    tone: sourceStateTone(state.sourceState),
    message: state.message ?? sourceStateLabel(state.sourceState),
  };
}

export function getSessionFileEntryModel(entry: SessionFileProviderEntry): SessionFileEntryModel {
  const unavailableReason = entry.unavailableReason;
  const unavailableLabel = unavailableReason
    ? getSessionFileUnavailableReasonLabel(unavailableReason)
    : undefined;
  const canOpen = unavailableReason === undefined && entry.kind !== 'special';
  const canEdit =
    canOpen &&
    entry.kind === 'text' &&
    entry.readonly !== true &&
    entry.sourceState === 'live-collaborative';
  const openDisabledReason = canOpen ? undefined : disabledOpenReason(entry, unavailableLabel);
  const editDisabledReason = canEdit ? undefined : disabledEditReason(entry, openDisabledReason);
  const repairHint = unavailableReason
    ? getSessionFileUnavailableRepairHint(unavailableReason)
    : undefined;
  return {
    title: entry.path,
    detail: fileDetail(entry),
    kindLabel: fileKindLabel(entry.kind),
    sourceLabel: sourceStateLabel(entry.sourceState),
    canOpen,
    canEdit,
    ...(openDisabledReason ? { openDisabledReason } : {}),
    ...(editDisabledReason ? { editDisabledReason } : {}),
    ...(unavailableLabel ? { unavailableLabel } : {}),
    ...(repairHint ? { repairHint } : {}),
    tone: unavailableReason
      ? unavailableReasonTone(unavailableReason)
      : sourceStateTone(entry.sourceState),
  };
}

export function getSessionFileOpenResultModel(
  result: SessionFileOpenResult
): SessionFileOpenResultModel {
  if (result.status === 'ready') {
    return {
      title: result.entry.path,
      tone: 'positive',
    };
  }
  return {
    title: result.entry?.path ?? t('sessions.fileOpenResult.unavailable', 'File unavailable'),
    tone: unavailableReasonTone(result.reason),
    message: result.message ?? getSessionFileUnavailableReasonLabel(result.reason),
    repairHint: getSessionFileUnavailableRepairHint(result.reason),
  };
}

function providerKindLabel(kind: SessionFileProviderState['kind']): string {
  switch (kind) {
    case 'code-collab':
      return t('sessions.providerKind.codeCollab', 'Code Collab');
    case 'none':
      return t('sessions.providerKind.none', 'No file provider');
  }
  return assertNever(kind);
}

function fileKindLabel(kind: CodeCollabFileKind): string {
  switch (kind) {
    case 'text':
      return t('sessions.fileKind.text', 'Text');
    case 'binary':
      return t('sessions.fileKind.binary', 'Binary');
    case 'large':
      return t('sessions.fileKind.large', 'Large');
    case 'symlink':
      return t('sessions.fileKind.symlink', 'Symlink');
    case 'special':
      return t('sessions.fileKind.special', 'Special');
    case 'deleted':
      return t('sessions.fileKind.deleted', 'Deleted');
  }
  return assertNever(kind);
}

function sourceStateLabel(sourceState: CodeCollabFileSourceState): string {
  switch (sourceState) {
    case 'live-collaborative':
      return t('sessions.fileSource.live', 'Live');
    case 'live-readonly':
      return t('sessions.fileSource.liveReadonly', 'Read only');
    case 'historical-turn':
      return t('sessions.fileSource.historicalTurn', 'Historical');
    case 'host-offline':
      return t('sessions.fileSource.hostOffline', 'Host offline');
    case 'degraded':
      return t('sessions.fileSource.degraded', 'Limited');
  }
  return assertNever(sourceState);
}

function sourceStateTone(sourceState: CodeCollabFileSourceState): SessionFileProviderTone {
  switch (sourceState) {
    case 'live-collaborative':
      return 'positive';
    case 'live-readonly':
    case 'historical-turn':
      return 'muted';
    case 'host-offline':
      return 'warning';
    case 'degraded':
      return 'danger';
  }
  return assertNever(sourceState);
}

export function getSessionFileUnavailableReasonLabel(
  reason: CodeCollabContentUnavailableReason
): string {
  switch (reason) {
    case 'deleted':
      return t('sessions.fileUnavailable.deleted', 'Deleted');
    case 'metadata-only':
      return t('sessions.fileUnavailable.metadataOnly', 'Metadata only');
    case 'missing-text-frontiers':
      return t('sessions.fileUnavailable.missingTextFrontiers', 'Text history missing');
    case 'missing-blob-digest':
      return t('sessions.fileUnavailable.missingBlobDigest', 'Blob digest missing');
    case 'blob-expired':
      return t('sessions.fileUnavailable.blobExpired', 'Blob expired');
    case 'permission-denied':
      return t('sessions.fileUnavailable.permissionDenied', 'Permission denied');
    case 'locked':
      return t('sessions.fileUnavailable.locked', 'Locked');
    case 'transient-io':
      return t('sessions.fileUnavailable.transientIo', 'Temporary IO error');
    case 'text-too-large':
      return t('sessions.fileUnavailable.textTooLarge', 'Text too large');
    case 'line-too-long':
      return t('sessions.fileUnavailable.lineTooLong', 'Line too long');
    case 'unsupported-encoding':
      return t('sessions.fileUnavailable.unsupportedEncoding', 'Unsupported encoding');
    case 'unsupported-special':
      return t('sessions.fileUnavailable.unsupportedSpecial', 'Unsupported file');
    case 'blob-too-large':
      return t('sessions.fileUnavailable.blobTooLarge', 'Blob too large');
    case 'path-collision':
      return t('sessions.fileUnavailable.pathCollision', 'Path collision');
    case 'unknown':
      return t('sessions.fileUnavailable.unknown', 'Unknown error');
  }
  return assertNever(reason);
}

export function getSessionFileUnavailableRepairHint(
  reason: CodeCollabContentUnavailableReason
): string {
  switch (reason) {
    case 'deleted':
      return t(
        'sessions.fileRepairHint.deleted',
        'Open the recreated file from the file tree if it still exists.'
      );
    case 'metadata-only':
      return t(
        'sessions.fileRepairHint.metadataOnly',
        'Ask the host to rebuild the Code Collab file index.'
      );
    case 'missing-text-frontiers':
      return t(
        'sessions.fileRepairHint.missingTextFrontiers',
        'Ask the host to republish text history for this turn.'
      );
    case 'missing-blob-digest':
      return t(
        'sessions.fileRepairHint.missingBlobDigest',
        'Ask the host to re-upload the binary blob.'
      );
    case 'blob-expired':
      return t('sessions.fileRepairHint.blobExpired', 'Ask the host to re-upload the binary blob.');
    case 'permission-denied':
      return t(
        'sessions.fileRepairHint.permissionDenied',
        'Check workspace permissions or ask the host to grant access.'
      );
    case 'locked':
      return t('sessions.fileRepairHint.locked', 'Retry after the host releases the file lock.');
    case 'transient-io':
      return t('sessions.fileRepairHint.transientIo', 'Retry after the host file system recovers.');
    case 'text-too-large':
      return t(
        'sessions.fileRepairHint.textTooLarge',
        'Open this file outside realtime collaboration.'
      );
    case 'line-too-long':
      return t(
        'sessions.fileRepairHint.lineTooLong',
        'Open or reformat this file outside realtime collaboration.'
      );
    case 'unsupported-encoding':
      return t(
        'sessions.fileRepairHint.unsupportedEncoding',
        'Convert the file to UTF-8 before using realtime collaboration.'
      );
    case 'unsupported-special':
      return t(
        'sessions.fileRepairHint.unsupportedSpecial',
        'Open this special file on the host machine instead.'
      );
    case 'blob-too-large':
      return t(
        'sessions.fileRepairHint.blobTooLarge',
        'Use a normal artifact link or external storage for this large binary.'
      );
    case 'path-collision':
      return t(
        'sessions.fileRepairHint.pathCollision',
        'Rename one of the colliding paths on a case-insensitive file system.'
      );
    case 'unknown':
      return t(
        'sessions.fileRepairHint.unknown',
        'Retry, then inspect host logs if the issue persists.'
      );
  }
  return assertNever(reason);
}

function unavailableReasonTone(
  reason: CodeCollabContentUnavailableReason
): SessionFileProviderTone {
  switch (reason) {
    case 'permission-denied':
    case 'locked':
    case 'path-collision':
      return 'warning';
    case 'transient-io':
    case 'unknown':
      return 'danger';
    default:
      return 'muted';
  }
}

function disabledOpenReason(
  entry: SessionFileProviderEntry,
  unavailableLabel: string | undefined
): string {
  if (unavailableLabel) return unavailableLabel;
  if (entry.kind === 'special') {
    return t('sessions.fileAction.openDisabledSpecial', 'Special files cannot be opened');
  }
  return t('sessions.fileAction.openDisabledGeneric', 'File cannot be opened');
}

function disabledEditReason(
  entry: SessionFileProviderEntry,
  openDisabledReason: string | undefined
): string {
  if (openDisabledReason) return openDisabledReason;
  if (entry.kind !== 'text') {
    return t('sessions.fileAction.editDisabledNonText', 'Only text files can be edited');
  }
  if (entry.readonly === true) {
    return t('sessions.fileAction.editDisabledReadonly', 'File is read only');
  }
  if (entry.sourceState !== 'live-collaborative') {
    return t('sessions.fileAction.editDisabledSourceState', '{{label}} files are read only', {
      label: sourceStateLabel(entry.sourceState),
    });
  }
  return t('sessions.fileAction.editDisabledGeneric', 'File cannot be edited');
}

function fileDetail(entry: SessionFileProviderEntry): string {
  const parts = [
    entry.kind === 'special' && entry.specialKind
      ? specialKindLabel(entry.specialKind)
      : fileKindLabel(entry.kind),
    sourceStateLabel(entry.sourceState),
  ];
  if (entry.sizeBytes !== undefined) {
    parts.push(formatBytes(entry.sizeBytes));
  }
  if (entry.kind === 'text' && entry.textEol && entry.textEol !== 'unknown') {
    parts.push(entry.textEol.toUpperCase());
  }
  if (entry.kind === 'text' && entry.hasBom === true) {
    parts.push('BOM');
  }
  if (entry.executable === true) {
    parts.push('Executable');
  }
  return parts.join(' · ');
}

function specialKindLabel(
  specialKind: NonNullable<SessionFileProviderEntry['specialKind']>
): string {
  switch (specialKind) {
    case 'fifo':
      return t('sessions.specialKind.fifo', 'FIFO');
    case 'socket':
      return t('sessions.specialKind.socket', 'Socket');
    case 'block-device':
      return t('sessions.specialKind.blockDevice', 'Block device');
    case 'char-device':
      return t('sessions.specialKind.charDevice', 'Character device');
    case 'unknown':
      return t('sessions.specialKind.unknown', 'Special');
  }
  return assertNever(specialKind);
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session file provider view model value: ${String(value)}`);
}
