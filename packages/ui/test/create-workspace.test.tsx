import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { CreateWorkspaceForm } from "../src/components/CreateWorkspaceForm.js";
import { render, settle } from "./dom.js";

describe("create workspace", () => {
  it("mounts, edits, and cancels with zero mutations, then sends at most one request per confirmation", async () => {
    const create = vi.fn(async () => undefined);
    const cancel = vi.fn();
    const view = await render(
      <CreateWorkspaceForm
        loading={false}
        machineTypes={[{ id: "cpx", name: "CPX", cpuCores: 2, memGb: 4, diskGb: 40, arch: "x86", location: "sea" }]}
        volumes={[]}
        onCreate={create}
        onCancel={cancel}
      />,
    );

    expect(create).toHaveBeenCalledTimes(0);
    const machine = view.container.querySelector<HTMLSelectElement>('select[name="machineTypeId"]');
    const key = view.container.querySelector<HTMLTextAreaElement>('textarea[name="sshPublicKey"]');
    expect(machine).not.toBeNull();
    expect(key).not.toBeNull();
    await act(async () => {
      machine!.value = "cpx";
      machine!.dispatchEvent(new Event("change", { bubbles: true }));
      key!.value = "ssh-ed25519 AAAA test@example";
      key!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(create).toHaveBeenCalledTimes(0);

    const cancelButton = [...view.container.querySelectorAll("button")].find(({ textContent }) => textContent === "Cancel");
    await act(async () => cancelButton?.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(0);

    await act(async () => {
      view.container.querySelector("form.stack-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(create).toHaveBeenCalledTimes(0);
    const confirm = [...view.container.querySelectorAll("button")].find(({ textContent }) => textContent === "Confirm create");
    await act(async () => {
      confirm?.click();
      confirm?.click();
    });
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
