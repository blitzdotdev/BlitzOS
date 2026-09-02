import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SESSION_FILE_MAX_COUNT,
  type MachineId,
  type SessionFilePayload,
  type SessionId,
  type SessionInputBlock,
  type WorkspaceId,
} from '@lody/shared';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { formatFileSize } from '@/lib/session-file-presentation';
import {
  canUseElectronLocalFileSend,
  sendSessionFileToLocalRuntime,
} from '@/lib/electron-session-file-sender';
import { useIpcClient } from '@/providers/ipc-client-provider';
import {
  SESSION_FILE_MAX_SIZE_MB,
  computeSha256Hex,
  computeTextPreviewable,
  isUploadAbortedError,
  isSessionFileTransferPhase,
  uploadSessionFile,
  validateSessionFile,
  type SessionFileTransferPhase,
  type SessionFileUploadProgress,
} from '@/lib/session-file-upload';

type PendingFile = {
  localId: string;
  file: File;
  status: SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
  uploaded?: SessionFilePayload;
  abort?: AbortController;
};

export type ChatLandingFileDraftItem = {
  id: string;
  name: string;
  sizeLabel: string;
  status: SessionFileTransferPhase | 'uploaded' | 'failed';
  progress: number;
  error?: string;
};

const toFileInputBlock = (file: SessionFilePayload): SessionInputBlock => ({
  type: 'file',
  fileId: file.fileId,
  fileName: file.fileName,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  textPreview: file.textPreview,
  transport: file.transport,
  ...(file.machineId === undefined ? {} : { machineId: file.machineId }),
  uploadedAt: file.uploadedAt,
});

const createLocalFileId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * File-attachment draft for the chat-landing composer — the non-image sibling of
 * {@link useChatLandingImageDraft}. Owns its own pending-file state machine, but
 * shares the eventual session id from the landing draft identity via the injected
 * `sessionId` / `ensureSessionId` so images and files uploaded before
 * the session exists are scoped to the same `createSession({ sessionId })`.
 *
 * Mirrors the in-session file path (`session-chat-input-area.tsx`): the desktop
 * local-transport fast path hands bytes straight to the local CLI when the
 * selected machine is this machine's runtime; otherwise the file uploads to the
 * cloud (R2) with sha256 + text-previewability computed once up front and abort
 * support for removal mid-flight.
 */
export function useChatLandingFileDraft(args: {
  workspaceId: WorkspaceId | null;
  authToken: string | null;
  /** Selected machine for the eventual session; enables the local fast path. */
  machineId: MachineId | null;
  /** Shared landing identity used by attachments, preparation, and createSession. */
  sessionId: SessionId | null;
  ensureSessionId: () => SessionId;
}) {
  const ipcClient = useIpcClient();
  const { t } = useTranslation();
  const { workspaceId, authToken, machineId, sessionId: draftSessionId, ensureSessionId } = args;
  const localMachineId = useAtomValue(localMachineIdAtom);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);

  // Desktop local-transport fast path: available only when the selected machine
  // is this machine's local CLI and the Electron preload bridge exposes the
  // handoff API. Otherwise file attachments take the cloud-upload path.
  const canSendFileLocally =
    !!localMachineId &&
    !!machineId &&
    localMachineId === machineId &&
    canUseElectronLocalFileSend(ipcClient);

  const fileUploadFailedLabel = t('sessions.fileUploadFailed', 'File upload failed');
  const fileUploadMissingAuthLabel = t(
    'sessions.fileUploadMissingAuth',
    'Missing workspace or auth token'
  );

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      for (const entry of prev) {
        entry.abort?.abort();
      }
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      setPendingFiles((prev) => {
        for (const entry of prev) {
          entry.abort?.abort();
        }
        return [];
      });
    };
  }, []);

  const updatePendingFile = useCallback(
    (localId: string, updater: (file: PendingFile) => PendingFile) => {
      setPendingFiles((prev) =>
        prev.map((entry) => (entry.localId === localId ? updater(entry) : entry))
      );
    },
    []
  );

  const startUpload = useCallback(
    async (localId: string, file: File, sessionId: SessionId) => {
      // Desktop local-transport fast path: hand bytes straight to the local CLI
      // (zero relay round trip). The CLI returns a transport:'local' block that
      // drops into `uploaded` exactly like a cloud upload. On any failure we fall
      // through to the cloud path below.
      //
      // It runs BEFORE the cloud-credential guard, because the handoff needs no
      // cloud token: a local-only composition has none, and would otherwise fail
      // every attachment at a check for credentials it never uses.
      if (canSendFileLocally && workspaceId && machineId) {
        try {
          const outcome = await sendSessionFileToLocalRuntime({
            workspaceId,
            sessionId,
            machineId,
            file,
            ipcClient,
          });
          if (outcome?.ok && outcome.files[0]) {
            updatePendingFile(localId, (entry) => ({
              ...entry,
              status: 'uploaded',
              progress: 100,
              uploaded: outcome.files[0],
              error: undefined,
              abort: undefined,
            }));
            return;
          }
        } catch {
          // Local handoff threw; fall back to the cloud upload path.
        }
      }

      if (!workspaceId || !authToken) {
        updatePendingFile(localId, (entry) => ({
          ...entry,
          status: 'failed',
          progress: 0,
          error: fileUploadMissingAuthLabel,
        }));
        return;
      }

      const abort = new AbortController();
      updatePendingFile(localId, (entry) => ({
        ...entry,
        status: 'preparing',
        progress: 0,
        error: undefined,
        abort,
      }));

      try {
        // Compute the integrity hash + text-previewability once before upload;
        // both ride along to the server and the latter pre-fills the block.
        const [sha256, textPreview] = await Promise.all([
          computeSha256Hex(file, {
            signal: abort.signal,
            onProgress: (progress) => {
              updatePendingFile(localId, (entry) => ({
                ...entry,
                status: progress.phase,
                progress: progress.percent,
              }));
            },
          }),
          computeTextPreviewable(file),
        ]);
        const uploaded = await uploadSessionFile({
          workspaceId,
          sessionId,
          token: authToken,
          file,
          sha256,
          textPreview,
          signal: abort.signal,
          onProgress: (progress: SessionFileUploadProgress) => {
            updatePendingFile(localId, (entry) => ({
              ...entry,
              status: progress.phase,
              progress: progress.percent,
            }));
          },
        });
        updatePendingFile(localId, (entry) => ({
          ...entry,
          status: 'uploaded',
          progress: 100,
          uploaded,
          error: undefined,
          abort: undefined,
        }));
      } catch (error) {
        if (isUploadAbortedError(error)) {
          // Removal/clearing aborts in-flight uploads; the entry is already
          // gone, so leave state untouched.
          return;
        }
        const errorMessage = error instanceof Error ? error.message : fileUploadFailedLabel;
        updatePendingFile(localId, (entry) => ({
          ...entry,
          status: 'failed',
          progress: 0,
          error: errorMessage,
          abort: undefined,
        }));
      }
    },
    [
      authToken,
      canSendFileLocally,
      fileUploadFailedLabel,
      fileUploadMissingAuthLabel,
      ipcClient,
      machineId,
      updatePendingFile,
      workspaceId,
    ]
  );

  const handleAddFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        return;
      }

      const nextEntries: PendingFile[] = [];
      const issues: string[] = [];
      let currentCount = pendingFiles.length;

      for (const file of files) {
        if (currentCount >= SESSION_FILE_MAX_COUNT) {
          issues.push(
            t('sessions.fileCountLimit', 'At most {{count}} files are allowed', {
              count: SESSION_FILE_MAX_COUNT,
            })
          );
          continue;
        }

        const validationError = validateSessionFile(file);
        if (validationError) {
          issues.push(
            validationError === 'empty'
              ? t('sessions.fileEmpty', 'File is empty: {{name}}', { name: file.name })
              : t('sessions.fileTooLarge', 'File must be ≤ {{max}}MB: {{name}}', {
                  max: SESSION_FILE_MAX_SIZE_MB,
                  name: file.name,
                })
          );
          continue;
        }

        nextEntries.push({
          localId: createLocalFileId(),
          file,
          status: 'preparing',
          progress: 0,
        });
        currentCount += 1;
      }

      if (issues.length > 0) {
        toast.error(issues[0]!);
      }

      if (nextEntries.length === 0) {
        return;
      }

      const sessionId = ensureSessionId();
      setPendingFiles((prev) => [...prev, ...nextEntries]);
      for (const entry of nextEntries) {
        void startUpload(entry.localId, entry.file, sessionId);
      }
    },
    [ensureSessionId, pendingFiles.length, startUpload, t]
  );

  const handleRemoveFile = useCallback((localId: string) => {
    setPendingFiles((prev) => {
      const target = prev.find((entry) => entry.localId === localId);
      target?.abort?.abort();
      return prev.filter((entry) => entry.localId !== localId);
    });
  }, []);

  const handleRetryFile = useCallback(
    (localId: string) => {
      const target = pendingFiles.find((entry) => entry.localId === localId);
      if (!target) {
        return;
      }
      const uploadSessionId = draftSessionId ?? ensureSessionId();
      void startUpload(localId, target.file, uploadSessionId);
    },
    [draftSessionId, ensureSessionId, pendingFiles, startUpload]
  );

  const hasBlockingFiles = useMemo(
    () => pendingFiles.some((entry) => isSessionFileTransferPhase(entry.status)),
    [pendingFiles]
  );

  const hasUploadedFiles = useMemo(
    () => pendingFiles.some((entry) => entry.status === 'uploaded' && !!entry.uploaded),
    [pendingFiles]
  );

  const fileItems = useMemo<ChatLandingFileDraftItem[]>(
    () =>
      pendingFiles.map((entry) => ({
        id: entry.localId,
        name: entry.file.name,
        sizeLabel: formatFileSize(entry.file.size),
        status: entry.status,
        progress: entry.progress,
        error: entry.error,
      })),
    [pendingFiles]
  );

  const buildFileInputBlocks = useCallback(
    (): SessionInputBlock[] =>
      pendingFiles
        .filter((entry): entry is PendingFile & { uploaded: SessionFilePayload } => {
          return entry.status === 'uploaded' && !!entry.uploaded;
        })
        .map((entry) => toFileInputBlock(entry.uploaded)),
    [pendingFiles]
  );

  return {
    fileItems,
    hasBlockingFiles,
    hasUploadedFiles,
    canAddMoreFiles: pendingFiles.length < SESSION_FILE_MAX_COUNT,
    /** Whether this draft can stage bytes with no cloud token. The image draft
     * beside it asks before degrading an image it cannot upload into a file. */
    canSendFileLocally,
    addFiles: handleAddFiles,
    handleRemoveFile,
    handleRetryFile,
    clearPendingFiles,
    buildFileInputBlocks,
  };
}
