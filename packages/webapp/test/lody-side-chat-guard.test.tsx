/**
 * SEAM PATCH 6, PINNED: Side Chat is offered only when there is something to
 * fork (wave 4, C2).
 *
 * The field report: in a session the agent has not answered yet, the Side Chat
 * entry in the side panel accepts a click and nothing happens. The mechanism is
 * a fork with no source — `handleCreateSideSession` → `forkActiveConversation`
 * reads `getLastAssistantTurnId()` and returns after a `toast.error` when it is
 * null — and with no `<Toaster/>` mounted (C1) that error was swallowed, so the
 * entry read as dead rather than as refused.
 *
 * C1 puts the message on screen. This makes the entry say so BEFORE the click,
 * with the `disabled` state the same launcher already takes for an offline
 * machine — one affordance for "there is nothing to launch", not two.
 *
 * WHAT IS PINNED HERE AND WHY IT IS SOURCE AND NOT A RENDER. `SessionDetail`
 * needs a runtime, a Loro document and a daemon; every suite that mounts it
 * skips wherever the daemon is not installed, which is CI. So the same rule
 * `lody-surface-tabs.test.tsx` applies to its hunk 15 applies to all of this:
 * the patch's INERTNESS is pinned at the source by that file's baseline
 * subsequence check, and its PARTS are named here — the prop on the vendored
 * side, the call on ours, and the three mechanisms a merge could quietly drop.
 *
 * WHAT THIS SOURCE PIN CANNOT PROVE. It cannot run React's ref commit cycle
 * without the whole page. It proves that all four sites use the callback cache
 * and that `useImperativeHandle` still depends on the latest assistant turn.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const sessionsDir = join(
  repoRoot,
  "vendor/lody/packages/components/src/components/sessions",
);

const detail = readFileSync(join(sessionsDir, "session-detail.tsx"), "utf8");
const panelBar = readFileSync(join(sessionsDir, "session-side-panel-tab-bar.tsx"), "utf8");
const chatInterface = readFileSync(join(sessionsDir, "session-chat-interface.tsx"), "utf8");
const router = readFileSync(join(repoRoot, "packages/webapp/src/lody/router.tsx"), "utf8");

describe("the Side Chat launcher knows there is nothing to fork", () => {
  it("declares one opt-in prop, and our page is the caller that turns it on", () => {
    expect(detail, "the vendored side declares it").toContain(
      "sideChatRequiresAssistantTurn?: boolean;",
    );
    expect(detail, "and defaults it to upstream's behaviour").toContain(
      "sideChatRequiresAssistantTurn = false,",
    );
    // A declared prop that nothing passes is the shape of the defect it fixes:
    // the launcher stays enabled and the click still answers with a toast.
    expect(router, "our SessionDetail mount asks for the guard").toContain(
      "sideChatRequiresAssistantTurn",
    );
  });

  it("adds a THIRD reason to the disabled state the launcher already had", () => {
    // Not a fourth affordance: `getSideChatLauncherState` already returns
    // `'disabled'` for an offline machine and the option already carries
    // `pending`. This joins that expression rather than hiding the entry, which
    // would make a session that has not answered yet look like one where Side
    // Chat does not exist.
    expect(detail).toContain(
      "(sideChatRequiresAssistantTurn && activeTabAssistantTurnId === null)",
    );
    expect(panelBar, "and the disabled affordance is theirs").toContain(
      "disabled:cursor-not-allowed disabled:opacity-45",
    );
    expect(panelBar).toContain("disabled={panel.disabled}");
  });

  it("mirrors the fork target out of the ref, because a ref cannot disable a button", () => {
    // `chatRefsMap` answers only when asked, which is right for a click and
    // useless for a rendered state. The mirror is what makes the launcher
    // reactive, and the imperative handle is what makes the mirror current.
    expect(detail).toContain(
      "const [activeTabAssistantTurnId, setActiveTabAssistantTurnId] = useState<string | null>(null);",
    );
    expect(detail).toContain(
      "'getLastAssistantTurnId' in ref ? ref.getLastAssistantTurnId() : null",
    );
    expect(chatInterface, "the handle upstream re-attaches on a new turn").toContain(
      "getLastAssistantTurnId: () => lastCompletedAssistantMessageId,",
    );
    expect(chatInterface).toContain("[handleCopyConversationHistory, lastCompletedAssistantMessageId, openSearch]");
  });

  it("keeps one ref callback per tab id at all four chat surfaces", () => {
    expect(detail.includes("const chatRefCallbacksMap = useRef<")).toBe(true);
    expect(detail.includes("const getChatTabRef = useCallback(")).toBe(true);
    expect(detail).toContain("chatRefCallbacksMap.current.get(tabId)");
    expect(detail).toContain("if (existing) return existing;");
    expect(detail).toContain("chatRefCallbacksMap.current.set(tabId, callback)");
    expect(detail).toContain("return callback;");
    const cachedRefSites = detail.match(/(?:ref=\{|ref: )getChatTabRef\(/gu) ?? [];
    expect(cachedRefSites).toHaveLength(4);
    expect(detail).not.toContain("ref={(el) => setChatTabRef(");
    expect(detail).not.toContain(
      "ref: (element: SessionChatInterfaceHandle | null) => setChatTabRef(",
    );

    // A real handle update can detach before it re-attaches. The guard keeps
    // that valid update from briefly clearing the rendered assistant turn.
    expect(detail).toContain(
      "if (ref === null || tabId !== activeTabSessionIdForForkRef.current) return;",
    );
    const setter = /const setChatTabRef = useCallback\(([\s\S]*?)\n  \);/u.exec(detail)?.[1] ?? "";
    expect(setter, "setChatTabRef is still one callback").not.toBe("");
    expect(setter.trimEnd().endsWith("[]")).toBe(true);
  });

  it("leaves the fork itself exactly as upstream wrote it", () => {
    // The guard is about the OFFER. What a click does — including the error for
    // the case the guard now prevents — is untouched, so a host that does not
    // opt in behaves as it always did.
    expect(detail).toContain(
      "toast.error(t('sessions.forkNoAssistant', 'No assistant response is available to fork'));",
    );
    expect(detail).toContain("void handleForkAssistant(sourceSession, turnId, placement);");
    expect(detail).toContain("() => forkActiveConversation('side-panel'),");
  });
});
