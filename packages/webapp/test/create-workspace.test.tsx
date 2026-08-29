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
  "connectStartUrl" | "listGithubInstallations" | "listGithubRepositories"
> {
  return {
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
    expect(submit).toHaveBeenCalledWith({ machineTypeId: "cx23@fsn1", orgShareRole: "editor" });
    const keylessRequest = submit.mock.calls[0]?.[0];
    expect(Object.keys(keylessRequest).sort()).toEqual(["machineTypeId", "orgShareRole"]);
    expect("sshPublicKey" in keylessRequest).toBe(false);
    expect("volumeId" in keylessRequest).toBe(false);
    expect(JSON.stringify(keylessRequest)).toBe('{"machineTypeId":"cx23@fsn1","orgShareRole":"editor"}');
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
      orgShareRole: "editor",
      sshPublicKey: "ssh-ed25519 AAAA operator@example",
      volumeId: "vol-1",
    });
    const completeRequest = submit.mock.calls[0]?.[0];
    expect(Object.keys(completeRequest).sort()).toEqual(["machineTypeId", "orgShareRole", "sshPublicKey", "volumeId"])
    expect("sshPublicKey" in completeRequest).toBe(true);
    expect("volumeId" in completeRequest).toBe(true);
    expect(JSON.stringify(completeRequest)).toBe(
      '{"machineTypeId":"cx23@fsn1","sshPublicKey":"ssh-ed25519 AAAA operator@example","volumeId":"vol-1","orgShareRole":"editor"}',
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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


  it("picks repositories without a template and hides the picker under one", async () => {
    const submit = vi.fn();
    const client = rulesClient();
    client.listGithubRepositories = vi.fn(async () => ({
      repositories: [
        { repo: "acme/app", accountLogin: "acme", private: true },
        { repo: "acme/tools", accountLogin: "acme", private: false },
      ],
      truncated: false,
    }));
    const template = {
      id: "template-1",
      name: "analysis starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: null,
      isOrgDefault: false,
      environment: null,
      folders: [],
      connections: [],
      repos: [],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={client}
        listTemplates={async () => [template]}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();
    await settle();

    const checkbox = (repo: string) => [...view.container
      .querySelectorAll<HTMLLabelElement>('.tplf-repo')]
      .find((label) => label.textContent?.startsWith(repo))
      ?.querySelector<HTMLInputElement>('input')!;
    await act(async () => checkbox('acme/app').click());
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      machineTypeId: "cx23@fsn1",
      repos: ["acme/app"],
    }));

    // A template carries its own list, and the control plane refuses a body
    // that names both, so selecting one takes the picker and the selection.
    await act(async () => {
      [...view.container.querySelectorAll<HTMLButtonElement>('.template-tile')]
        .find((tile) => tile.textContent?.includes('analysis starter'))?.click();
    });
    expect(view.container.querySelector('.tplf-repos')).toBeNull();
    await act(async () => {
      [...view.container.querySelectorAll<HTMLButtonElement>('.template-tile')]
        .find((tile) => tile.textContent?.includes('No template'))?.click();
    });
    await settle();
    expect(checkbox('acme/app').checked).toBe(false);
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
        listTemplates={async () => []}
        // The org default must not reclaim a member who deselected it.
        initialTemplateId="template-default"
        onNewTemplate={() => undefined}
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

  it("collapses the form when a template is selected and submits the template body", async () => {
    const submit = vi.fn();
    const onNewTemplate = vi.fn();
    const template = {
      id: "template-1",
      name: "analysis starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: null,
      isOrgDefault: false,
      environment: {
        env: { FROM_TEMPLATE: "yes" },
        startupScript: "./setup.sh\n",
      },
      folders: [
        { id: "folder-a", name: "datasets", role: "viewer" as const },
        { id: "folder-b", name: "private", role: null },
      ],
      connections: [{ provider: "linear" }],
      repos: [],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listTemplates={async () => [template]}
        onNewTemplate={onNewTemplate}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain("analysis starter");
    expect(view.container.textContent).toContain("by Ada Park");
    expect(view.container.textContent).toContain("1 folder you cannot access yet");
    expect(view.container.querySelector('input[name="name"]')).not.toBeNull();

    const tile = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("analysis starter"))!;
    await act(async () => {
      tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(view.container.querySelector('input[name="name"]')).toBeNull();
    expect(view.container.querySelector('select[name="orgShareRole"]')).toBeNull();
    expect(view.container.textContent).toContain("no access yet, will not sync");

    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    // The server enables the template's own connections; the dialog sends
    // none of its own — creation never blocks on them and never names them.
    expect(submit).toHaveBeenCalledWith({
      templateId: "template-1",
      orgShareRole: "editor",
    });

    const newTile = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New template"))!;
    await act(async () => {
      newTile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNewTemplate).toHaveBeenCalledOnce();
    await view.unmount();
  });

  it("blocks a private-repo template until the member connects GitHub", async () => {
    const submit = vi.fn();
    const listGithubRepositories = vi.fn(async () => {
      throw new ApiRequestError("GitHub is not connected", 409, null);
    });
    const template = {
      id: "template-private",
      name: "private starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: null,
      isOrgDefault: false,
      environment: null,
      folders: [],
      connections: [{ provider: "github" }],
      repos: [{ repo: "acme/private-app", private: true }],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={{ ...rulesClient(), listGithubRepositories }}
        listTemplates={async () => [template]}
        initialTemplateId={template.id}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();
    await settle();

    expect(listGithubRepositories).toHaveBeenCalledWith();
    const create = view.container.querySelector<HTMLButtonElement>('.create-workspace-primary')!;
    expect(create.disabled).toBe(true);
    const connect = view.container.querySelector<HTMLAnchorElement>(
      'a[href="/connect/github/start?returnTo=workspace-new"]',
    )!;
    expect(connect.textContent).toBe('Connect GitHub');
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).not.toHaveBeenCalled();
    connect.addEventListener('click', (event) => event.preventDefault());
    await act(async () => connect.click());
    expect(JSON.parse(window.sessionStorage.getItem(
      'blitz:github-connect-draft:workspace-new',
    ) ?? '{}')).toEqual({
      templateId: 'template-private',
      agentRuleId: null,
      repos: [],
    });
    await view.unmount();
  });

  it("restores the selected template after connect instead of the org default", async () => {
    window.history.replaceState({}, "", "/workspaces/new?connect=ok&provider=github");
    window.sessionStorage.setItem(
      'blitz:github-connect-draft:workspace-new',
      JSON.stringify({
        templateId: 'template-private',
        agentRuleId: 'rule-override',
        repos: [],
      }),
    );
    const submit = vi.fn();
    const privateTemplate = {
      id: "template-private",
      name: "private starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: null,
      isOrgDefault: false,
      environment: null,
      folders: [],
      connections: [{ provider: "github" }],
      repos: [{ repo: "acme/private-app", private: true }],
    };
    const defaultTemplate = {
      ...privateTemplate,
      id: "template-default",
      name: "org default",
      isOrgDefault: true,
      connections: [],
      repos: [],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient([BUILT_IN_RULE, {
          id: 'rule-override',
          name: 'Redirect rules',
          content: '# Redirect rules\n',
          updatedAt: 7,
          builtIn: false,
        }])}
        listTemplates={async () => [defaultTemplate, privateTemplate]}
        initialTemplateId={defaultTemplate.id}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();
    await settle();

    const privateTile = [...view.container.querySelectorAll<HTMLButtonElement>('.template-tile')]
      .find((tile) => tile.textContent?.includes('private starter'))!;
    const defaultTile = [...view.container.querySelectorAll<HTMLButtonElement>('.template-tile')]
      .find((tile) => tile.textContent?.includes('org default'))!;
    expect(privateTile.getAttribute('aria-pressed')).toBe('true');
    expect(defaultTile.getAttribute('aria-pressed')).toBe('false');
    expect(window.sessionStorage.getItem('blitz:github-connect-draft:workspace-new')).toBeNull();
    expect(view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe('rule-override');
    expect(view.container.querySelector<HTMLButtonElement>('.create-workspace-primary')?.disabled)
      .toBe(false);
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith({
      templateId: 'template-private',
      orgShareRole: 'editor',
      agentRuleId: 'rule-override',
    });
    await view.unmount();
  });

  it("preselects the org-default template from initialTemplateId, deselectably", async () => {
    const submit = vi.fn();
    const template = {
      id: "template-default",
      name: "org starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: "rule-1",
      isOrgDefault: true,
      environment: {
        env: { FROM_TEMPLATE: "yes" },
        startupScript: "./setup.sh\n",
      },
      folders: [],
      connections: [],
      repos: [],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient([BUILT_IN_RULE, {
          id: "rule-1",
          name: "House rules",
          content: "# House rules\n",
          updatedAt: 3,
          builtIn: false,
        }])}
        listTemplates={async () => [template]}
        initialTemplateId="template-default"
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    // Seeding behaves exactly like a click on the tile: the manual form is
    // collapsed and the template's rule rides along.
    expect(view.container.querySelector('input[name="name"]')).toBeNull();
    const tile = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("org starter"))!;
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe("rule-1");

    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith({
      templateId: "template-default",
      orgShareRole: "editor",
    });
    await view.unmount();

    // The member can still walk away from the default to the manual form.
    const deselected = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listTemplates={async () => [template]}
        initialTemplateId="template-default"
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();
    const pressed = [...deselected.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("org starter"))!;
    await act(async () => {
      pressed.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(deselected.container.querySelector('input[name="name"]')).not.toBeNull();
    await deselected.unmount();
  });

  it("offers a blank tile that leaves the org default and creates with no template", async () => {
    const submit = vi.fn();
    const template = {
      id: "template-default",
      name: "org starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: "rule-1",
      isOrgDefault: true,
      environment: {
        env: { FROM_TEMPLATE: "yes" },
        startupScript: "./setup.sh\n",
      },
      folders: [],
      connections: [],
      repos: [],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient([BUILT_IN_RULE, {
          id: "rule-1",
          name: "House rules",
          content: "# House rules\n",
          updatedAt: 3,
          builtIn: false,
        }])}
        listTemplates={async () => [template]}
        initialTemplateId="template-default"
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    // The blank choice leads the grid, before any template.
    const blank = view.container.querySelector<HTMLButtonElement>(".template-grid > button")!;
    expect(blank.textContent).toContain("No template");
    // The org default is seeded, so the blank tile is not the pressed one yet.
    expect(blank.getAttribute("aria-pressed")).toBe("false");
    expect(view.container.querySelector('input[name="name"]')).toBeNull();

    await act(async () => {
      blank.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const tiles = [...view.container.querySelectorAll<HTMLButtonElement>(".template-grid > button")];
    expect(tiles[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(tiles[1]?.getAttribute("aria-pressed")).toBe("false");
    // The member now picks the machine, so the manual form is back.
    expect(view.container.querySelector(".machine-catalog-groups")).not.toBeNull();
    expect(view.container.querySelector('input[name="name"]')).not.toBeNull();
    expect(view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe("");

    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    // The template's id and rule both left with it.
    expect(submit).toHaveBeenCalledWith({
      machineTypeId: "cx23@fsn1",
      orgShareRole: "editor",
    });
    expect("templateId" in submit.mock.calls[0]![0]).toBe(false);
    await view.unmount();
  });

  it("ignores an initialTemplateId the list no longer carries and stays manual", async () => {
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        client={rulesClient()}
        listTemplates={async () => []}
        initialTemplateId="template-deleted"
        onNewTemplate={() => undefined}
        listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    await settle();
    expect(view.container.querySelector('input[name="name"]')).not.toBeNull();
    await view.unmount();
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
      orgShareRole: "editor",
      agentRuleId: "rule-1",
    });
    await view.unmount();
  });

  it("prefills a template's rule and sends an explicit override", async () => {
    const submit = vi.fn();
    const orgRule = {
      id: "rule-1",
      name: "House rules",
      content: "# House rules\n",
      updatedAt: 3,
      builtIn: false,
    };
    const template = {
      id: "template-1",
      name: "analysis starter",
      machineTypeId: "cx23@fsn1",
      createdAt: 1,
      createdBy: { name: "Ada Park", avatarUrl: null },
      agentRuleId: "rule-1",
      isOrgDefault: false,
      environment: null,
      folders: [],
      connections: [],
      repos: [],
    };
    // The dialog refuses a second submit per mount, so each expectation gets
    // its own render.
    const open = async () => {
      const view = await render(
        <CreateWorkspaceDialog
          busy={false}
          error={null}
          orgName="acme"
          client={rulesClient([BUILT_IN_RULE, orgRule])}
          listTemplates={async () => [template]}
          onNewTemplate={() => undefined}
          listMachineTypes={async () => ({ machineTypes: machines, failures: [] })}
          listVolumes={async () => []}
          onCancel={() => undefined}
          onSubmit={submit}
        />,
      );
      await settle();
      const tile = [...view.container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("analysis starter"))!;
      await act(async () => {
        tile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      return view;
    };
    const submitForm = async (view: { container: HTMLElement }) => {
      await act(async () => {
        view.container.querySelector("form")?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
    };

    // The template's rule pre-fills, and matching it needs no field on the wire.
    const untouched = await open();
    expect(untouched.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )?.value).toBe("rule-1");
    await submitForm(untouched);
    expect(submit).toHaveBeenCalledWith({ templateId: "template-1", orgShareRole: "editor" });
    await untouched.unmount();

    // Going back to the default is an explicit null, not silence — otherwise
    // the server would read it as "keep the template's rule".
    const overridden = await open();
    const select = overridden.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent rules document"]',
    )!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (selectSetter === undefined) throw new Error("select setter unavailable");
    await act(async () => {
      selectSetter.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submitForm(overridden);
    expect(submit).toHaveBeenLastCalledWith({
      templateId: "template-1",
      orgShareRole: "editor",
      agentRuleId: null,
    });
    await overridden.unmount();
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
        listTemplates={async () => []}
        onNewTemplate={() => undefined}
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
