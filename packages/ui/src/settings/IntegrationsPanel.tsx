import type {
  CredentialRequestView,
  IntegrationView,
  PutIntegrationRequest,
} from "@blitzos/schema";
import { useEffect, useState } from "react";
import type { ControlPlaneClient } from "../api.js";

type TemplateId = "github" | "anthropic" | "openai" | "hetzner" | "generic";

const TEMPLATES: readonly {
  id: TemplateId;
  name: string;
  detail: string;
}[] = [
  { id: "github", name: "GitHub App", detail: "Short-lived installation tokens" },
  { id: "anthropic", name: "Anthropic", detail: "Console key · proxy custody" },
  { id: "openai", name: "OpenAI", detail: "Console key · proxy custody" },
  { id: "hetzner", name: "Hetzner", detail: "Static API token" },
  { id: "generic", name: "Generic static", detail: "Any static API credential" },
] as const;

const DEFAULT_NAMES: Record<TemplateId, string> = {
  github: "github",
  anthropic: "anthropic",
  openai: "openai",
  hetzner: "hetzner",
  generic: "",
};

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
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

export function githubPrivateKeyPkcs8(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("-----BEGIN RSA PRIVATE KEY-----")) return trimmed;
  const encoded = trimmed
    .replace("-----BEGIN RSA PRIVATE KEY-----", "")
    .replace("-----END RSA PRIVATE KEY-----", "")
    .replace(/\s+/gu, "");
  const privateKey = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0),
  );
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  );
  return pem("PRIVATE KEY", der(0x30, bytes(version, rsaAlgorithm, der(0x04, privateKey))));
}

function field(data: FormData, name: string): string {
  return String(data.get(name) ?? "").trim();
}

function integrationInput(template: TemplateId, data: FormData): PutIntegrationRequest {
  const root = field(data, "root");
  if (template === "github") {
    return {
      provider: "github",
      kind: "app-jwt",
      custody: "cp",
      root: githubPrivateKeyPkcs8(root),
      config: {
        app_id: field(data, "appId"),
        installation_id: field(data, "installationId"),
      },
    };
  }
  if (template === "anthropic") {
    return {
      provider: "anthropic",
      kind: "static",
      custody: "proxy",
      root,
      config: {
        default_scopes: [],
        placements: [
          { kind: "env", name: "ANTHROPIC_API_KEY", fill: "token" },
          { kind: "env", name: "ANTHROPIC_BASE_URL", fill: "proxy-url" },
        ],
        proxy: {
          base_url: "https://api.anthropic.com",
          token_header: "x-api-key",
          token_prefix: "",
        },
      },
    };
  }
  if (template === "openai") {
    return {
      provider: "openai",
      kind: "static",
      custody: "proxy",
      root,
      config: {
        default_scopes: [],
        placements: [
          { kind: "env", name: "OPENAI_API_KEY", fill: "token" },
          { kind: "env", name: "OPENAI_BASE_URL", fill: "proxy-url" },
        ],
        proxy: {
          base_url: "https://api.openai.com/v1",
          token_header: "Authorization",
          token_prefix: "Bearer ",
        },
      },
    };
  }
  if (template === "hetzner") {
    return {
      provider: "hetzner",
      kind: "static",
      custody: "cp",
      root,
      config: {
        default_scopes: [],
        placements: [{ kind: "env", name: "HCLOUD_TOKEN" }],
      },
    };
  }
  const custody = field(data, "custody") === "proxy" ? "proxy" : "cp";
  const environmentName = field(data, "environmentName");
  return {
    provider: field(data, "provider"),
    kind: "static",
    custody,
    root,
    config:
      custody === "proxy"
        ? {
            default_scopes: [],
            placements: [
              { kind: "env", name: environmentName, fill: "token" },
              {
                kind: "env",
                name: field(data, "baseUrlEnvironmentName"),
                fill: "proxy-url",
              },
            ],
            proxy: {
              base_url: field(data, "baseUrl"),
              token_header: field(data, "tokenHeader"),
              token_prefix: String(data.get("tokenPrefix") ?? ""),
            },
          }
        : {
            default_scopes: [],
            placements: [{ kind: "env", name: environmentName }],
          },
  };
}

function templateFor(integration: IntegrationView): TemplateId {
  if (integration.provider === "github" && integration.kind === "app-jwt") return "github";
  if (integration.provider === "anthropic") return "anthropic";
  if (integration.provider === "openai") return "openai";
  if (integration.provider === "hetzner") return "hetzner";
  return "generic";
}

function AccessRequestInbox({
  client,
  onConfigure,
}: {
  client: ControlPlaneClient;
  onConfigure: (name: string) => void;
}): React.JSX.Element {
  const [requests, setRequests] = useState<CredentialRequestView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      abort = new AbortController();
      try {
        const response = await client.listCredentialRequests(abort.signal);
        if (!active) return;
        setRequests(response.requests);
        setError(null);
        failures = 0;
      } catch (caught) {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        failures += 1;
        setError(caught instanceof Error ? caught.message : "Access requests failed to load.");
      }
      if (active) timer = setTimeout(() => void poll(), Math.min(2_000 * 2 ** failures, 16_000));
    };
    void poll();
    return () => {
      active = false;
      abort?.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client]);

  const resolve = async (request: CredentialRequestView, action: "approve" | "deny"): Promise<void> => {
    if (resolving !== null) return;
    setResolving(request.id);
    setError(null);
    try {
      if (action === "approve") await client.approveCredentialRequest(request.id);
      else await client.denyCredentialRequest(request.id);
      setRequests((current) => current.filter(({ id }) => id !== request.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Request ${action} failed.`);
    } finally {
      setResolving(null);
    }
  };

  return (
    <section className="credential-section" aria-label="Access request inbox">
      <div className="section-heading">
        <div><p className="eyebrow">Approval feed</p><h2>Access requests</h2></div>
        <span className="phase-badge">{requests.length} pending</span>
      </div>
      {error !== null && <p className="cockpit-form-message form-error" role="alert">{error}</p>}
      {requests.length === 0 ? (
        <div className="cockpit-empty credential-empty">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="5" y="7" width="22" height="18" />
            <path d="m5 10 11 8 11-8" />
          </svg>
          <h1>Inbox clear</h1>
          <p>No pending access requests.</p>
        </div>
      ) : (
        <div className="credential-list">
          {requests.map((request) => (
            <article className="credential-row" key={request.id}>
              <div>
                <h3>{request.integration_name}</h3>
                <p>Workspace {request.workspace_id}</p>
                <p className="muted">
                  {request.requested_scopes.length === 0
                    ? "Integration access (no named scopes)"
                    : request.requested_scopes.join(", ")}
                </p>
                <small>{new Date(request.created_at).toLocaleString()} · {request.id}</small>
              </div>
              <div className="button-row">
                <button className="cockpit-action" type="button" onClick={() => onConfigure(request.integration_name)}>Configure</button>
                <button
                  className="cockpit-action"
                  type="button"
                  disabled={resolving !== null}
                  onClick={() => void resolve(request, "deny")}
                >Deny</button>
                <button
                  className="cockpit-action cockpit-action--primary"
                  type="button"
                  disabled={resolving !== null}
                  onClick={() => void resolve(request, "approve")}
                >Approve</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

export function IntegrationsPanel({
  client,
  onClose,
}: {
  client: ControlPlaneClient;
  onClose: () => void;
}): React.JSX.Element {
  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [template, setTemplate] = useState<TemplateId>("github");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [suggestedName, setSuggestedName] = useState(DEFAULT_NAMES.github);
  const [genericCustody, setGenericCustody] = useState<"cp" | "proxy">("cp");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formVersion, setFormVersion] = useState(0);

  const reload = async (): Promise<void> => {
    try {
      const response = await client.listIntegrations();
      setIntegrations(response.integrations);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Integrations failed to load.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [client]);

  const chooseTemplate = (next: TemplateId, name = DEFAULT_NAMES[next]): void => {
    setTemplate(next);
    setEditingName(null);
    setSuggestedName(name);
    setGenericCustody("cp");
    setFormVersion((current) => current + 1);
    setError(null);
  };

  const edit = (integration: IntegrationView): void => {
    const next = templateFor(integration);
    setTemplate(next);
    setEditingName(integration.name);
    setSuggestedName(integration.name);
    setGenericCustody(integration.custody === "proxy" ? "proxy" : "cp");
    setFormVersion((current) => current + 1);
    setError(null);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = field(data, "name");
    setSaving(true);
    setError(null);
    try {
      await client.putIntegration(name, integrationInput(template, data));
      form.reset();
      setEditingName(null);
      setSuggestedName(DEFAULT_NAMES[template]);
      setFormVersion((current) => current + 1);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Integration save failed.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (name: string): Promise<void> => {
    if (!window.confirm(`Delete integration ${name}? Active leases will be revoked.`)) return;
    setError(null);
    try {
      await client.deleteIntegration(name);
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Integration delete failed.");
    }
  };

  return (
    <div className="modal-backdrop credential-backdrop" role="presentation">
      <div className="card credential-settings" role="dialog" aria-modal="true" aria-label="Credential settings">
        <div className="section-heading">
          <div><p className="eyebrow">Credential control plane</p><h1>Integrations</h1></div>
          <button className="cockpit-action" type="button" onClick={onClose}>Close</button>
        </div>
        {error !== null && <p className="cockpit-form-message form-error" role="alert">{error}</p>}

        <section className="credential-section" aria-label="Configured integrations">
          <h2>Configured</h2>
          {loading ? <p className="loading-state has-spinner">Loading integrations…</p> : integrations.length === 0 ? (
            <div className="cockpit-empty credential-empty">
              <svg viewBox="0 0 32 32" aria-hidden="true">
                <path d="M10 6v7M22 6v7M7 13h18v4a9 9 0 0 1-18 0zM16 26v-4" />
              </svg>
              <h1>No integrations</h1>
              <p>No integrations configured.</p>
            </div>
          ) : (
            <div className="credential-list">
              {integrations.map((integration) => (
                <article className="credential-row" key={integration.name}>
                  <div>
                    <h3>{integration.name}</h3>
                    <p>{integration.provider} · {integration.kind} · {integration.custody}</p>
                    <span className={`phase-badge ${integration.status === "active" ? "ready" : "error"}`}>
                      {integration.status}
                    </span>
                  </div>
                  <div className="button-row">
                    <button className="cockpit-action" type="button" onClick={() => edit(integration)}>Edit</button>
                    <button className="cockpit-action danger" type="button" onClick={() => void remove(integration.name)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="credential-section" aria-label="Add or edit integration">
          <h2>{editingName === null ? "Add integration" : `Replace ${editingName}`}</h2>
          <div className="template-grid">
            {TEMPLATES.map((candidate) => (
              <button
                className={candidate.id === template ? "cockpit-action template-card selected" : "cockpit-action template-card"}
                type="button"
                key={candidate.id}
                onClick={() => chooseTemplate(candidate.id)}
              >
                <strong>{candidate.name}</strong>
                <small>{candidate.detail}</small>
              </button>
            ))}
          </div>
          {(template === "anthropic" || template === "openai") && (
            <p className="cockpit-form-message warning">Paste a console-created API key. This is not OAuth; the key remains under proxy custody.</p>
          )}
          <form
            className="stack-form integration-form"
            key={`${template}:${editingName ?? "new"}:${formVersion}`}
            onSubmit={(event) => void save(event)}
          >
            <label>
              Integration name
              <input name="name" required defaultValue={suggestedName} readOnly={editingName !== null} />
            </label>
            {template === "github" && (
              <>
                <label>App ID<input name="appId" inputMode="numeric" required /></label>
                <label>Installation ID<input name="installationId" inputMode="numeric" required /></label>
                <label>
                  PKCS#8 private key
                  <textarea name="root" rows={7} required spellCheck={false} autoComplete="off" />
                </label>
                <p className="muted">PKCS#1 RSA keys are converted to PKCS#8 in this browser before upload.</p>
              </>
            )}
            {(template === "anthropic" || template === "openai" || template === "hetzner") && (
              <label>
                {template === "hetzner" ? "API token" : "Console API key"}
                <input name="root" type="password" required autoComplete="off" />
              </label>
            )}
            {template === "generic" && (
              <>
                <label>Provider<input name="provider" required /></label>
                <label>Environment variable<input name="environmentName" required placeholder="SERVICE_API_KEY" /></label>
                <label>
                  Custody
                  <select
                    name="custody"
                    value={genericCustody}
                    onChange={(event) => setGenericCustody(event.currentTarget.value === "proxy" ? "proxy" : "cp")}
                  >
                    <option value="cp">Inject into workspace</option>
                    <option value="proxy">Proxy custody</option>
                  </select>
                </label>
                {genericCustody === "proxy" && (
                  <>
                    <label>Vendor base URL<input name="baseUrl" type="url" required placeholder="https://api.example.com" /></label>
                    <label>Base URL environment variable<input name="baseUrlEnvironmentName" required placeholder="SERVICE_BASE_URL" /></label>
                    <label>Vendor token header<input name="tokenHeader" required defaultValue="Authorization" /></label>
                    <label>Vendor token prefix<input name="tokenPrefix" defaultValue="Bearer " /></label>
                  </>
                )}
                <label>Credential value<input name="root" type="password" required autoComplete="off" /></label>
              </>
            )}
            <div className="button-row">
              <button className="cockpit-action" type="button" onClick={() => chooseTemplate(template)}>Clear</button>
              <button className="cockpit-action cockpit-action--primary" type="submit" disabled={saving}>
                {saving && <span className="cockpit-inline-spinner" />}
                {saving ? "Saving…" : "Save integration"}
              </button>
            </div>
          </form>
        </section>

        <AccessRequestInbox
          client={client}
          onConfigure={(name) => chooseTemplate("generic", name)}
        />
      </div>
    </div>
  );
}
