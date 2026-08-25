import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatTurnView } from "../src/chat/chat-turn-views.js";
import type { ChatTurn } from "../src/chat/chat-turns.js";
import { render } from "./dom.js";

const EMPTY_ACTIVITY = {
  commands: 0,
  exploredFiles: 0,
  searches: 0,
  editedFiles: 0,
  editOperations: 0,
  subagents: 0,
  otherTools: 0,
  failedTools: 0,
};

describe("chat workspace-file links", () => {
  it("opens safe workspace links through the file-tab callback", async () => {
    const onOpenFile = vi.fn();
    const assistant = {
      id: 2,
      kind: "assistant" as const,
      blocks: [{
        type: "text",
        text: [
          "[absolute](/workspace/src/app.ts)",
          "[relative](docs/guide.md)",
          "[outside](/etc/passwd)",
          "[external](https://example.com/readme.md)",
        ].join(" "),
      }],
      inFlight: false,
    };
    const turn: ChatTurn = {
      id: 1,
      prompt: { id: 1, kind: "user", text: "Show files" },
      items: [assistant, { id: 3, kind: "result", meta: { success: true } }],
      status: "complete",
      finalAssistantId: assistant.id,
      result: { id: 3, kind: "result", meta: { success: true } },
      activity: EMPTY_ACTIVITY,
    };
    const view = await render(
      <ChatTurnView
        turn={turn}
        toolResults={{}}
        showThinking
        onOpenFile={onOpenFile}
        workingDirectory="/workspace"
      />,
    );

    const links = [...view.container.querySelectorAll<HTMLAnchorElement>("a")];
    await act(async () => links.find(({ textContent }) => textContent === "absolute")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    await act(async () => links.find(({ textContent }) => textContent === "relative")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

    expect(onOpenFile.mock.calls).toEqual([["src/app.ts"], ["docs/guide.md"]]);
    expect(links.find(({ textContent }) => textContent === "outside")?.target).toBe("_blank");
    expect(links.find(({ textContent }) => textContent === "external")?.target).toBe("_blank");

    await view.unmount();
  });
});
