import type { CredentialLeaseView } from "@blitzos/schema";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ControlPlaneClient } from "../src/api.js";
import { LeasesPanel } from "../src/components/LeasesPanel.js";
import {
  githubPrivateKeyPkcs8,
  IntegrationsPanel,
} from "../src/settings/IntegrationsPanel.js";
import { render, settle } from "./dom.js";

function client(overrides: Partial<ControlPlaneClient> = {}): ControlPlaneClient {
  return {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    poll: vi.fn(async () => ({ workspaces: [] })),
    create: vi.fn(async () => { throw new Error("not used"); }),
    destroy: vi.fn(async () => { throw new Error("not used"); }),
    listMachineTypes: vi.fn(async () => ({ machineTypes: [] })),
    listVolumes: vi.fn(async () => ({ volumes: [] })),
    listIntegrations: vi.fn(async () => ({ integrations: [] })),
    putIntegration: vi.fn(async () => undefined),
    deleteIntegration: vi.fn(async () => undefined),
    listLeases: vi.fn(async () => ({ leases: [] })),
    revokeLease: vi.fn(async () => undefined),
    listCredentialRequests: vi.fn(async () => ({ requests: [] })),
    approveCredentialRequest: vi.fn(async () => undefined),
    denyCredentialRequest: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("credential cockpit surfaces", () => {
  it("lists integrations and resolves pending access requests", async () => {
    const approve = vi.fn(async () => undefined);
    const api = client({
      listIntegrations: vi.fn(async () => ({
        integrations: [{
          name: "openai-prod",
          provider: "openai",
          kind: "static" as const,
          custody: "proxy" as const,
          status: "active" as const,
        }],
      })),
      listCredentialRequests: vi.fn(async () => ({
        requests: [{
          id: "request-1",
          workspace_id: "workspace-1",
          integration_name: "github",
          requested_scopes: ["contents:read"],
          created_at: 1_700_000_000_000,
        }],
      })),
      approveCredentialRequest: approve,
    });
    const view = await render(<IntegrationsPanel client={api} onClose={() => undefined} />);
    await settle();

    expect(view.container.textContent).toContain("openai-prod");
    expect(view.container.textContent).toContain("contents:read");
    const approveButton = [...view.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(({ textContent }) => textContent === "Approve");
    await act(async () => approveButton?.click());

    expect(approve).toHaveBeenCalledWith("request-1");
    expect(view.container.textContent).toContain("No pending access requests.");
    await view.unmount();
  });

  it("renders named integration API failures plainly", async () => {
    const api = client({
      listIntegrations: vi.fn(async () => {
        throw new Error("API disabled");
      }),
    });
    const view = await render(<IntegrationsPanel client={api} onClose={() => undefined} />);
    await settle();

    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("API disabled");
    await view.unmount();
  });

  it("shows lease truth and revokes active leases", async () => {
    const lease: CredentialLeaseView = {
      id: "lease-1",
      workspaceId: "workspace-1",
      boxId: "box-1",
      integration: "github",
      userId: null,
      scopes: ["contents:read"],
      mode: "inject",
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
      state: "active",
    };
    const revoke = vi.fn(async () => undefined);
    const api = client({
      listLeases: vi.fn(async () => ({ leases: [lease] })),
      revokeLease: revoke,
    });
    const view = await render(<LeasesPanel client={api} workspaceId="workspace-1" />);
    await settle();

    expect(view.container.textContent).toContain("contents:read");
    const button = view.container.querySelector<HTMLButtonElement>("button.danger");
    await act(async () => button?.click());

    expect(revoke).toHaveBeenCalledWith("lease-1");
    expect(view.container.textContent).toContain("revoked");
    await view.unmount();
  });

  it("converts an RSA PKCS#1 paste to a PKCS#8 PEM locally", () => {
    const converted = githubPrivateKeyPkcs8(
      "-----BEGIN RSA PRIVATE KEY-----\nAQID\n-----END RSA PRIVATE KEY-----",
    );
    expect(converted).toMatch(/^-----BEGIN PRIVATE KEY-----/u);
    expect(converted).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});
