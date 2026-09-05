/**
 * The shell's grey screen, and the listener that ends it.
 *
 * `CloudApp` arms `.webapp-drop-overlay` on `dragover` and clears it in its own
 * `onDrop`. The vendored Lody composer calls `event.stopPropagation()` on a
 * file drop, so that handler never runs and the scrim stays over the page.
 * This suite reproduces the shape rather than the shell: a mask owner, and one
 * descendant that consumes the drop.
 *
 * The last case is not a mount. It reads `CloudApp.tsx` and proves the shell
 * still takes its mask state from this hook, because a harness that owns its
 * own handlers cannot prove that by itself.
 */
import { act } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceDropMaskState } from "../src/workspace-drop-mask.js";
import { render } from "./dom.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function ConsumedDropHarness({ onShellDrop }: { onShellDrop: () => void }) {
  const { dropActive, setDropActive } = useWorkspaceDropMaskState();
  return (
    <main
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDrop={() => {
        onShellDrop();
        setDropActive(false);
      }}
    >
      {dropActive ? <div className="webapp-drop-overlay">Drop files</div> : null}
      <button type="button" onDrop={(event) => event.stopPropagation()}>
        Composer
      </button>
    </main>
  );
}

function composer(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("Composer drop target did not render");
  return button;
}

describe("the workspace drop mask", () => {
  /**
   * Without the capture listeners, the final overlay assertion fails.
   * The child stops the shell's bubble-phase drop handler.
   */
  it("clears after a descendant consumes the drop", async () => {
    const onShellDrop = vi.fn();
    const view = await render(<ConsumedDropHarness onShellDrop={onShellDrop} />);
    const target = composer(view.container);

    await act(async () => {
      target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector(".webapp-drop-overlay")).not.toBeNull();

    await act(async () => {
      target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(onShellDrop).not.toHaveBeenCalled();
    expect(view.container.querySelector(".webapp-drop-overlay")).toBeNull();
    await view.unmount();
  });

  /** An OS file drag fires no `dragend` in this document. A drag started inside
   * it does, and ends with no drop at all, so both events have to clear. */
  it("clears when the drag ends without a shell drop", async () => {
    const view = await render(<ConsumedDropHarness onShellDrop={() => undefined} />);
    const target = composer(view.container);

    await act(async () => {
      target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector(".webapp-drop-overlay")).not.toBeNull();

    await act(async () => {
      target.dispatchEvent(new Event("dragend", { bubbles: true, cancelable: true }));
    });
    expect(view.container.querySelector(".webapp-drop-overlay")).toBeNull();
    await view.unmount();
  });

  it("is the state the workspace shell actually uses", () => {
    const shell = readFileSync(join(repoRoot, "packages/webapp/src/CloudApp.tsx"), "utf8");
    expect(shell).toContain(
      "import { useWorkspaceDropMaskState } from './workspace-drop-mask';",
    );
    expect(shell).toContain("const { dropActive, setDropActive } = useWorkspaceDropMaskState();");
    // A bare `useState` here is the defect coming back: nothing would clear the
    // mask after a descendant consumed the drop.
    expect(shell).not.toContain("const [dropActive, setDropActive] = useState(false);");
  });
});
