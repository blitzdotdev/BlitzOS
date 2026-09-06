import { act } from "react";
import { describe, expect, it } from "vitest";
import { useAcpSessionConfigSelectionState } from "@lody/components/hooks/use-acp-session-config-selection";
import { render } from "./dom.js";

function Harness({
  targetKey,
  preserveUnsentUserEdits,
  preferenceModeId,
}: {
  targetKey: string;
  preserveUnsentUserEdits?: boolean;
  preferenceModeId?: string;
}) {
  const selection = useAcpSessionConfigSelectionState({
    targetKey,
    preferenceRevision: `revision:${preferenceModeId ?? "none"}`,
    preferences: preferenceModeId === undefined ? {} : { modeId: preferenceModeId },
    preserveUnsentUserEdits,
  });
  return (
    <>
      <button type="button" onClick={() => selection.selectMode("bypassPermissions")}>Pick</button>
      <output data-user-mode>{selection.selection.edits.mode?.value ?? "none"}</output>
    </>
  );
}

function userMode(container: HTMLElement): string | undefined {
  return container.querySelector("[data-user-mode]")?.textContent ?? undefined;
}

async function pickMode(container: HTMLElement): Promise<void> {
  await act(async () => container.querySelector("button")?.click());
}

describe("unsent run-configuration retention", () => {
  it("retains only opted-in edits per target and drops captured preferences", async () => {
    let view = await render(<Harness targetKey="remount-a" preserveUnsentUserEdits />);
    await pickMode(view.container);
    await view.unmount();
    view = await render(<Harness targetKey="remount-a" preserveUnsentUserEdits />);
    expect(userMode(view.container)).toBe("bypassPermissions");
    await view.unmount();

    view = await render(<Harness targetKey="switch-a" preserveUnsentUserEdits />);
    await pickMode(view.container);
    await act(async () => view.root.render(
      <Harness targetKey="switch-b" preserveUnsentUserEdits />,
    ));
    expect(userMode(view.container)).toBe("none");
    await act(async () => view.root.render(
      <Harness targetKey="switch-a" preserveUnsentUserEdits />,
    ));
    expect(userMode(view.container)).toBe("bypassPermissions");
    await view.unmount();

    const retentionCases: Array<readonly [string, boolean | undefined]> = [
      ["absent-retention", undefined],
      ["false-retention", false],
    ];
    for (const [targetKey, preserveUnsentUserEdits] of retentionCases) {
      view = await render(
        <Harness targetKey={targetKey} preserveUnsentUserEdits={preserveUnsentUserEdits} />,
      );
      await pickMode(view.container);
      await view.unmount();
      view = await render(
        <Harness targetKey={targetKey} preserveUnsentUserEdits={preserveUnsentUserEdits} />,
      );
      expect(userMode(view.container)).toBe("none");
      await view.unmount();
    }

    view = await render(<Harness targetKey="captured" preserveUnsentUserEdits />);
    await pickMode(view.container);
    await view.unmount();
    view = await render(
      <Harness
        targetKey="captured"
        preserveUnsentUserEdits
        preferenceModeId="bypassPermissions"
      />,
    );
    expect(userMode(view.container)).toBe("none");
    await view.unmount();
  });
});
