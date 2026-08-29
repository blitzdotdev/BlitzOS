type FileTransferItem = Pick<DataTransferItem, 'kind' | 'getAsFile'>;
type FileDropDataTransfer = {
  types?: ArrayLike<string> | Iterable<string>;
  items?: ArrayLike<FileTransferItem> | Iterable<FileTransferItem>;
  files?: ArrayLike<File> | Iterable<File>;
};

const toArray = <T>(value: ArrayLike<T> | Iterable<T> | null | undefined): T[] => {
  if (!value) {
    return [];
  }
  return Array.from(value);
};

export const hasFileTransfer = (
  dataTransfer: Pick<FileDropDataTransfer, 'types'> | null | undefined
): boolean => {
  if (!dataTransfer) {
    return false;
  }
  return toArray(dataTransfer.types).some((type) => type === 'Files');
};

export const getFilesFromDataTransfer = (
  dataTransfer: Pick<FileDropDataTransfer, 'items' | 'files'>
): File[] => {
  const itemFiles = toArray<FileTransferItem>(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return toArray<File>(dataTransfer.files);
};

export const splitImageAndFileAttachments = (
  files: File[]
): { images: File[]; attachments: File[] } => ({
  images: files.filter((file) => file.type.startsWith('image/')),
  attachments: files.filter((file) => !file.type.startsWith('image/')),
});
