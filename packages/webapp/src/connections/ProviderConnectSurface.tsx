import type {
  CatalogEntryView,
  ConnectionView,
  PutUserGrantRequest,
} from '@blitzos/schema';
import { type FormEvent } from 'react';

/** Information wants a glyph, not a box: an outlined mark keeps a notice from
 * reading as a disabled input. */
export function InfoGlyph() {
  return (
    <svg className="connect-note__glyph" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.1" /><path d="M8 7.3v3.5" /><path d="M8 5.1h.01" /></svg>
  );
}

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

export function grantInput(
  entry: CatalogEntryView,
  data: FormData,
): PutUserGrantRequest {
  const input: PutUserGrantRequest = {
    manifestId: entry.id,
    token: field(data, 'token'),
  };
  const label = field(data, 'label');
  if (label) input.label = label;
  if (entry.personalTokenBaseUrlLabel !== null) {
    // Instance-hosted vendor: the typed URL rides the grant. A locked,
    // prefilled field renders without a name, so nothing is sent and the
    // grant inherits the org row's URL instead.
    const baseUrl = field(data, 'baseUrl');
    if (baseUrl) input.vendor = { baseUrl };
  }
  return input;
}

/** The org row's instance URL for an instance-hosted vendor. When one exists
 * the paste form shows it locked instead of asking the member for it again —
 * the whole organization has to be on one instance. */
export function lockedInstanceBaseUrl(
  entry: CatalogEntryView,
  orgConnections: readonly ConnectionView[],
): string | null {
  if (entry.personalTokenBaseUrlLabel === null) return null;
  return orgConnections.find(
    (connection) => connection.name === entry.id && connection.status === 'active',
  )?.proxyBaseUrl ?? null;
}

/** Everything a member does to authorize one provider: the OAuth round trip
 * where the provider offers one, the paste form where it issues personal
 * keys, and an honest note where it does neither.
 *
 * Two surfaces host this. The workspace connections panel expands it inside a
 * provider row; the account-scope picker in settings shows it under its grid.
 * They differ in wording and in what happens afterwards, never in what the
 * provider needs — which is why this is one component and not two.
 */
export function ProviderConnectSurface({
  entry,
  connectionName,
  lockedBaseUrl,
  oauthHref,
  oauthLabel,
  submitLabel,
  saving,
  formKey,
  onSubmit,
  onCancel,
}: {
  entry: CatalogEntryView;
  /** The name the grant is stored under. It is always the catalog id: the
   * control plane refuses a grant filed under any other name. */
  connectionName: string;
  lockedBaseUrl: string | null;
  /** Where the provider's OAuth round trip starts, or null when this
   * instance has no client registered for it. */
  oauthHref: string | null;
  oauthLabel: string;
  submitLabel: string;
  saving: boolean;
  /** Bumped by the host to reset the uncontrolled fields. */
  formKey: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return (
    <>
      {entry.oauthAvailable && (oauthHref !== null ? (
        <div className="connect-actions">
          <a className="webapp-action webapp-action--primary connect-cta" href={oauthHref}>
            {oauthLabel}
          </a>
        </div>
      ) : (
        <p className="connect-note">
          <InfoGlyph />
          <span>
            {entry.title} OAuth is not configured on this instance. Paste a token below, or
            ask an operator to register the app and set its client secret.
          </span>
        </p>
      ))}

      {entry.personalTokenLabel === null ? (
        <p className="connect-note">
          <InfoGlyph />
          <span>
            {entry.adminForm !== null
              ? `An admin stores one ${entry.title} key for everyone, on the template page.`
              : `${entry.title} issues no personal token. Connecting requires OAuth.`}
          </span>
        </p>
      ) : (
        <form className="connect-form" key={formKey} onSubmit={onSubmit}>
          <label className="connect-field">
            <span className="cfg-label">Connection name</span>
            <input name="name" required value={connectionName} readOnly />
          </label>
          <label className="connect-field">
            <span className="cfg-label">Label (optional)</span>
            <input name="label" placeholder="work account" />
          </label>
          {entry.personalTokenBaseUrlLabel !== null && (
            <label className="connect-field">
              <span className="cfg-label">{entry.personalTokenBaseUrlLabel}</span>
              {lockedBaseUrl === null ? (
                <input name="baseUrl" type="url" required placeholder="https://" />
              ) : (
                // Someone in the org already named the instance; the form
                // shows it and the grant inherits it (no name, not sent).
                <input value={lockedBaseUrl} readOnly />
              )}
            </label>
          )}
          <label className="connect-field connect-field--wide">
            <span className="cfg-label">{entry.personalTokenLabel}</span>
            <input name="token" type="password" required autoComplete="new-password" />
          </label>
          {entry.personalTokenHelp !== null && (
            <p className="connect-help connect-field--wide">{entry.personalTokenHelp}</p>
          )}
          <div className="connect-actions connect-field--wide">
            <button className="webapp-action" type="button" onClick={onCancel}>Cancel</button>
            <button className="webapp-action webapp-action--primary" type="submit" disabled={saving}>
              {submitLabel}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
