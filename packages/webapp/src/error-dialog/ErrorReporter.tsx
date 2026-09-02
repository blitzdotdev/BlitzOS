import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError } from '../api';
import { ModalOverlay } from '../ModalOverlay';
import { isString } from '../type-guards';

export type ErrorContext = {
  title: string;
  action?: string;
  workspaceId?: string;
};

export type ErrorReport = {
  message: string;
  status?: number;
  code?: string;
};

type PresentedErrorReport = ErrorReport & ErrorContext & {
  timestamp: string;
};

/** Errors and primitive rejections accepted by first-party action call sites,
 * without weakening the reporter's exported signature to `unknown`. */
export type ReportableError =
  | Error
  | { toString(): string }
  | null
  | undefined;

type ReportError = (caught: ReportableError, context: ErrorContext) => void;

const ErrorReporterContext = createContext<ReportError | null>(null);

/** The one rejection boundary for action errors. Callers provide only the UX
 * context; this helper owns the API-specific diagnostic fields and safe
 * handling of non-Error rejections. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the single Promise-rejection boundary; it returns a parsed ErrorReport and never exposes the value.
function describeError(caught: unknown): ErrorReport {
  if (caught instanceof ApiRequestError) {
    const report: ErrorReport = {
      message: caught.message || 'The control plane request failed.',
      status: caught.status,
    };
    if (caught.retryAction !== null) report.code = caught.retryAction;
    return report;
  }
  if (caught instanceof Error) {
    return { message: caught.message || 'An unexpected error occurred.' };
  }
  if (isString(caught) && caught.trim() !== '') return { message: caught };
  return { message: 'An unexpected error occurred.' };
}

function buildErrorReport(report: PresentedErrorReport): string {
  const fields: Array<[string, string | undefined]> = [
    ['Error', report.title],
    ['Code', report.code],
    ['Status', report.status === undefined ? undefined : `HTTP ${String(report.status)}`],
    ['Workspace', report.workspaceId],
    ['Timestamp', report.timestamp],
    ['Action', report.action],
  ];
  const header = fields
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
  return `${header}\n\n${report.message}`;
}

function ErrorDialog({ report, onClose }: { report: PresentedErrorReport; onClose: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const reportText = useMemo(() => buildErrorReport(report), [report]);

  useEffect(() => { closeButton.current?.focus(); }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const write = navigator.clipboard?.writeText(reportText);
    if (write === undefined) {
      setCopyFailed(true);
      return;
    }
    void write.then(
      () => {
        setCopyFailed(false);
        setCopied(true);
      },
      () => setCopyFailed(true),
    );
  };

  return (
    <ModalOverlay onDismiss={onClose}>
      <section
        className="webapp-error-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className="webapp-error-dialog__header">
          <span className="webapp-error-dialog__icon" aria-hidden="true">!</span>
          <div>
            <h1 id={titleId}>{report.title}</h1>
            {report.action !== undefined && <p>{report.action}</p>}
          </div>
        </header>
        <div className="webapp-error-dialog__body">
          <div className="webapp-error-dialog__tags">
            {report.status !== undefined && <span>Status: HTTP {report.status}</span>}
            {report.code !== undefined && <span>Code: {report.code}</span>}
          </div>
          <pre id={descriptionId}>{report.message}</pre>
          {copyFailed && (
            <p className="webapp-error-dialog__copy-failed" role="alert">
              Couldn’t copy the report. Select the message above to copy it manually.
            </p>
          )}
        </div>
        <footer className="webapp-error-dialog__actions">
          <button ref={closeButton} className="webapp-action" type="button" onClick={onClose}>
            Close
          </button>
          <button className="webapp-action" type="button" onClick={copy}>
            <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
            {copied ? 'Copied' : 'Copy error'}
          </button>
        </footer>
      </section>
    </ModalOverlay>
  );
}

export function ErrorReporterProvider({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<PresentedErrorReport | null>(null);
  const reportError = useCallback<ReportError>((caught, context) => {
    setReport({
      ...context,
      ...describeError(caught),
      timestamp: new Date().toISOString(),
    });
  }, []);

  return (
    <ErrorReporterContext.Provider value={reportError}>
      {children}
      {report !== null && <ErrorDialog report={report} onClose={() => setReport(null)} />}
    </ErrorReporterContext.Provider>
  );
}

export function useErrorReporter(): ReportError {
  const reportError = useContext(ErrorReporterContext);
  if (reportError === null) {
    throw new Error('useErrorReporter must be used inside ErrorReporterProvider');
  }
  return reportError;
}
