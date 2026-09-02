import type {
  ImportOrgCredentialsRequest,
  ImportOrgCredentialsResponse,
} from '@blitzos/schema';
import { useEffect, useRef, useState } from 'react';
import { caughtErrorMessage } from '../error-message';

/** How long the paste sits still before the preview asks the server. The
 * preview is a real dry run — same parser, same outcomes — so it must not
 * fire per keystroke. */
export const IMPORT_PREVIEW_DEBOUNCE_MS = 400;

function importCount(preview: ImportOrgCredentialsResponse): number {
  return preview.results.filter(
    ({ outcome }) => outcome === 'stored' || outcome === 'rotated',
  ).length;
}

function importSummary(response: ImportOrgCredentialsResponse): string {
  const parts = [`${response.linesRead} lines read`];
  for (const outcome of ['stored', 'rotated', 'unchanged', 'refused'] as const) {
    const count = response.results.filter((result) => result.outcome === outcome).length;
    if (count > 0) parts.push(`${count} ${outcome}`);
  }
  return parts.join(' · ');
}

/** The env-file import at org scope (plans/ORG-CREDENTIALS.md §7): the same
 * two steps the workspace tab had — a server dry run previews every line,
 * then the Import button sends the identical request without `dryRun`. */
export function OrgCredentialImport({
  onImport,
  onImported,
}: {
  onImport: (input: ImportOrgCredentialsRequest) => Promise<ImportOrgCredentialsResponse>;
  /** The list to refresh once keys have landed. */
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportOrgCredentialsResponse | null>(null);
  const [imported, setImported] = useState<ImportOrgCredentialsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // The preview IS the import, minus the writes: the same request with
  // `dryRun` set, so what the rows promise is what the button will do.
  useEffect(() => {
    setPreview(null);
    if (text.trim() === '') {
      setError(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      onImport({ text, dryRun: true })
        .then((response) => {
          if (stale) return;
          setError(null);
          setPreview(response);
        })
        .catch((caught: Error) => {
          if (!stale) setError(caughtErrorMessage(caught, 'The preview failed.'));
        });
    }, IMPORT_PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text, onImport]);

  const runImport = () => {
    onImport({ text })
      .then((response) => {
        setError(null);
        setImported(response);
        setText('');
        setFileName('');
        onImported();
      })
      .catch((caught: Error) => setError(caughtErrorMessage(caught, 'The import failed.')));
  };

  const chooseFile = (file: File | undefined) => {
    if (file === undefined) return;
    void file.text().then((content) => {
      setImported(null);
      setFileName(file.name);
      setText(content);
    });
  };

  return (
    <div className="credential-import">
      <div className="credential-import-head">
        <h2 className="cfg-title">Import a .env file</h2>
        <span>each KEY=value line becomes one credential</span>
      </div>
      <div className="credential-import-source">
        <button
          className="webapp-action"
          type="button"
          onClick={() => fileInput.current?.click()}
        >
          Choose file…
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          aria-label="Choose an env file"
          onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
        />
        <span className="credential-import-summary">
          {fileName === '' ? 'or paste below' : fileName}
        </span>
      </div>
      <textarea
        aria-label="Env file text"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="# paste .env text — values stay here until you import"
        value={text}
        onChange={(event) => {
          setImported(null);
          setText(event.currentTarget.value);
        }}
      />
      {error !== null && <p className="webapp-form-message" role="alert">{error}</p>}
      {preview !== null && (
        <div className="credential-import-preview" aria-live="polite">
          {preview.results.map((result) => (
            <div className="credential-import-row" key={`${result.line}:${result.name}`}>
              <span>
                <strong>{result.name}</strong>
                <small>
                  {result.reason === undefined
                    ? `line ${result.line}`
                    : `line ${result.line} — ${result.reason}`}
                </small>
              </span>
              <span className={`import-chip import-chip--${result.outcome}`}>
                {result.outcome === 'rotated' ? 'rotates' : result.outcome}
              </span>
            </div>
          ))}
        </div>
      )}
      {preview !== null && (
        <p className="credential-import-summary">{importSummary(preview)}</p>
      )}
      {imported !== null && (
        <p className="credential-import-summary" role="status">
          Imported: {importSummary(imported)}. You hold write access to each
          key; share one from its grants.
        </p>
      )}
      <div className="credential-import-actions">
        <p>Values never appear in results. Delete the file once its keys are here.</p>
        <button
          className="webapp-action webapp-action--primary"
          type="button"
          disabled={preview === null || importCount(preview) === 0}
          onClick={runImport}
        >
          {preview === null
            ? 'Import'
            : `Import ${importCount(preview)} key${importCount(preview) === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
