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
 * WHAT NEEDS EYES. That a disabled Side Chat entry looks disabled, and that it
 * becomes enabled the moment the first assistant turn lands. The second is the
 * one worth watching for: it depends on `useImperativeHandle` re-attaching when
 * `lastCompletedAssistantMessageId` changes, which is React's behaviour and not
 * something jsdom can be asked about without the whole page.
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

  it("ignores the detach, which is the whole of the loop safety", () => {
    // Every render hands each surface a fresh ref arrow, so React calls it with
    // `null` and then with the handle inside one commit. Taking the `null` would
    // queue a state change on every commit for ever; taking only the attach
    // settles on a value React can bail out on.
    expect(detail).toContain(
      "if (ref === null || tabId !== activeTabSessionIdForForkRef.current) return;",
    );
    // And the callback keeps its empty dependency list: the active tab arrives
    // through a ref precisely so `setChatTabRef`'s identity does not change on
    // every tab switch and re-attach every surface.
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
