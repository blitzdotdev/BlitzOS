import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageQueueItem } from '@lody/shared';
import { extractPromptPreviewFromInputBlocks, normalizeSessionInputBlocks } from '@lody/shared';

export function getEditableTaskText(item: MessageQueueItem): string {
  const blocks = normalizeSessionInputBlocks(
    item.acpSessionConfig?.inputBlocks,
    item.acpSessionConfig?.prompt ?? ''
  );
  const text = extractPromptPreviewFromInputBlocks(blocks);
  return text || item.acpSessionConfig?.prompt || item.task;
}

export type MessageQueueEditingCallbacks = {
  onEditStart: (item: MessageQueueItem) => void | Promise<void>;
  onEditCancel: (item: MessageQueueItem) => void | Promise<void>;
  onEditSave: (item: MessageQueueItem, task: string) => void | Promise<void>;
};

export type MessageQueueEditing = {
  editingCid: string | null;
  editValue: string;
  pendingCid: string | null;
  setEditValue: (value: string) => void;
  startEdit: (item: MessageQueueItem) => Promise<void>;
  cancelEdit: (item: MessageQueueItem) => Promise<void>;
  saveEdit: (item: MessageQueueItem) => Promise<void>;
};

export function useMessageQueueEditing(
  items: MessageQueueItem[],
  callbacks: MessageQueueEditingCallbacks
): MessageQueueEditing {
  const { onEditStart, onEditCancel, onEditSave } = callbacks;
  const [editingCid, setEditingCid] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [pendingCid, setPendingCid] = useState<string | null>(null);

  // Refs so the unmount cleanup can fire onEditCancel without re-subscribing on every render.
  const itemsRef = useRef(items);
  const editingCidRef = useRef<string | null>(null);
  const onEditCancelRef = useRef(onEditCancel);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    editingCidRef.current = editingCid;
  }, [editingCid]);
  useEffect(() => {
    onEditCancelRef.current = onEditCancel;
  }, [onEditCancel]);

  // On unmount, if a row is mid-edit, surface a cancel so the doc-side `isEditing` flag clears.
  useEffect(() => {
    return () => {
      const cid = editingCidRef.current;
      const item = cid
        ? itemsRef.current.find((candidate) => candidate.$cid === cid)
        : undefined;
      if (item?.isEditing) {
        void onEditCancelRef.current(item);
      }
    };
  }, []);

  // Sync local editing state with server-side `isEditing` flag: if the row disappears or another
  // client opens an edit, reflect it.
  useEffect(() => {
    if (editingCid) {
      const item = items.find((candidate) => candidate.$cid === editingCid);
      if (!item) {
        setEditingCid(null);
        setEditValue('');
      }
      return;
    }

    const editingItem = items.find((item) => item.isEditing);
    if (editingItem) {
      setEditingCid(editingItem.$cid);
      setEditValue(getEditableTaskText(editingItem));
    }
  }, [editingCid, items]);

  const startEdit = useCallback(
    async (item: MessageQueueItem) => {
      const previous =
        editingCid && editingCid !== item.$cid
          ? items.find((candidate) => candidate.$cid === editingCid)
          : undefined;
      setPendingCid(item.$cid);
      try {
        if (previous) {
          await onEditCancel(previous);
        }
        await onEditStart(item);
        setEditingCid(item.$cid);
        setEditValue(getEditableTaskText(item));
      } catch (error) {
        console.error('Failed to start queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [editingCid, items, onEditCancel, onEditStart]
  );

  const cancelEdit = useCallback(
    async (item: MessageQueueItem) => {
      setPendingCid(item.$cid);
      try {
        await onEditCancel(item);
        setEditingCid(null);
        setEditValue('');
      } catch (error) {
        console.error('Failed to cancel queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [onEditCancel]
  );

  const saveEdit = useCallback(
    async (item: MessageQueueItem) => {
      setPendingCid(item.$cid);
      try {
        await onEditSave(item, editValue.trim());
        setEditingCid(null);
        setEditValue('');
      } catch (error) {
        console.error('Failed to save queued message edit', error);
      } finally {
        setPendingCid(null);
      }
    },
    [editValue, onEditSave]
  );

  return {
    editingCid,
    editValue,
    pendingCid,
    setEditValue,
    startEdit,
    cancelEdit,
    saveEdit,
  };
}
