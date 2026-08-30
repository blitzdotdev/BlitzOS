/**
 * The vendored Lody leaves render inside our tree, from fixtures, with no
 * daemon and no network (plans/LODY-SESSIONS.md §10, phase 0's exit test 2).
 *
 * It survives phase 3 because it gates every merge and the mounted-surface test
 * cannot: that one needs a real `lody` daemon and skips without one. This is
 * what fails first when an upstream merge changes a prop contract on
 * `SessionChatStreamView`, `ChatComposer` or `LoroSidebar`.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { LodyFixtureSurface } from "./lody-fixture-surface";
import { installLodyDomStubs } from "./lody-dom-stubs";
import { render, settle } from "./dom";

let cleanup: (() => Promise<void>) | null = null;

beforeAll(() => {
  installLodyDomStubs();
});

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup();
    cleanup = null;
  }
});

describe("vendored Lody leaves", () => {
  it("renders the chat stream, the composer, and the sidebar body from fixtures", async () => {
    const mounted = await render(<LodyFixtureSurface />);
    cleanup = mounted.unmount;
    await settle();

    const text = mounted.container.textContent ?? "";

    // SessionChatStreamView: the user turn, the assistant answer, the folded
    // tool activity, and the edited-files card built from `fileDiff`.
    expect(text).toContain("Swap the workspace rail over to Lody session rows.");
    expect(text).toContain("The rail now renders");
    // The finished turn folded its tool activity behind a "Worked for" header,
    // which is the stream's own turn-folding contract rather than our fixture.
    expect(text).toMatch(/Worked for/);

    // ChatComposer: its textarea holds the fixture prompt and both pickers
    // rendered their selected option.
    const composer = mounted.container.querySelector("textarea");
    expect(composer).not.toBeNull();
    expect((composer as HTMLTextAreaElement).value).toContain("Move the rail over to Lody");
    expect(text).toContain("blitzdotdev/BlitzOS");

    // LoroSidebar body: session rows for both sections, and the slot we will
    // inject native Terminals rows through in phase 4 (§0.3).
    expect(text).toContain("fix the login redirect");
    expect(text).toContain("rail swap");
    expect(text).toContain("Terminals (native rows land here)");

    // Everything Lody renders stays inside the surface boundary the
    // containment test probes.
    expect(mounted.container.querySelector(".lody-surface")).not.toBeNull();
  });
});
