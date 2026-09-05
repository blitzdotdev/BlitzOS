import { act } from "react";
import { I18nextProvider } from "react-i18next";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ChatLandingView } from "@lody/components/components/chat/chat-landing-view";
import { initLodyI18n } from "../src/lody/i18n.js";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render } from "./dom.js";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function fileDragEvent(type: "dragenter" | "drop", files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files,
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      dropEffect: "none",
    },
  });
  return event;
}

function landingHeading(container: HTMLElement): HTMLHeadingElement {
  const heading = container.querySelector("h1");
  if (!heading) throw new Error("Chat landing heading did not render");
  return heading;
}

describe("the chat landing page file drop zone", () => {
  /**
   * Without the page zone, the callback assertion fails.
   * The heading sits outside the composer.
   */
  it("accepts a file dropped on the desktop heading", async () => {
    const onImageDrop = vi.fn();
    const view = await render(
      <I18nextProvider i18n={initLodyI18n()}>
        <ChatLandingView
          tone="light"
          title="Start a session"
          promptValue=""
          onPromptChange={() => undefined}
          onImageDrop={onImageDrop}
        />
      </I18nextProvider>,
    );
    const heading = landingHeading(view.container);
    const image = new File(["image"], "screen.png", { type: "image/png" });

    await act(async () => {
      heading.dispatchEvent(fileDragEvent("dragenter", [image]));
    });
    expect(view.container.querySelector("[data-testid='conversation-drop-overlay']")?.getAttribute(
      "data-drop-kind",
    )).toBe("files");

    await act(async () => {
      heading.dispatchEvent(fileDragEvent("drop", [image]));
    });
    expect(onImageDrop).toHaveBeenCalledWith([image]);
    expect(view.container.querySelector("[data-testid='conversation-drop-overlay']")).toBeNull();
    await view.unmount();
  });

  it("keeps the mobile landing outside HTML drag and drop", async () => {
    const onImageDrop = vi.fn();
    const view = await render(
      <I18nextProvider i18n={initLodyI18n()}>
        <ChatLandingView
          tone="light"
          isMobile
          title="Start a session"
          promptValue=""
          onPromptChange={() => undefined}
          onImageDrop={onImageDrop}
        />
      </I18nextProvider>,
    );
    const image = new File(["image"], "screen.png", { type: "image/png" });

    await act(async () => {
      view.container.dispatchEvent(fileDragEvent("drop", [image]));
    });
    expect(onImageDrop).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-testid='conversation-drop-overlay']")).toBeNull();
    await view.unmount();
  });

  it("stays inactive without a file consumer", async () => {
    const view = await render(
      <I18nextProvider i18n={initLodyI18n()}>
        <ChatLandingView
          tone="light"
          title="Start a session"
          promptValue=""
          onPromptChange={() => undefined}
        />
      </I18nextProvider>,
    );
    const image = new File(["image"], "screen.png", { type: "image/png" });

    await act(async () => {
      landingHeading(view.container).dispatchEvent(fileDragEvent("dragenter", [image]));
    });
    expect(view.container.querySelector("[data-testid='conversation-drop-overlay']")).toBeNull();
    await view.unmount();
  });

  it("ignores a file transfer with no files", async () => {
    const onImageDrop = vi.fn();
    const view = await render(
      <I18nextProvider i18n={initLodyI18n()}>
        <ChatLandingView
          tone="light"
          title="Start a session"
          promptValue=""
          onPromptChange={() => undefined}
          onImageDrop={onImageDrop}
        />
      </I18nextProvider>,
    );

    await act(async () => {
      landingHeading(view.container).dispatchEvent(fileDragEvent("drop", []));
    });
    expect(onImageDrop).not.toHaveBeenCalled();
    await view.unmount();
  });
});

describe("seam patch 26 is registered", () => {
  it("names the file and the two-zone composition", () => {
    const patches = readFileSync(join(repoRoot, "vendor/lody/BLITZ-PATCHES.md"), "utf8");
    const source = readFileSync(
      join(
        repoRoot,
        "vendor/lody/packages/components/src/components/chat/chat-landing-view.tsx",
      ),
      "utf8",
    );
    expect(patches).toContain("### 26. The chat landing accepts page-wide file drops");
    expect(patches).toContain("components/chat/chat-landing-view.tsx");
    expect(source).toContain("const imageDropZone = useDropZone({");
    expect(source).toContain("enabled: pageDropEnabled && onImageDrop !== undefined,");
    expect(source).toContain("accepts: hasFileTransfer,");
    expect(source).toContain("const files = getFilesFromDataTransfer(dataTransfer);");
    expect(source).toContain("mergeDropZoneHandlers(imageDropZone, dropZone)");
    expect(source).toContain("dropHandlers={pageDropHandlers}");
  });
});
