import type { ConnectionView, PutConnectionRequest } from '@blitzos/schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { caughtErrorMessage } from '../error-message';

export type ConnectionTemplateId = 'github' | 'anthropic' | 'openai' | 'hetzner' | 'generic';

const TEMPLATES: readonly {
  id: ConnectionTemplateId;
  name: string;
  detail: string;
}[] = [
  { id: 'github', name: 'GitHub App', detail: 'Short-lived installation tokens' },
  { id: 'anthropic', name: 'Anthropic', detail: 'Console key · proxy custody' },
  { id: 'openai', name: 'OpenAI', detail: 'Console key · proxy custody' },
  { id: 'hetzner', name: 'Hetzner', detail: 'Static API token' },
  { id: 'generic', name: 'Generic static', detail: 'Any static API credential' },
] as const;

const DEFAULT_NAMES = {
  github: 'github',
  anthropic: 'anthropic',
  openai: 'openai',
  hetzner: 'hetzner',
  generic: '',
} satisfies Record<ConnectionTemplateId, string>;

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const encoded: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    encoded.unshift(remaining % 256);
  }
  return Uint8Array.of(0x80 | encoded.length, ...encoded);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return bytes(Uint8Array.of(tag), derLength(content.length), content);
}

function pem(label: string, value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/gu)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

export function githubPrivateKeyPkcs8(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('-----BEGIN RSA PRIVATE KEY-----')) return trimmed;
  const encoded = trimmed
    .replace('-----BEGIN RSA PRIVATE KEY-----', '')
    .replace('-----END RSA PRIVATE KEY-----', '')
    .replace(/\s+/gu, '');
  const privateKey = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return pem('PRIVATE KEY', der(0x30, bytes(version, rsaAlgorithm, der(0x04, privateKey))));
}

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? '').trim();
}

export function connectionInput(
  template: ConnectionTemplateId,
  data: FormData,
): PutConnectionRequest {
  const root = field(data, 'root');
  if (template === 'github') {
    return {
      provider: 'github',
      kind: 'app-jwt',
      custody: 'cp',
      root: githubPrivateKeyPkcs8(root),
      config: {
        app_id: field(data, 'appId'),
        installation_id: field(data, 'installationId'),
      },
    };
  }
  if (template === 'anthropic') {
    return {
      provider: 'anthropic',
      kind: 'static',
      custody: 'proxy',
      root,
      config: {
        default_scopes: [],
        placements: [
          { kind: 'env', name: 'ANTHROPIC_API_KEY', fill: 'token' },
          { kind: 'env', name: 'ANTHROPIC_BASE_URL', fill: 'proxy-url' },
        ],
        proxy: {
          base_url: 'https://api.anthropic.com',
          token_header: 'x-api-key',
          token_prefix: '',
        },
      },
    };
  }
  if (template === 'openai') {
    return {
      provider: 'openai',
      kind: 'static',
      custody: 'proxy',
      root,
      config: {
        default_scopes: [],
        placements: [
          { kind: 'env', name: 'OPENAI_API_KEY', fill: 'token' },
          { kind: 'env', name: 'OPENAI_BASE_URL', fill: 'proxy-url' },
        ],
        proxy: {
          base_url: 'https://api.openai.com/v1',
          token_header: 'Authorization',
          token_prefix: 'Bearer ',
        },
      },
    };
  }
  if (template === 'hetzner') {
    return {
      provider: 'hetzner',
      kind: 'static',
      custody: 'cp',
      root,
      config: {
        default_scopes: [],
        placements: [{ kind: 'env', name: 'HCLOUD_TOKEN' }],
      },
    };
  }
  const custody = field(data, 'custody') === 'proxy' ? 'proxy' : 'cp';
  const environmentName = field(data, 'environmentName');
  return {
    provider: field(data, 'provider'),
    kind: 'static',
    custody,
    root,
    config: custody === 'proxy'
      ? {
          default_scopes: [],
          placements: [
            { kind: 'env', name: environmentName, fill: 'token' },
            {
              kind: 'env',
              name: field(data, 'baseUrlEnvironmentName'),
              fill: 'proxy-url',
            },
          ],
          proxy: {
            base_url: field(data, 'baseUrl'),
            token_header: field(data, 'tokenHeader'),
            token_prefix: String(data.get('tokenPrefix') ?? ''),
          },
        }
      : {
          default_scopes: [],
          placements: [{ kind: 'env', name: environmentName }],
        },
  };
}

function templateFor(connection: ConnectionView): ConnectionTemplateId {
  if (connection.provider === 'github' && connection.kind === 'app-jwt') return 'github';
  if (connection.provider === 'anthropic') return 'anthropic';
  if (connection.provider === 'openai') return 'openai';
  if (connection.provider === 'hetzner') return 'hetzner';
  return 'generic';
}

export function ConnectionsPanel({
  client,
  requestedName,
}: {
  client: ControlPlaneClient;
  requestedName?: string;
}) {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [template, setTemplate] = useState<ConnectionTemplateId>('github');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState(DEFAULT_NAMES.github);
  const [genericCustody, setGenericCustody] = useState<'cp' | 'proxy'>('cp');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionView | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [githubKey, setGithubKey] = useState('');
  const formAnchor = useRef<HTMLElement>(null);

  const reload = useCallback(async () => {
    try {
      const response = await client.listConnections();
      setConnections(response.connections);
      setError(null);
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connections failed to load.'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const chooseTemplate = useCallback((next: ConnectionTemplateId, name = DEFAULT_NAMES[next]) => {
    setTemplate(next);
    setEditingName(null);
    setSuggestedName(name);
    setGenericCustody('cp');
    setGithubKey('');
    setFormVersion((current) => current + 1);
    setError(null);
  }, []);

  useEffect(() => {
    if (!requestedName) return;
    chooseTemplate('generic', requestedName);
    window.setTimeout(() => formAnchor.current?.scrollIntoView({ block: 'start' }), 0);
  }, [chooseTemplate, requestedName]);

  const edit = (connection: ConnectionView) => {
    const next = templateFor(connection);
    setTemplate(next);
    setEditingName(connection.name);
    setSuggestedName(connection.name);
    setGenericCustody(connection.custody === 'proxy' ? 'proxy' : 'cp');
    setGithubKey('');
    setFormVersion((current) => current + 1);
    setError(null);
    window.setTimeout(() => formAnchor.current?.scrollIntoView({ block: 'start' }), 0);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = field(data, 'name');
    setSaving(true);
    setError(null);
    try {
      await client.putConnection(name, connectionInput(template, data));
      form.reset();
      setEditingName(null);
      setSuggestedName(DEFAULT_NAMES[template]);
      setGithubKey('');
      setFormVersion((current) => current + 1);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connection save failed.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (connection: ConnectionView) => {
    if (deleting !== null) return;
    setDeleteTarget(null);
    setDeleting(connection.name);
    setError(null);
    try {
      await client.deleteConnection(connection.name);
      await reload();
    } catch (caught) {
      setError(caughtErrorMessage(caught, 'Connection delete failed.'));
    } finally {
      setDeleting(null);
    }
  };

  const pasteGithubKey = async () => {
    try {
      setGithubKey(await navigator.clipboard.readText());
      setError(null);
    } catch {
      setError('Clipboard access failed. Paste the private key into the field directly.');
    }
  };

  return (
    <section className="settings-panel settings-connections" role="tabpanel" aria-label="Connections">
      <header className="settings-panel-header">
        <div>
          <p>Credential control plane</p>
          <h1>Connections</h1>
          <span>Configure credential roots without displaying stored secret values.</span>
        </div>
      </header>
      {error && <p className="webapp-form-message" role="alert">{error}</p>}

      <section className="settings-credential-section" aria-label="Configured connections">
        <div className="settings-section-heading">
          <div><p>Custody registry</p><h2>Configured</h2></div>
          <span>{connections.length} total</span>
        </div>
        {loading ? (
          <p className="settings-credential-state">Loading connections…</p>
        ) : connections.length === 0 ? (
          <p className="settings-credential-state">No connections configured.</p>
        ) : (
          <div className="settings-credential-list">
            {connections.map((connection) => (
              <article className="settings-credential-row" key={connection.name}>
                <div>
                  <div className="settings-credential-row__title">
                    <h3>{connection.name}</h3>
                    <span className={`workspace-state-badge workspace-state-badge--${connection.status}`}>
                      {connection.status}
                    </span>
                  </div>
                  <p>{connection.provider} · {connection.kind}</p>
                  <small>custody · {connection.custody}</small>
                </div>
                <div className="settings-row-actions">
                  <button className="webapp-action" type="button" onClick={() => edit(connection)}>Replace</button>
                  <button
                    className="webapp-action webapp-action--danger"
                    type="button"
                    disabled={deleting !== null}
                    onClick={() => setDeleteTarget(connection)}
                  >{deleting === connection.name ? 'Deleting…' : 'Delete'}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section ref={formAnchor} className="settings-credential-section" aria-label="Add or replace connection">
        <div className="settings-section-heading">
          <div><p>Provider template</p><h2>{editingName ? `Replace ${editingName}` : 'Add connection'}</h2></div>
        </div>
        <div className="settings-template-grid">
          {TEMPLATES.map((candidate) => (
            <button
              className={candidate.id === template ? 'settings-template-card settings-template-card--active' : 'settings-template-card'}
              type="button"
              key={candidate.id}
              onClick={() => chooseTemplate(candidate.id)}
            >
              <strong>{candidate.name}</strong>
              <small>{candidate.detail}</small>
            </button>
          ))}
        </div>
        {(template === 'anthropic' || template === 'openai') && (
          <p className="webapp-form-message">Paste a console-created API key. This is not OAuth; the key remains under proxy custody.</p>
        )}
        <form
          className="settings-connection-form"
          key={`${template}:${editingName ?? 'new'}:${formVersion}`}
          onSubmit={(event) => { void save(event); }}
        >
          <label>Connection name<input name="name" required defaultValue={suggestedName} readOnly={editingName !== null} /></label>
          {template === 'github' && (
            <>
              <label>App ID<input name="appId" inputMode="numeric" required /></label>
              <label>Installation ID<input name="installationId" inputMode="numeric" required /></label>
              <label className="settings-connection-form__wide">
                PKCS#8 private key
                <textarea
                  name="root"
                  rows={7}
                  required
                  spellCheck={false}
                  autoComplete="off"
                  value={githubKey}
                  onChange={(event) => setGithubKey(event.currentTarget.value)}
                />
              </label>
              <div className="settings-secret-paste settings-connection-form__wide">
                <p>PKCS#1 RSA keys are converted to PKCS#8 in this browser before upload.</p>
                <button className="webapp-action" type="button" onClick={() => { void pasteGithubKey(); }}>Paste from clipboard</button>
              </div>
            </>
          )}
          {(template === 'anthropic' || template === 'openai' || template === 'hetzner') && (
            <label className="settings-connection-form__wide">
              {template === 'hetzner' ? 'API token' : 'Console API key'}
              <input name="root" type="password" required autoComplete="new-password" />
            </label>
          )}
          {template === 'generic' && (
            <>
              <label>Provider<input name="provider" required /></label>
              <label>Environment variable<input name="environmentName" required placeholder="SERVICE_API_KEY" /></label>
              <label>
                Custody
                <select
                  name="custody"
                  value={genericCustody}
                  onChange={(event) => setGenericCustody(event.currentTarget.value === 'proxy' ? 'proxy' : 'cp')}
                >
                  <option value="cp">Inject into workspace</option>
                  <option value="proxy">Proxy custody</option>
                </select>
              </label>
              {genericCustody === 'proxy' && (
                <>
                  <label>Vendor base URL<input name="baseUrl" type="url" required placeholder="https://api.example.com" /></label>
                  <label>Base URL environment variable<input name="baseUrlEnvironmentName" required placeholder="SERVICE_BASE_URL" /></label>
                  <label>Vendor token header<input name="tokenHeader" required defaultValue="Authorization" /></label>
                  <label>Vendor token prefix<input name="tokenPrefix" defaultValue="Bearer " /></label>
                </>
              )}
              <label className="settings-connection-form__wide">Credential value<input name="root" type="password" required autoComplete="new-password" /></label>
            </>
          )}
          <div className="settings-row-actions settings-connection-form__wide">
            <button className="webapp-action" type="button" onClick={() => chooseTemplate(template)}>Clear</button>
            <button className="webapp-action webapp-action--primary" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save connection'}
            </button>
          </div>
        </form>
      </section>
      {deleteTarget && (
        <ConfirmationDialog
          title="Delete connection?"
          description={`Delete ${deleteTarget.name}? This is a kill switch: active leases will be revoked immediately.`}
          confirmLabel="Delete connection"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => { void remove(deleteTarget); }}
        />
      )}
    </section>
  );
}
