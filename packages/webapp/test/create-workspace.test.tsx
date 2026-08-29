import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuleView } from "@blitzos/schema";
import type { AgentRulesApi } from "../src/AgentRulesPicker.js";
import { ApiRequestError, type ControlPlaneClient } from "../src/api.js";
import { CreateWorkspaceDialog } from "../src/CreateWorkspaceDialog.js";
import { render, settle } from "./dom.js";

const BUILT_IN_RULE = {
  id: null,
  name: "Default (built-in)",
  content: "# Blitz box — agent rules\n",
  updatedAt: null,
  builtIn: true,
} as const;

afterEach(() => {
  window.history.replaceState({}, "", "/");
  window.sessionStorage.clear();
});

function rulesClient(
  rules: AgentRuleView[] = [BUILT_IN_RULE],
): AgentRulesApi & Pick<
  ControlPlaneClient,
  "connectStartUrl" | "listGithubInstallations" | "listGithubRepositories" | "listMembers"
> {
  return {
    listMembers: vi.fn(async () => ({ members: orgMembers })),
    listAgentRules: vi.fn(async () => ({ rules })),
    putAgentRule: vi.fn(async (id: string, input: { name: string; content: string }) => ({
      rule: { id, ...input, updatedAt: 5, builtIn: false },
    })),
    deleteAgentRule: vi.fn(async () => undefined),
    listGithubInstallations: vi.fn(async () => ({ installations: [] })),
    listGithubRepositories: vi.fn(async () => ({
      repositories: [],
      truncated: false,
    })),
    connectStartUrl: (provider, _workspaceId, returnTo) => {
      const query = returnTo === undefined
        ? ''
        : `?returnTo=${encodeURIComponent(returnTo)}`;
      return `/connect/${encodeURIComponent(provider)}/start${query}`;
    },
  };
}

const orgMembers = [
  { id: "membership-1", email: "ada@example.com", name: "Ada Park", avatarUrl: null, role: "admin" as const, status: "active" as const },
  { id: "membership-2", email: "nia@example.com", name: "Nia Newcomer", avatarUrl: null, role: "member" as const, status: "active" as const },
];

const machines = [
  { id: "cx23@fsn1", providerId: "hetzner", supportsVolumes: true, name: "CX23", cpuCores: 2, memGb: 4, diskGb: 40, arch: "x86" as const, location: "fsn1", monthlyPrice: { amount: 6.49, currency: "USD" } },
  { id: "mv-2c2g@lab", providerId: "microvm", supportsVolumes: false, name: "Lab 2C/2G", cpuCores: 2, memGb: 2, diskGb: 20, arch: "x86" as const, location: "lab", monthlyPrice: null },
];

describe("create workspace dialog", () => {
  it("groups machine types and submits the keyless wire body", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain("Hetzner · fsn1");
    expect(view.container.textContent).toContain("Local lab");
    expect(view.container.textContent).toContain("SSH public key (optional)");
    expect(view.container.querySelector<HTMLDetailsElement>('.blueprint-advanced')?.open).toBe(false);
    expect(view.container.textContent).toContain(
      "Optional. Without a key the workspace is webapp-only. Recreate the workspace to add one later.",
    );
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea[name="sshPublicKey"]')?.required).toBe(false);

    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledOnce();
    // Sharing defaults to the members named on the form: an org-wide share
    // gives every active member a machine, which is not a default.
    expect(submit).toHaveBeenCalledWith({ machineTypeId: "cx23@fsn1" });
    const keylessRequest = submit.mock.calls[0]?.[0];
    expect(Object.keys(keylessRequest).sort()).toEqual(["machineTypeId"]);
    expect("sshPublicKey" in keylessRequest).toBe(false);
    expect("volumeId" in keylessRequest).toBe(false);
    expect("members" in keylessRequest).toBe(false);
    expect("credentials" in keylessRequest).toBe(false);
    expect(JSON.stringify(keylessRequest)).toBe('{"machineTypeId":"cx23@fsn1"}');
    await view.unmount();
  });

  it("includes optional SSH and volume fields only when selected", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => [{
          id: "vol-1",
          name: "home",
          sizeGb: 50,
          location: "fsn1",
          status: "available",
          attachedTo: null,
        }]}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    const key = view.container.querySelector<HTMLTextAreaElement>('textarea[name="sshPublicKey"]')!;
    const volume = view.container.querySelector<HTMLSelectElement>('select[name="volumeId"]')!;
    await act(async () => {
      key.value = "ssh-ed25519 AAAA operator@example";
      key.dispatchEvent(new Event("input", { bubbles: true }));
      volume.value = "vol-1";
      volume.dispatchEvent(new Event("change", { bubbles: true }));
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(submit).toHaveBeenCalledWith({
      machineTypeId: "cx23@fsn1",
      sshPublicKey: "ssh-ed25519 AAAA operator@example",
      volumeId: "vol-1",
    });
    const completeRequest = submit.mock.calls[0]?.[0];
    expect(Object.keys(completeRequest).sort()).toEqual(["machineTypeId", "sshPublicKey", "volumeId"])
    expect("sshPublicKey" in completeRequest).toBe(true);
    expect("volumeId" in completeRequest).toBe(true);
    expect(JSON.stringify(completeRequest)).toBe(
      '{"machineTypeId":"cx23@fsn1","sshPublicKey":"ssh-ed25519 AAAA operator@example","volumeId":"vol-1"}',
    );
    await view.unmount();
  });

  it("summarizes provider failures when the machine catalog is empty", async () => {
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({
          machineTypes: [],
          failures: [
            { providerId: "hetzner", error: "Hetzner API request failed with status 403" },
            { providerId: "microvm", error: "no microVM hosts are reachable" },
          ],
        })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain("No machine types are available.");
    expect(view.container.textContent).toContain(
      "hetzner: Hetzner API request failed with status 403",
    );
    expect(view.container.textContent).toContain("microvm: no microVM hosts are reachable");
    expect(view.container.querySelector(".machine-catalog-groups")).toBeNull();
    expect(view.container.textContent).not.toContain("Some machine types are missing.");
    await view.unmount();
  });

  it("names the failed provider beside the machine types that did arrive", async () => {
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({
          machineTypes: machines,
          failures: [
            { providerId: "hetzner", error: "Hetzner API request failed with status 403" },
          ],
        })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();

    expect(view.container.querySelector(".machine-catalog-groups")).not.toBeNull();
    const notice = view.container.querySelector('[role="alert"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Some machine types are missing.");
    expect(notice?.textContent).toContain(
      "hetzner: Hetzner API request failed with status 403",
    );
    expect(view.container.textContent).not.toContain("No machine types are available.");
    await view.unmount();
  });

  it("keeps the bare empty-catalog message when no provider failed", async () => {
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({ machineTypes: [], failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain("No machine types are available.");
    expect(view.container.textContent).not.toContain("hetzner:");
    await view.unmount();
  });

  it("disables volume selection for a provider without volume support", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => [{
          id: "vol-1",
          name: "home",
          sizeGb: 50,
          location: "fsn1",
          status: "available",
          attachedTo: null,
        }]}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    const microvm = view.container.querySelector<HTMLInputElement>(
      'input[value="mv-2c2g@lab"]',
    );
    await act(async () => {
      microvm?.click();
    });
    const volume = view.container.querySelector<HTMLSelectElement>('select[name="volumeId"]');

    expect(volume?.disabled).toBe(true);
    expect(view.container.textContent).toContain(
      "Volumes are not supported by this machine provider.",
    );
    await view.unmount();
  });


  it("carries a repo selection with no template through the connect round trip", async () => {
    const client = rulesClient();
    client.listGithubRepositories = vi.fn(async () => {
      throw new ApiRequestError("GitHub is not connected", 409, null);
    });
    const first = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={client}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={vi.fn()}
      />,
    );
    await settle();
    const connect = first.container.querySelector<HTMLAnchorElement>(
      'a[href="/connect/github/start?returnTo=workspace-new"]',
    )!;
    connect.addEventListener('click', (event) => event.preventDefault());
    await act(async () => connect.click());
    // templateId null is the member's answer, not a missing one: the picker
    // only exists in that state, so the draft has to be able to say it.
    expect(JSON.parse(window.sessionStorage.getItem(
      'blitz:github-connect-draft:workspace-new',
    ) ?? '{}')).toEqual({
      templateId: null,
      agentRuleId: null,
      repos: [],
    });
    await first.unmount();

    window.history.replaceState({}, "", "/workspaces/new?connect=ok&provider=github");
    window.sessionStorage.setItem(
      'blitz:github-connect-draft:workspace-new',
      JSON.stringify({
        templateId: null,
        agentRuleId: null,
        repos: ['acme/app'],
      }),
    );
    const submit = vi.fn();
    const returned = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();
    await settle();
    expect(window.sessionStorage.getItem('blitz:github-connect-draft:workspace-new')).toBeNull();
    await act(async () => {
      returned.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ repos: ['acme/app'] }));
    await returned.unmount();
  });

  it("picks an agent rule in the same Advanced section and sends it", async () => {
    const submit = vi.fn();
    const orgRule = {
      id: "rule-1",
      name: "House rules",
      content: "# House rules\n",
      updatedAt: 3,
      builtIn: false,
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient([BUILT_IN_RULE, orgRule])}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    // Both editors live under one collapsed Advanced section.
    const advanced = view.container.querySelectorAll<HTMLDetailsElement>(".blueprint-advanced");
    expect(advanced).toHaveLength(1);
    expect(advanced[0]?.open).toBe(false);
    const select = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )!;
    expect(advanced[0]?.contains(select)).toBe(true);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Default (built-in)",
      "House rules",
      "New rule…",
    ]);

    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (selectSetter === undefined) throw new Error("select setter unavailable");
    await act(async () => {
      selectSetter.call(select, "rule-1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    // An untouched picker adds nothing to the body; the first test in this
    // suite pins that exact shape.
    expect(submit).toHaveBeenCalledWith({
      machineTypeId: "cx23@fsn1",
      agentRuleId: "rule-1",
    });
    await view.unmount();
  });

  it("validates an admin's cloud key inline and reveals machines without a reload", async () => {
    let stored = false;
    const listMachineTypes = vi.fn(async () => stored
      ? {
          machineTypes: [machines[0]!],
          failures: [],
          providerStatuses: [{ providerId: 'hetzner', access: 'org' as const }],
        }
      : {
          machineTypes: [],
          failures: [],
          providerStatuses: [{ providerId: 'hetzner', access: 'credential-required' as const }],
        });
    const saveComputeCredential = vi.fn(async () => {
      stored = true;
      return { provider: 'hetzner' as const, validated_at: 5, created_by: 'admin' };
    });
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        orgId="org-one"
        admin
        saveComputeCredential={saveComputeCredential}
        client={rulesClient()}
        listMachineTypes={listMachineTypes}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();

    expect(view.container.querySelector('.machine-catalog-groups')).toBeNull();
    expect(view.container.textContent).toContain('Add your Hetzner Cloud key');
    expect(view.container.textContent).not.toContain('No machine types are available.');
    const input = view.container.querySelector<HTMLInputElement>('input[name="token"]')!;
    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setInputValue === undefined) throw new Error('input value setter unavailable');
    await act(async () => {
      setInputValue.call(input, 'one-use-inline-key');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      [...view.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Validate and show machines')!.click();
    });
    await settle();

    expect(saveComputeCredential).toHaveBeenCalledWith('org-one', 'hetzner', {
      token: 'one-use-inline-key',
    });
    expect(listMachineTypes).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('.machine-catalog-groups')).not.toBeNull();
    expect(view.container.textContent).toContain('CX23');
    expect(view.container.textContent).not.toContain('one-use-inline-key');
    await view.unmount();
  });

  it("tells a non-admin which cloud key an organization admin must add", async () => {
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        orgId="org-one"
        client={rulesClient()}
        listMachineTypes={async () => ({
          machineTypes: [],
          failures: [],
          providerStatuses: [{ providerId: 'aws', access: 'credential-required' }],
        })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain('Amazon Web Services requires an organization key.');
    expect(view.container.textContent).toContain(
      'Ask an organization admin to add the key in Compute settings.',
    );
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(view.container.querySelector('.machine-catalog-groups')).toBeNull();
    await view.unmount();
  });
});
