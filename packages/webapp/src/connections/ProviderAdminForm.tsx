import type {
  CatalogEntryView,
  ConnectionView,
  PutConnectionRequest,
} from '@blitzos/schema';
import type { KeyboardEvent } from 'react';
import { useRef } from 'react';

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

/** The whole PUT body derives from the catalog view: the manifest already
 * decided custody, the placements, and the proxy header. The static form only
 * ever contributes the two values no manifest can know — the root and, for
 * proxy custody, the instance URL. The app variant (GitHub App) contributes
 * the app id and installation id beside the PKCS#8 key, and goes out as kind
 * app-jwt with no placements: the minter's own defaults are the canonical
 * env surface for an app credential. */
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
  if (form.proxy !== null) {
    config.proxy = {
      base_url: field(data, 'baseUrl'),
      token_header: form.proxy.tokenHeader,
      token_prefix: form.proxy.tokenPrefix,
    };
  }
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
  const form = entry.adminForm;
  if (form === null) return null;
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
      {form.proxy !== null && (
        <label className="connect-field connect-field--wide">
          <span className="connect-field__label">{form.proxy.baseUrlLabel}</span>
          <input name="baseUrl" type="url" required placeholder="https://" />
        </label>
      )}
      <label className="connect-field connect-field--wide">
        <span className="connect-field__label">{form.rootLabel}</span>
        {form.app !== null ? (
          // A PKCS#8 PEM is multi-line; a password input would flatten it.
          <textarea
            name="root"
            required
            rows={6}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="-----BEGIN PRIVATE KEY-----"
          />
        ) : (
          <input name="root" type="password" required autoComplete="new-password" />
        )}
      </label>
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
