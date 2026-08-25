import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuleView } from "@blitzos/schema";
import type { AgentRulesApi } from "../src/AgentRulesPicker.js";
import { CreateWorkspaceDialog } from "../src/CreateWorkspaceDialog.js";
import { render, settle } from "./dom.js";

const BUILT_IN_RULE = {
  id: null,
  name: "Default (built-in)",
  content: "# Blitz box — agent rules\n",
  updatedAt: null,
  builtIn: true,
} as const;

function rulesClient(rules: AgentRuleView[] = [BUILT_IN_RULE]): AgentRulesApi {
  return {
    listAgentRules: vi.fn(async () => ({ rules })),
    putAgentRule: vi.fn(async (id: string, input: { name: string; content: string }) => ({
      rule: { id, ...input, updatedAt: 5, builtIn: false },
    })),
    deleteAgentRule: vi.fn(async () => undefined),
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

  it("submits a populated advanced environment", async () => {
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
    const key = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable key 1"]',
    )!;
    const value = view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Environment variable value 1"]',
    )!;
    const script = view.container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Startup script"]',
    )!;
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (inputSetter === undefined || textareaSetter === undefined) throw new Error('input setter unavailable');
    await act(async () => {
      inputSetter.call(key, 'API_ORIGIN');
      key.dispatchEvent(new Event('input', { bubbles: true }));
      inputSetter.call(value, 'https://api.example');
      value.dispatchEvent(new Event('input', { bubbles: true }));
      textareaSetter.call(script, 'npm install\n');
      script.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      view.container.querySelector('form')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledWith({
      machineTypeId: 'cx23@fsn1',
      orgShareRole: 'editor',
      environment: {
        env: { API_ORIGIN: 'https://api.example' },
        startupScript: 'npm install\n',
      },
    });
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
      environment: template.environment,
    });

    const newTile = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New template"))!;
    await act(async () => {
      newTile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNewTemplate).toHaveBeenCalledOnce();
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
    // collapsed and the template's environment and rule ride along.
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
      environment: template.environment,
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
    // The template's id, environment and rule all left with it.
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
    expect(advanced[0]?.querySelector('textarea[aria-label="Startup script"]')).not.toBeNull();
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
});
