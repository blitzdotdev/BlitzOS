import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
} from '@blitzos/schema';
import type { DragEvent, KeyboardEvent } from 'react';
import { useRef, useState } from 'react';

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

/** The whole PUT body derives from the catalog view: the manifest already
 * decided custody and the placements. The static form contributes the one
 * value no manifest can know — the root. The app variant (GitHub App)
 * contributes the app id and installation id beside the PEM private key, and
 * goes out as kind app-jwt with no placements: the minter's own defaults are
 * the canonical env surface for an app credential. */
export function adminConnectionInput(
  entry: CatalogEntryView,
  data: FormData,
): PutConnectionRequest | null {
  const form = entry.adminForm;
  if (form === null) return null;
  if (form.app !== null) {
    return {
      provider: entry.id,
      kind: 'app-jwt',
      custody: 'cp',
      config: {
        app_id: field(data, 'appId'),
        installation_id: field(data, 'installationId'),
      },
      root: field(data, 'root'),
    };
  }
  const config: PutConnectionRequest['config'] = {
    placements: form.placements.map(({ kind, name, fill }) => ({ kind, name, fill })),
  };
  return {
    provider: entry.id,
    kind: 'static',
    custody: entry.custody,
    config,
    root: field(data, 'root'),
  };
}

/** Whether an org credential already stands behind a provider. Presence of a
 * row is not enough: a member connect declares a row with no root, and only
 * `orgCredential` says an admin actually stored one. */
export function orgCredentialFor(
  connections: readonly ConnectionView[],
  provider: string,
): boolean {
  return connections.some(
    (connection) =>
      connection.name === provider &&
      connection.status === 'active' &&
      connection.orgCredential,
  );
}

/** GitHub downloads App keys at 2–4 KiB; refuse anything that cannot be one
 * before reading it. */
const MAX_KEY_FILE_BYTES = 16 * 1024;

/** Why a chosen file cannot be the app key, or null when it can. Encrypted
 * keys get their own answer — GitHub never generates those, so the fix is a
 * different file, not a conversion. */
function keyFileProblem(content: string): string | null {
  if (
    content.includes('BEGIN ENCRYPTED PRIVATE KEY') ||
    content.includes('Proc-Type: 4,ENCRYPTED')
  ) {
    return 'This key is encrypted. Encrypted keys are not supported — upload the .pem file exactly as GitHub generated it.';
  }
  if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(content)) {
    return 'This file is not a private key: it has no "BEGIN … PRIVATE KEY" header.';
  }
  return null;
}

function dragHasFiles(event: DragEvent<HTMLDivElement>): boolean {
  return event.dataTransfer.types.includes('Files');
}

/** The one org-credential config form, manifest-driven and mounted wherever a
 * provider gets attached — the template create/edit screen today. The host
 * owns the PUT call and its error line; this renders exactly the fields the
 * manifest's admin form declares and hands back the parsed request body.
 *
 * Deliberately not a `<form>`: the template screen mounts it inside its own
 * create form, and a nested form is invalid HTML whose submit React bubbles
 * to the host — saving a credential would also submit the template. Save is
 * a plain button, and Enter in a field saves here (preventDefault keeps it
 * from ever reaching the host form's implicit submission), so the component
 * still works mounted standalone or inside any host form. */
export function ProviderAdminForm({
  entry,
  saving,
  configured,
  onCancel,
  onSubmit,
}: {
  entry: CatalogEntryView;
  saving: boolean;
  /** True when an org credential already stands: submitting replaces it. */
  configured: boolean;
  onCancel: () => void;
  onSubmit: (input: PutConnectionRequest) => void;
}) {
  const fieldsRef = useRef<HTMLDivElement | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  /** The dropped or browsed key, held client-side until Save submits it as
   * the root — the PUT body never changes shape. */
  const [keyFile, setKeyFile] = useState<{ name: string; content: string } | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pasteKey, setPasteKey] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const form = entry.adminForm;
  if (form === null) return null;
  const acceptKeyFile = async (file: File) => {
    if (file.size > MAX_KEY_FILE_BYTES) {
      setKeyFile(null);
      setKeyError('This file is too large to be an app key — GitHub keys are a few KB.');
      return;
    }
    const content = await file.text();
    const problem = keyFileProblem(content);
    setKeyFile(problem === null ? { name: file.name, content } : null);
    setKeyError(problem);
  };
  const save = () => {
    if (saving) return;
    const container = fieldsRef.current;
    if (container === null) return;
    const controls = [...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[name], textarea[name]',
    )];
    // Without a form element nothing enforces required/pattern/type natively,
    // so each control is checked here; the first invalid one gets the
    // browser's own bubble and the save stops.
    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return;
      }
    }
    const data = new FormData();
    for (const control of controls) data.set(control.name, control.value);
    if (form.app !== null && !pasteKey) {
      // The drop zone is no form control: the loaded file stands in for the
      // root field and gets the same required treatment here.
      if (keyFile === null) {
        setKeyError('Add the private key: drop the .pem file here or browse for it.');
        return;
      }
      data.set('root', keyFile.content);
    }
    const input = adminConnectionInput(entry, data);
    if (input !== null) onSubmit(input);
  };
  const saveOnEnter = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    save();
  };
  return (
    <div className="connect-form" ref={fieldsRef} onKeyDown={saveOnEnter}>
      {form.app !== null && (
        <>
          <label className="connect-field">
            <span className="connect-field__label">{form.app.appIdLabel}</span>
            <input name="appId" required inputMode="numeric" pattern="[0-9]+" />
          </label>
          <label className="connect-field">
            <span className="connect-field__label">{form.app.installationIdLabel}</span>
            <input name="installationId" required inputMode="numeric" pattern="[0-9]+" />
          </label>
        </>
      )}
      {form.app !== null ? (
        // The key arrives as a downloaded .pem, so the primary input is a
        // drop zone; a not-a-label div, because the Clear/Browse buttons
        // inside would fight a label's click forwarding.
        <div className="connect-field connect-field--wide">
          <span className="connect-field__label">{form.rootLabel}</span>
          {pasteKey ? (
            // The paste fallback: a PEM is multi-line, so it rides a
            // textarea; a password input would flatten it.
            <textarea
              name="root"
              required
              rows={6}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
          ) : (
            <div
              className={`connect-drop${dropActive ? ' connect-drop--active' : ''}`}
              onDragEnter={(event) => {
                if (!dragHasFiles(event)) return;
                event.preventDefault();
                dragDepth.current += 1;
                setDropActive(true);
              }}
              onDragOver={(event) => {
                if (!dragHasFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
              }}
              onDragLeave={() => {
                if (dragDepth.current === 0) return;
                dragDepth.current -= 1;
                if (dragDepth.current === 0) setDropActive(false);
              }}
              onDrop={(event) => {
                if (!dragHasFiles(event)) return;
                event.preventDefault();
                dragDepth.current = 0;
                setDropActive(false);
                const file = event.dataTransfer.files[0];
                if (file !== undefined) void acceptKeyFile(file);
              }}
            >
              {keyFile === null ? (
                <>
                  <span className="connect-drop__prompt">Drop the .pem file here, or</span>
                  <button
                    className="webapp-action"
                    type="button"
                    onClick={() => filePickerRef.current?.click()}
                  >Browse…</button>
                </>
              ) : (
                <>
                  <span className="connect-drop__loaded">
                    <strong>{keyFile.name}</strong> — key loaded
                  </span>
                  <button
                    className="webapp-action"
                    type="button"
                    onClick={() => {
                      setKeyFile(null);
                      setKeyError(null);
                    }}
                  >Clear</button>
                </>
              )}
              <input
                ref={filePickerRef}
                type="file"
                accept=".pem"
                hidden
                aria-label={form.rootLabel}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file !== undefined) void acceptKeyFile(file);
                }}
              />
            </div>
          )}
          {keyError !== null && (
            <p className="webapp-form-message" role="alert">{keyError}</p>
          )}
          <button
            className="connect-drop__toggle"
            type="button"
            onClick={() => {
              // Switching input paths starts the key over: one source of
              // truth, never a stale file behind a fresh paste.
              setPasteKey(!pasteKey);
              setKeyFile(null);
              setKeyError(null);
            }}
          >{pasteKey ? 'Upload the key file instead' : 'Paste the key text instead'}</button>
        </div>
      ) : (
        <label className="connect-field connect-field--wide">
          <span className="connect-field__label">{form.rootLabel}</span>
          <input name="root" type="password" required autoComplete="new-password" />
        </label>
      )}
      <p className="connect-help connect-field--wide">{form.rootHelp}</p>
      <div className="connect-actions connect-field--wide">
        <button className="webapp-action" type="button" onClick={onCancel}>Cancel</button>
        <button
          className="webapp-action webapp-action--primary"
          type="button"
          disabled={saving}
          onClick={save}
        >{saving ? 'Saving…' : configured ? 'Replace credential' : 'Save'}</button>
      </div>
    </div>
  );
}
