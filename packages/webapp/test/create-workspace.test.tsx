import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { CreateWorkspaceDialog } from "../src/CreateWorkspaceDialog.js";
import { render, settle } from "./dom.js";

const machines = [
  { id: "cx23@fsn1", providerId: "hetzner", supportsVolumes: true, name: "CX23", cpuCores: 2, memGb: 4, diskGb: 40, arch: "x86" as const, location: "fsn1" },
  { id: "mv-2c2g@lab", providerId: "microvm", supportsVolumes: false, name: "Lab 2C/2G", cpuCores: 2, memGb: 2, diskGb: 20, arch: "x86" as const, location: "lab" },
];

const connectClient = {
  listConnectionCatalog: async () => ({ providers: [] }),
  putConnectionGrant: async () => undefined,
  connectStartUrl: (provider: string) => `/connect/${provider}/start`,
};

describe("create workspace dialog", () => {
  it("groups machine types and submits the keyless wire body", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        listTemplates={async () => []}
        listGrants={async () => []}
        connectClient={connectClient}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => machines}
        listVolumes={async () => []}
        onCancel={() => undefined}
        onSubmit={submit}
      />,
    );
    await settle();

    expect(view.container.textContent).toContain("Hetzner · fsn1");
    expect(view.container.textContent).toContain("Local lab");
    expect(view.container.textContent).toContain("SSH public key (optional)");
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
        listTemplates={async () => []}
        listGrants={async () => []}
        connectClient={connectClient}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => machines}
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

  it("disables volume selection for a provider without volume support", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        listTemplates={async () => []}
        listGrants={async () => []}
        connectClient={connectClient}
        onNewTemplate={() => undefined}
        listMachineTypes={async () => machines}
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
      folders: [
        { id: "folder-a", name: "datasets", role: "viewer" as const },
        { id: "folder-b", name: "private", role: null },
      ],
      connections: [{ provider: "linear", required: false }],
    };
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
        orgName="acme"
        listTemplates={async () => [template]}
        listGrants={async () => [{
          provider: "linear",
          manifestId: "linear",
          kind: "pat" as const,
          label: null,
          scopes: ["read"],
          createdAt: 1,
          updatedAt: 1,
          accessExpiresAt: null,
        }]}
        connectClient={connectClient}
        onNewTemplate={onNewTemplate}
        listMachineTypes={async () => machines}
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
    // The template's connections ride along as the workspace's enablement list.
    expect(submit).toHaveBeenCalledWith({
      templateId: "template-1",
      orgShareRole: "editor",
      connections: ["linear"],
    });

    const newTile = [...view.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("New template"))!;
    await act(async () => {
      newTile.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onNewTemplate).toHaveBeenCalledOnce();
    await view.unmount();
  });
});
