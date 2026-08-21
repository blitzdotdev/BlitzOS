import { useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { FolderView } from '../file-library-api';
import { normalizeFolderName } from './drive-model';
import {
  DropLimitError,
  payloadFromPickedFiles,
  type DroppedFile,
  type DroppedPayload,
} from './drop-upload';

/** The template screen's upload pipeline: dropped folders become attached
 * Drive folders, and loose files wrap into one auto-created visible Drive
 * folder named after the template (created by the first loose file, reused
 * by later ones — nothing downstream learns a new attachment kind). Owns the
 * transient upload state; attachment, folder, and error state stay with the
 * screen through the callbacks. */
export function useTemplateUploads({
  client,
  templateName,
  onAttach,
  onFolders,
  onError,
}: {
  client: Pick<ControlPlaneClient, 'createFolder' | 'uploadFolderObject' | 'listFolders'>;
  /** The template name at upload time; it names the loose-files folder. */
  templateName: string;
  onAttach: (folderId: string) => void;
  onFolders: (folders: FolderView[]) => void;
  onError: (message: string) => void;
}) {
  const [uploading, setUploading] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  // Files uploaded through this screen, keyed by their folder, so the
  // attached sidebar can show a per-file count for the files folder.
  const [fileCounts, setFileCounts] = useState<Map<string, number>>(new Map());
  const filesFolderId = useRef<string | null>(null);

  /** Every Drive folder the webapp creates goes through normalizeFolderName
   * (drive-model), so the files folder gets the same slug treatment:
   * "starter files" persists as "starter-files". */
  const trimmed = templateName.trim();
  const normalized = trimmed === '' ? '' : normalizeFolderName(`${trimmed} files`);
  const looseFolderName = normalized === '' ? 'new-template-files' : normalized;

  const uploadLooseFiles = async (looseFiles: DroppedFile[]): Promise<void> => {
    let folderId = filesFolderId.current;
    if (folderId === null) {
      const { folder } = await client.createFolder(looseFolderName);
      folderId = folder.id;
      filesFolderId.current = folderId;
    }
    for (const { file, relativePath } of looseFiles) {
      await client.uploadFolderObject(folderId, relativePath, file);
    }
    const uploadedInto = folderId;
    onAttach(uploadedInto);
    setFileCounts((current) => new Map(current).set(
      uploadedInto,
      (current.get(uploadedInto) ?? 0) + looseFiles.length,
    ));
  };

  const uploadDropped = async (payload: DroppedPayload) => {
    if (payload.folders.length === 0 && payload.files.length === 0) {
      setDropHint('Nothing to upload in that drop');
      return;
    }
    setDropHint(null);
    for (const entry of payload.folders) {
      const folderName = normalizeFolderName(entry.name);
      if (folderName === '') continue;
      setUploading(folderName);
      try {
        const { folder } = await client.createFolder(folderName);
        for (const { file, relativePath } of entry.files) {
          await client.uploadFolderObject(folder.id, relativePath, file);
        }
        onAttach(folder.id);
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : 'Upload failed.');
        setUploading(null);
        return;
      }
    }
    if (payload.files.length > 0) {
      setUploading(payload.files.length === 1
        ? payload.files[0]?.file.name ?? 'files'
        : `${String(payload.files.length)} files`);
      try {
        await uploadLooseFiles(payload.files);
      } catch (caught) {
        onError(caught instanceof Error ? caught.message : 'Upload failed.');
        setUploading(null);
        return;
      }
    }
    setUploading(null);
    await client.listFolders()
      .then(({ folders: loaded }) => onFolders(loaded))
      .catch((caught: Error) => onError(caught.message));
  };

  const uploadPickedFiles = (picked: File[]) => {
    try {
      void uploadDropped(payloadFromPickedFiles(picked));
    } catch (caught) {
      if (caught instanceof DropLimitError) setDropHint(caught.message);
      else onError(caught instanceof Error ? caught.message : 'Upload failed.');
    }
  };

  return {
    uploading,
    dropHint,
    setDropHint,
    fileCounts,
    looseFolderName,
    uploadDropped,
    uploadPickedFiles,
  };
}
