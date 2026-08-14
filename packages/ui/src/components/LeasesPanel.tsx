import type { CredentialLeaseView } from "@blitzos/schema";
import { useEffect, useState } from "react";
import type { ControlPlaneClient } from "../api.js";

export function LeasesPanel({
  client,
  workspaceId,
}: {
  client: ControlPlaneClient;
  workspaceId: string;
}): React.JSX.Element {
  const [leases, setLeases] = useState<CredentialLeaseView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: AbortController | undefined;
    let failures = 0;
    const poll = async (): Promise<void> => {
      abort = new AbortController();
      try {
        const response = await client.listLeases(workspaceId, abort.signal);
        if (!active) return;
        setLeases(response.leases);
        setLoading(false);
        setError(null);
        failures = 0;
      } catch (caught) {
        if (!active || (caught instanceof DOMException && caught.name === "AbortError")) return;
        setLoading(false);
        failures += 1;
        setError(caught instanceof Error ? caught.message : "Credential leases failed to load.");
      }
      if (active) timer = setTimeout(() => void poll(), Math.min(2_000 * 2 ** failures, 16_000));
    };
    void poll();
    return () => {
      active = false;
      abort?.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, workspaceId]);

  const revoke = async (id: string): Promise<void> => {
    if (revoking !== null) return;
    setRevoking(id);
    setError(null);
    try {
      await client.revokeLease(id);
      setLeases((current) => current.map((lease) =>
        lease.id === id ? { ...lease, state: "revoked" } : lease
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Credential lease revoke failed.");
    } finally {
      setRevoking(null);
    }
  };

  return (
    <section className="panel leases-panel" aria-label="Workspace credential leases">
      <div className="panel-toolbar">
        <strong>Credential leases</strong>
        <span className="connection-status">Control plane audit view</span>
      </div>
      {error !== null && <p className="cockpit-form-message form-error lease-message" role="alert">{error}</p>}
      {loading ? <p className="loading-state has-spinner lease-message">Loading leases…</p> : leases.length === 0 ? (
        <div className="cockpit-empty lease-empty">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <rect x="6" y="13" width="20" height="14" />
            <path d="M11 13V9a5 5 0 0 1 10 0v4M16 18v5" />
          </svg>
          <h1>No credential leases</h1>
          <p>No credential leases for this workspace.</p>
        </div>
      ) : (
        <div className="lease-table" role="table" aria-label="Credential leases">
          <div className="lease-row lease-heading" role="row">
            <span>Integration</span><span>Scopes</span><span>Mode</span><span>State</span><span>Expiry</span><span />
          </div>
          {leases.map((lease) => (
            <div className="lease-row" role="row" key={lease.id}>
              <strong>{lease.integration}</strong>
              <span>{lease.scopes.length === 0 ? "—" : lease.scopes.join(", ")}</span>
              <span>{lease.mode}</span>
              <span className={`phase-badge ${lease.state === "active" ? "ready" : ""}`}>{lease.state}</span>
              <time dateTime={new Date(lease.expiresAt).toISOString()}>{new Date(lease.expiresAt).toLocaleString()}</time>
              <button
                className="cockpit-action danger"
                type="button"
                disabled={lease.state !== "active" || revoking !== null}
                onClick={() => void revoke(lease.id)}
              >Revoke</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
