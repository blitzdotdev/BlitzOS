import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { CreateWorkspaceDialog } from "../src/CreateWorkspaceDialog.js";
import { render, settle } from "./dom.js";

const machines = [
  { id: "cx23@fsn1", name: "CX23", cpuCores: 2, memGb: 4, diskGb: 40, arch: "x86" as const, location: "fsn1" },
  { id: "mv-2c2g@lab", name: "Lab 2C/2G", cpuCores: 2, memGb: 2, diskGb: 20, arch: "x86" as const, location: "lab" },
];

describe("create workspace dialog", () => {
  it("groups machine types and submits the keyless wire body", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
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
      "Optional. Without a key the workspace is cockpit-only. Recreate the workspace to add one later.",
    );
    expect(view.container.querySelector<HTMLTextAreaElement>('textarea[name="sshPublicKey"]')?.required).toBe(false);

    await act(async () => {
      view.container.querySelector("form")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({ machineTypeId: "cx23@fsn1" });
    await view.unmount();
  });

  it("includes optional SSH and volume fields only when selected", async () => {
    const submit = vi.fn();
    const view = await render(
      <CreateWorkspaceDialog
        busy={false}
        error={null}
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
      sshPublicKey: "ssh-ed25519 AAAA operator@example",
      volumeId: "vol-1",
    });
    await view.unmount();
  });
});
