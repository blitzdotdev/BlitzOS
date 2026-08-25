import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LanguageDescription } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { languages } from '@codemirror/language-data';
import CodeMirror from '@uiw/react-codemirror';
import { codeSyntaxHighlighting } from './code-highlight';
import type {
  BufferLike,
  FileStat,
  ResponseDataDetailed,
  WebDAVClient,
} from 'webdav';
import { FileIcon } from './WebAppIcons';
import { hasObjectType, isString } from './type-guards';
import { ConfirmationDialog } from './ConfirmationDialog';
import { WebAppLoadingPane } from './LoadingSkeleton';
import {
  davErrorStatus,
  fullDavPath,
  shellQuotedPath,
} from './files';

const MAX_EDITABLE_SIZE = 5 * 1024 * 1024;

const fileEditorTheme: Extension = [
  EditorView.theme({
    '&': {
      height: '100%',
      color: 'var(--ink)',
      backgroundColor: 'var(--paper)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: '13px',
      lineHeight: '1.6',
    },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-gutters': {
      color: 'var(--faint)',
      backgroundColor: 'var(--paper)',
      borderRight: '1px solid var(--rule)',
    },
    '.cm-activeLine, .cm-activeLineGutter': {
      backgroundColor: 'color-mix(in oklab, var(--ink) 4%, var(--paper))',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--terminal-selection) !important',
    },
  }, { dark: true }),
  codeSyntaxHighlighting,
];

type FileEditorProps = {
  active: boolean;
  client: WebDAVClient | null;
  filePath: string;
  unavailableStage?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  onTreeRefresh: () => void;
  onUnauthorized: () => void;
};

type TargetVersion = {
  exists: boolean;
  etag: string | null;
};

function fileStat(result: FileStat | ResponseDataDetailed<FileStat>): FileStat {
  return 'data' in result ? result.data : result;
}

function fileBytes(
  result: BufferLike | string | ResponseDataDetailed<BufferLike | string>,
): Uint8Array {
  const value = hasObjectType(result) && result !== null && 'data' in result
    ? result.data
    : result;
  if (isString(value)) return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function detailedEtag(
  result: BufferLike | string | ResponseDataDetailed<BufferLike | string>,
): string | null {
  if (!hasObjectType(result) || result === null || !('data' in result)) return null;
  const etag = Object.entries(result.headers)
    .find(([name]) => name.toLowerCase() === 'etag')?.[1];
  return isString(etag) && etag.length > 0 ? etag : null;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}

async function readTargetVersion(
  client: WebDAVClient,
  filePath: string,
  signal: AbortSignal,
): Promise<TargetVersion> {
  const response = await client.customRequest(filePath, { method: 'HEAD', signal });
  return { exists: true, etag: response.headers.get('etag') };
}

function targetIsUnchanged(opened: TargetVersion, current: TargetVersion): boolean {
  if (opened.exists !== current.exists) return false;
  if (!opened.exists) return true;
  if (!opened.etag || !current.etag) return false;
  if (/^\s*W\//iu.test(opened.etag) || /^\s*W\//iu.test(current.etag)) return false;
  return opened.etag === current.etag;
}

function readableSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1).replace(/\.0$/u, '')} KB`;
  return `${(size / 1024 / 1024).toFixed(1).replace(/\.0$/u, '')} MB`;
}

function temporaryPath(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const directory = slash >= 0 ? `${filePath.slice(0, slash + 1)}` : '';
  const basename = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return `${directory}.${basename}.blitz-${crypto.randomUUID()}.tmp`;
}

export function FileEditor({
  active,
  client,
  filePath,
  unavailableStage,
  onDirtyChange,
  onSaved,
  onTreeRefresh,
  onUnauthorized,
}: FileEditorProps) {
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'binary' | 'error'>('idle');
  const [content, setContent] = useState('');
  const [size, setSize] = useState(0);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflictTemp, setConflictTemp] = useState<string | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [language, setLanguage] = useState<Extension | null>(null);
  const contentRef = useRef('');
  const cleanContent = useRef('');
  const dirtyRef = useRef(false);
  const targetVersion = useRef<TargetVersion>({ exists: false, etag: null });
  const targetVersionPath = useRef(filePath);
  const conflictTempRef = useRef<string | null>(null);
  const activatedClient = useRef<WebDAVClient | null>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const saveAbort = useRef<AbortController | null>(null);
  const pathVersionAbort = useRef<AbortController | null>(null);
  const savedTimer = useRef<number | null>(null);
  const [adoptingPathVersion, setAdoptingPathVersion] = useState(false);
  const basename = filePath.split('/').at(-1) ?? filePath;

  useEffect(() => {
    let cancelled = false;
    const description = LanguageDescription.matchFilename(languages, basename);
    if (!description) {
      setLanguage(null);
      return;
    }
    void description.load().then((support) => {
      if (!cancelled) setLanguage(support);
    });
    return () => {
      cancelled = true;
    };
  }, [basename]);

  useEffect(() => {
    if (conflictTempRef.current) {
      conflictTempRef.current = null;
      setConflictTemp(null);
      setConfirmReload(false);
    }
    return () => {
      loadAbort.current?.abort();
      saveAbort.current?.abort();
      pathVersionAbort.current?.abort();
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      const temporary = conflictTempRef.current;
      if (temporary && client) void client.deleteFile(temporary).catch(() => undefined);
    };
  }, [client]);

  const setDirty = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
    onDirtyChange(dirty);
  }, [onDirtyChange]);

  const handleFailure = useCallback((cause: unknown, message: string) => {
    const status = davErrorStatus(cause);
    if (status === 401) {
      onUnauthorized();
      return status;
    }
    if (status === 403) {
      setNotice('You do not have permission to edit this file.');
      return status;
    }
    setError(cause instanceof Error ? cause.message : message);
    return status;
  }, [onUnauthorized]);

  const loadFile = useCallback(async () => {
    if (!client) return;
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    setLoadState('loading');
    setError(null);
    setMissing(false);
    setConflictTemp(null);
    conflictTempRef.current = null;
    try {
      const stat = fileStat(await client.stat(filePath, { signal: controller.signal }));
      throwIfAborted(controller.signal);
      setSize(stat.size);
      if (stat.size > MAX_EDITABLE_SIZE) {
        setContent('');
        contentRef.current = '';
        cleanContent.current = '';
        setDirty(false);
        setLoadState('binary');
        return;
      }

      const result = await client.getFileContents(filePath, {
        details: true,
        format: 'binary',
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      const bytes = fileBytes(result);
      targetVersion.current = { exists: true, etag: detailedEtag(result) };
      targetVersionPath.current = filePath;
      const sample = bytes.slice(0, 8192);
      const controlBytes = sample.filter((byte) => byte < 8 || (byte > 13 && byte < 32)).length;
      let binary = sample.includes(0)
        || (sample.length > 0 && controlBytes / sample.length > 0.1);
      let text = '';
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        binary = true;
      }
      if (binary || (!text && bytes.byteLength > 0)) {
        setContent('');
        contentRef.current = '';
        cleanContent.current = '';
        setDirty(false);
        setLoadState('binary');
        return;
      }
      setContent(text);
      contentRef.current = text;
      cleanContent.current = text;
      setDirty(false);
      setLoadState('ready');
    } catch (loadError) {
      if (isAbortError(loadError)) return;
      const status = davErrorStatus(loadError);
      if (status === 404) {
        setContent('');
        contentRef.current = '';
        cleanContent.current = '';
        targetVersion.current = { exists: false, etag: null };
        targetVersionPath.current = filePath;
        setSize(0);
        setMissing(true);
        setDirty(false);
        setLoadState('ready');
        onTreeRefresh();
        return;
      }
      handleFailure(loadError, 'Could not open file.');
      setLoadState('error');
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, [client, filePath, handleFailure, onTreeRefresh, setDirty]);

  useEffect(() => {
    if (!active || !client) {
      loadAbort.current?.abort();
      activatedClient.current = null;
      return;
    }
    if (activatedClient.current === client) return;
    activatedClient.current = client;
    if (!dirtyRef.current) void loadFile();
  }, [active, client, loadFile]);

  useEffect(() => {
    if (targetVersionPath.current === filePath || !client) return;
    pathVersionAbort.current?.abort();
    const controller = new AbortController();
    pathVersionAbort.current = controller;
    setAdoptingPathVersion(true);
    void readTargetVersion(client, filePath, controller.signal).then((version) => {
      throwIfAborted(controller.signal);
      targetVersion.current = version;
      targetVersionPath.current = filePath;
      setMissing(false);
    }).catch((pathError) => {
      if (isAbortError(pathError)) return;
      const status = davErrorStatus(pathError);
      if (status === 404) {
        targetVersion.current = { exists: false, etag: null };
        targetVersionPath.current = filePath;
        setMissing(true);
        onTreeRefresh();
      } else {
        handleFailure(pathError, 'Could not follow the renamed file.');
      }
    }).finally(() => {
      if (pathVersionAbort.current === controller) {
        pathVersionAbort.current = null;
        setAdoptingPathVersion(false);
      }
    });
    return () => controller.abort();
  }, [client, filePath, handleFailure, onTreeRefresh]);

  const markSaved = useCallback(async (signal: AbortSignal) => {
    if (!client) return;
    let targetMissing = false;
    try {
      targetVersion.current = await readTargetVersion(client, filePath, signal);
      targetVersionPath.current = filePath;
      throwIfAborted(signal);
      setSize(new TextEncoder().encode(contentRef.current).byteLength);
    } catch (statError) {
      if (isAbortError(statError)) throw statError;
      const status = davErrorStatus(statError);
      targetMissing = status === 404;
      targetVersion.current = targetMissing
        ? { exists: false, etag: null }
        : { exists: true, etag: null };
      targetVersionPath.current = filePath;
      setSize(new TextEncoder().encode(contentRef.current).byteLength);
      if (targetMissing) onTreeRefresh();
      else if (status === 401) onUnauthorized();
      else if (status === 403) setNotice('You do not have permission to edit this file.');
    }
    throwIfAborted(signal);
    cleanContent.current = contentRef.current;
    setDirty(false);
    setMissing(targetMissing);
    setConflictTemp(null);
    conflictTempRef.current = null;
    setSaved(true);
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1_600);
    onSaved();
  }, [client, filePath, onSaved, onTreeRefresh, onUnauthorized, setDirty]);

  const completeMove = useCallback(async (temporary: string) => {
    if (!client) return;
    saveAbort.current?.abort();
    const controller = new AbortController();
    saveAbort.current = controller;
    setSaving(true);
    setError(null);
    try {
      await client.moveFile(temporary, filePath, {
        overwrite: true,
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      await markSaved(controller.signal);
    } catch (moveError) {
      if (isAbortError(moveError)) {
        await client.deleteFile(temporary).catch(() => undefined);
      } else if (davErrorStatus(moveError) === 404) {
        setMissing(true);
        targetVersion.current = { exists: false, etag: null };
        onTreeRefresh();
      } else {
        handleFailure(moveError, 'Could not save file.');
      }
    } finally {
      if (saveAbort.current === controller) {
        saveAbort.current = null;
        setSaving(false);
      }
    }
  }, [client, filePath, handleFailure, markSaved, onTreeRefresh]);

  const saveFile = useCallback(async () => {
    if (
      !client
      || saving
      || adoptingPathVersion
      || targetVersionPath.current !== filePath
      || (!dirtyRef.current && !missing)
      || conflictTempRef.current
    ) return;
    const temporary = temporaryPath(filePath);
    saveAbort.current?.abort();
    const controller = new AbortController();
    saveAbort.current = controller;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await client.putFileContents(temporary, contentRef.current, {
        overwrite: true,
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);

      let current: TargetVersion;
      try {
        current = await readTargetVersion(client, filePath, controller.signal);
        throwIfAborted(controller.signal);
      } catch (statError) {
        if (isAbortError(statError)) throw statError;
        if (davErrorStatus(statError) !== 404) throw statError;
        current = { exists: false, etag: null };
      }

      const opened = targetVersion.current;
      if (!targetIsUnchanged(opened, current)) {
        if (!current.exists) {
          await client.deleteFile(temporary).catch(() => undefined);
          targetVersion.current = current;
          setMissing(true);
          onTreeRefresh();
          return;
        }
        conflictTempRef.current = temporary;
        setConflictTemp(temporary);
        return;
      }

      await client.moveFile(temporary, filePath, {
        overwrite: true,
        signal: controller.signal,
      });
      throwIfAborted(controller.signal);
      await markSaved(controller.signal);
    } catch (saveError) {
      await client.deleteFile(temporary).catch(() => undefined);
      if (isAbortError(saveError)) {
        return;
      } else if (davErrorStatus(saveError) === 404) {
        targetVersion.current = { exists: false, etag: null };
        setMissing(true);
        onTreeRefresh();
      } else {
        handleFailure(saveError, 'Could not save file.');
      }
    } finally {
      if (saveAbort.current === controller) {
        saveAbort.current = null;
        setSaving(false);
      }
    }
  }, [
    client,
    filePath,
    handleFailure,
    markSaved,
    onTreeRefresh,
    saving,
    missing,
    adoptingPathVersion,
  ]);

  useEffect(() => {
    if (!active) return;
    const saveOnShortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === 's'
      ) {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener('keydown', saveOnShortcut);
    return () => window.removeEventListener('keydown', saveOnShortcut);
  }, [active, saveFile]);

  const editorExtensions = useMemo(
    () => language ? [language] : [],
    [language],
  );

  const copyPath = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(shellQuotedPath(filePath));
    } catch {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_200);
  };

  const discardConflictAndReload = async () => {
    if (conflictTempRef.current && client) {
      await client.deleteFile(conflictTempRef.current).catch(() => undefined);
    }
    conflictTempRef.current = null;
    setConflictTemp(null);
    setConfirmReload(false);
    await loadFile();
  };

  if (!client && loadState === 'idle') {
    return (
      <div className="file-editor">
        <WebAppLoadingPane
          ariaLabel="Loading file editor"
          stage={unavailableStage ?? 'starting · workspace files'}
        />
      </div>
    );
  }

  if (loadState === 'idle' || loadState === 'loading') {
    return (
      <div className="file-editor">
        <WebAppLoadingPane ariaLabel={`Loading ${basename}`} stage={`opening · ${basename}`} />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="file-editor file-editor--placeholder">
        <FileIcon />
        <p>{error ?? 'Could not open file.'}</p>
        <button type="button" onClick={() => { void loadFile(); }}>Retry</button>
        {notice && (
          <div className="webapp-notice" role="alert">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}
      </div>
    );
  }

  if (loadState === 'binary') {
    return (
      <div className="file-editor file-editor--placeholder">
        <FileIcon />
        <p>binary / {readableSize(size)} — edit in the terminal</p>
        <button type="button" onClick={() => { void copyPath(); }}>
          {copied ? 'Copied' : 'Copy path'}
        </button>
      </div>
    );
  }

  return (
    <div className="file-editor">
      <header className={`file-editor-meta${conflictTemp ? ' file-editor-meta--conflict' : ''}`}>
        <span className="file-editor-path" title={fullDavPath(filePath)}>
          <span>~/{filePath}</span>
        </span>
        {conflictTemp ? (
          <span className="file-editor-banner" role="alert">
            <span className="file-editor-banner-message">Changed on disk while you edited</span>
            <span aria-hidden="true">·</span>
            <button type="button" disabled={saving} onClick={() => { void completeMove(conflictTemp); }}>
              Overwrite
            </button>
            <button type="button" disabled={saving} onClick={() => setConfirmReload(true)}>
              Reload
            </button>
          </span>
        ) : missing ? (
          <span className="file-editor-banner" role="status">
            file no longer exists · Save recreates it
          </span>
        ) : null}
        <button className="file-editor-copy" type="button" onClick={() => { void copyPath(); }}>
          {copied ? 'copied' : 'copy'}
        </button>
        {saved && <span className="file-editor-saved" role="status">✓ saved</span>}
        <button
          className={`file-editor-save${dirtyRef.current || missing ? ' file-editor-save--dirty' : ''}`}
          type="button"
          disabled={
            (!dirtyRef.current && !missing)
            || saving
            || adoptingPathVersion
            || targetVersionPath.current !== filePath
            || Boolean(conflictTemp)
            || !client
          }
          onClick={() => { void saveFile(); }}
        >
          {saving && <span className="webapp-inline-spinner" />}
          Save
        </button>
      </header>
      {error && <div className="file-editor-error" role="alert">{error}</div>}
      <div className="file-editor-code">
        <CodeMirror
          value={content}
          height="100%"
          theme={fileEditorTheme}
          extensions={editorExtensions}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: false,
          }}
          onChange={(value) => {
            setContent(value);
            contentRef.current = value;
            setDirty(value !== cleanContent.current);
            const temporary = conflictTempRef.current;
            if (temporary && client) {
              conflictTempRef.current = null;
              setConflictTemp(null);
              void client.deleteFile(temporary).catch(() => undefined);
            }
          }}
        />
      </div>
      {notice && (
        <div className="webapp-notice" role="alert">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {confirmReload && (
        <ConfirmationDialog
          title="Discard changes?"
          description={`Discard unsaved changes to ${basename}?`}
          confirmLabel="Discard"
          cancelLabel="Cancel"
          onCancel={() => setConfirmReload(false)}
          onConfirm={() => { void discardConflictAndReload(); }}
        />
      )}
    </div>
  );
}
