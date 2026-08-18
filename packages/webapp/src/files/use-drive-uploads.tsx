import { useCallback, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import type { FolderView } from '../file-library-api';
import type { UploadState } from './drive-chrome';

export interface UploadEntry {
  file: File;
  key: string;
}

/** Sequential folder-object uploads with progress, cancel, and refresh. */
export function useDriveUploads({
  client,
  currentFolderId,
  loadObjects,
  loadFolders,
  showSnack,
  onError,
}: {
  client: ControlPlaneClient;
  currentFolderId: string | null;
  loadObjects: (folderId: string) => Promise<void>;
  loadFolders: () => Promise<void>;
  showSnack: (message: React.ReactNode) => void;
  onError: (message: string) => void;
}) {
  const [upload, setUpload] = useState<UploadState | null>(null);
  const uploadRun = useRef(0);

  const cancelUpload = useCallback(() => {
    uploadRun.current += 1;
    setUpload(null);
  }, []);

  const uploadEntries = async (target: FolderView, entries: UploadEntry[]): Promise<boolean> => {
    const count = entries.length;
    const run = uploadRun.current + 1;
    uploadRun.current = run;
    for (const [position, { file, key }] of entries.entries()) {
      if (uploadRun.current !== run) {
        showSnack(<span>Upload canceled — {position} of {count} finished</span>);
        if (target.id === currentFolderId) await loadObjects(target.id);
        await loadFolders();
        return false;
      }
      const progress = (sent: number, total: number) => {
        setUpload({
          name: file.name,
          sent,
          total,
          done: false,
          folderName: target.name,
          index: position + 1,
          count,
        });
      };
      progress(0, file.size);
      try {
        await client.uploadFolderObject(target.id, key, file, progress);
      } catch (caught) {
        setUpload(null);
        onError(caught instanceof Error ? caught.message : 'Upload failed.');
        return false;
      }
    }
    const last = entries[count - 1];
    if (last !== undefined) {
      setUpload({
        name: last.file.name,
        sent: last.file.size,
        total: last.file.size,
        done: true,
        folderName: target.name,
        index: count,
        count,
      });
    }
    showSnack(count === 1
      ? <span><b>{last?.file.name}</b> uploaded to {target.name}</span>
      : <span><b>{count} files</b> uploaded to {target.name}</span>);
    window.setTimeout(() => {
      setUpload((current) => (current?.done ? null : current));
    }, 3_200);
    if (target.id === currentFolderId) await loadObjects(target.id);
    await loadFolders();
    return true;
  };

  return { upload, uploadEntries, cancelUpload };
}
