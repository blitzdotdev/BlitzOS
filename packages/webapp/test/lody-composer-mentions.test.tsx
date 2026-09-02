/**
 * SEAM PATCH 11, PINNED: the composer's mention chips answer the pointer, and
 * the `@` file drill-down stays inside Files
 * (`vendor/lody/BLITZ-PATCHES.md` §11; canary QA BUG-CA-05, BUG-CA-06).
 *
 * BUG-CA-05. The QA lane read `elementFromPoint` over a committed `@README.md `
 * chip, found the `z-10` textarea on top of the highlight mirror, and reported
 * the pointer as blocked. It is not: `MentionInput`'s own `onClick` hit-tests
 * the click point against the mirror's rects and calls `onMentionClick`. What
 * was missing is that NOTHING happened to the range, so the gesture had no
 * outcome for any kind except `pasted_text`. A hit now selects the range — the
 * state the chip mirror already knows how to paint — and a click anywhere else
 * still just moves the caret.
 *
 * BUG-CA-06. Descending into a directory writes a bare path (`@.github/`),
 * which carries no `<namespace>:` prefix, so the menu fell back to the
 * AGGREGATE level and answered a directory listing across every source —
 * `/design-sync` and `/update-config` among the four real entries. ArrowLeft
 * then closed the whole menu, because only a `<namespace>:` prefix could be
 * popped and the key fell through to a caret move that put a `/` after the
 * caret.
 *
 * WHAT IS DRIVEN AND WHAT IS PINNED AT THE SOURCE. The primitive is mountable
 * on its own, so the real vendored `Mention` + `MentionInput` are rendered here
 * and given real clicks and real keys; the level selector is pure, so the real
 * `selectMentionMenuView` is called over real categories. Only the menu's own
 * Back button is pinned at the source: `MentionTwoLevelMenu` needs jotai,
 * PostHog, i18next and floating-ui to render one control, and what has to hold
 * is that it goes up by the SAME helper ArrowLeft uses.
 */
import { act, useState } from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Mention, MentionInput } from "@lody/components/ui/mention";
import { getMentionDrillDownParent } from "@lody/components/ui/mention/mention-trigger";
import {
  isMentionPathSearch,
  selectMentionMenuView,
  toFileCandidate,
} from "@lody/components/components/mentions/mention-registry";
import { installLodyDomStubs } from "./lody-dom-stubs.js";
import { render } from "./dom.js";

installLodyDomStubs();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

// `@lody/*` are shorthand ambient modules on this side (`src/lody/vendor-modules.d.ts`),
// so nothing crosses the seam as a type. What this suite needs of their shapes
// it states itself — the same rule `lody-attachment-guard.test.tsx` follows.
type Candidate = {
  value: string;
  label: string;
  insertText: string;
  navigateText?: string;
  kind: string;
  icon: string;
  title: string;
};
type Category = {
  id: string;
  namespace: string;
  directTrigger?: string;
  label: string;
  icon: string;
  status: string;
  ownsBareSearch?: (search: string) => boolean;
  getCandidates: (term: string, limit?: number) => Candidate[];
};
type MentionRange = { start: number; end: number; value: string; kind?: string };
type MenuView = {
  level: string;
  term?: string;
  category?: Category;
  candidates?: Candidate[];
  groups?: { category: Category }[];
};

const selectView = (categories: Category[], search: string): MenuView =>
  selectMentionMenuView(categories, search) as MenuView;

// ===========================================================================
// BUG-CA-06, half one: a directory drill-down lists files and nothing else
// ===========================================================================

/** The four `.github` entries the lane saw, and the four commands it should not have. */
const DIRECTORY_ROWS = [
  ".github/workflows/canary.yml",
  ".github/workflows/release.yml",
  ".github/dependabot.yml",
  ".github/CODEOWNERS",
];
const COMMAND_ROWS = ["design-sync", "cloudflare-email-service", "update-config", "turnstile-spin"];

function fileCategory(calls: string[]): Category {
  return {
    id: "file",
    namespace: "file",
    label: "Files",
    icon: "file",
    status: "ready",
    ownsBareSearch: isMentionPathSearch,
    getCandidates: (term: string) => {
      calls.push(term);
      return DIRECTORY_ROWS.filter((path) => path.startsWith(term)).map((path) =>
        toFileCandidate({ kind: "file", path, token: path, searchable: path }),
      );
    },
  };
}

/** Ranks like the real slash-command source: a subsequence match, which is how
 * `/design-sync` answered a query for `.github/` in the first place. */
function commandCategory(calls: string[]): Category {
  return {
    id: "command",
    namespace: "cmd",
    directTrigger: "/",
    label: "Commands",
    icon: "command",
    status: "ready",
    getCandidates: (term: string) => {
      calls.push(term);
      return COMMAND_ROWS.filter((name) => isSubsequence(term, name)).map(
        (name): Candidate => ({
          value: name,
          label: name,
          insertText: `/${name}`,
          kind: "command",
          icon: "command",
          title: `/${name}`,
        }),
      );
    },
  };
}

function isSubsequence(term: string, name: string): boolean {
  let cursor = 0;
  for (const character of term.toLowerCase()) {
    cursor = name.toLowerCase().indexOf(character, cursor) + 1;
    if (cursor === 0) return false;
  }
  return true;
}

describe("BUG-CA-06: a directory drill-down lists only files and directories", () => {
  it("scopes a bare path to the file category, and never asks the others", () => {
    const fileCalls: string[] = [];
    const commandCalls: string[] = [];
    const view = selectView([fileCategory(fileCalls), commandCategory(commandCalls)], ".github/");

    expect(view.level, "a path is a drill-down, not an aggregate query").toBe("category");
    if (view.level !== "category") throw new Error("expected the category level");
    expect(view.category?.id).toBe("file");
    expect(view.term).toBe(".github/");
    expect((view.candidates ?? []).map((candidate) => candidate.value)).toEqual(DIRECTORY_ROWS);
    // The lazy-source contract: a query scoped to one category must not pay for
    // the others, and here it is also what keeps `/update-config` out.
    expect(commandCalls, "the command source was not asked").toEqual([]);
    expect(fileCalls).toEqual([".github/"]);
  });

  it("keeps scoping while the user types INSIDE that directory", () => {
    // The defect is one keystroke wide otherwise: `.github/work` carries no
    // trailing slash but is still a path.
    const view = selectView([fileCategory([]), commandCategory([])], ".github/work");
    expect(view.level).toBe("category");
    if (view.level !== "category") throw new Error("expected the category level");
    expect(view.category?.id).toBe("file");
  });

  it("still aggregates a search that is not a path", () => {
    const commandCalls: string[] = [];
    const view = selectView([fileCategory([]), commandCategory(commandCalls)], "design");

    expect(view.level).toBe("aggregate");
    if (view.level !== "aggregate") throw new Error("expected the aggregate level");
    expect((view.groups ?? []).map((group) => group.category.id)).toEqual(["command"]);
    expect(commandCalls).toEqual(["design"]);
  });

  it("still answers a bare trigger with the category index", () => {
    const view = selectView([fileCategory([]), commandCategory([])], "");
    expect(view.level).toBe("categories");
  });

  it("still lets a `<namespace>:` prefix win over the path rule", () => {
    // `@cmd:a/b` is an explicit scope. The namespace parse runs first, so the
    // claim never overrides what the user asked for by name.
    const view = selectView([fileCategory([]), commandCategory([])], "cmd:a/b");
    expect(view.level).toBe("category");
    if (view.level !== "category") throw new Error("expected the category level");
    expect(view.category?.id).toBe("command");
  });
});

// ===========================================================================
// BUG-CA-06, half two: ArrowLeft goes up one level
// ===========================================================================

describe("BUG-CA-06: one level up is one rule", () => {
  it("answers the parent of every drill-down shape", () => {
    expect(getMentionDrillDownParent("file:")).toBe("");
    expect(getMentionDrillDownParent(".github/")).toBe("");
    expect(getMentionDrillDownParent("src/components/")).toBe("src/");
    expect(getMentionDrillDownParent("file:src/components/")).toBe("file:src/");
    expect(getMentionDrillDownParent("file:src/")).toBe("file:");
  });

  it("answers null where there is no level above, so the key stays a caret move", () => {
    // Mid-segment typing, a plain term, and an empty search are all positions a
    // user is still IN, not levels to leave.
    expect(getMentionDrillDownParent("src/comp")).toBeNull();
    expect(getMentionDrillDownParent("readme")).toBeNull();
    expect(getMentionDrillDownParent("")).toBeNull();
    expect(getMentionDrillDownParent("file:foo")).toBeNull();
  });
});

type Harness = {
  textarea: HTMLTextAreaElement;
  value: () => string;
  unmount: () => Promise<void>;
};

function PrimitiveHarness({
  initialValue,
  initialMentions = [],
  chips = false,
  onMentionClick,
  report,
}: {
  initialValue: string;
  initialMentions?: MentionRange[];
  chips?: boolean;
  onMentionClick?: (mention: MentionRange) => void;
  report: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [mentions, setMentions] = useState<MentionRange[]>(initialMentions);
  report(value);
  return (
    <Mention
      defaultOpen
      inputValue={value}
      onInputValueChange={(next: string) => {
        report(next);
        setValue(next);
      }}
      mentions={mentions}
      onMentionsChange={setMentions}
      onFilter={(options: unknown) => options}
      autoCloseOnEmpty={false}
      {...(chips ? { getMentionChip: () => ({ iconSlots: 1 }) } : {})}
      {...(onMentionClick ? { onMentionClick } : {})}
    >
      <MentionInput value={value} onChange={() => undefined} />
    </Mention>
  );
}

async function mountPrimitive(props: {
  initialValue: string;
  initialMentions?: MentionRange[];
  chips?: boolean;
  onMentionClick?: (mention: MentionRange) => void;
}): Promise<Harness> {
  let latest = props.initialValue;
  const view = await render(<PrimitiveHarness {...props} report={(next) => (latest = next)} />);
  const textarea = view.container.querySelector("textarea");
  if (!textarea) throw new Error("the primitive rendered no textarea");
  textarea.value = props.initialValue;
  textarea.setSelectionRange(props.initialValue.length, props.initialValue.length);
  return { textarea, value: () => latest, unmount: view.unmount };
}

function pressKey(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

describe("BUG-CA-06: ArrowLeft walks the drill-down back, one level per press", () => {
  it("pops a directory to its parent, then to the bare trigger", async () => {
    const harness = await mountPrimitive({ initialValue: "@src/components/" });

    const first = pressKey(harness.textarea, "ArrowLeft");
    expect(first.defaultPrevented, "the key was handled, not left to the caret").toBe(true);
    expect(harness.value()).toBe("@src/");

    // The controlled value has moved; the DOM catches up through the pending
    // selection effect, which this test does not need to wait for.
    harness.textarea.value = "@src/";
    harness.textarea.setSelectionRange(5, 5);

    const second = pressKey(harness.textarea, "ArrowLeft");
    expect(second.defaultPrevented).toBe(true);
    expect(harness.value()).toBe("@");

    await harness.unmount();
  });

  it("leaves ArrowLeft alone mid-segment", async () => {
    const harness = await mountPrimitive({ initialValue: "@src/comp" });
    const event = pressKey(harness.textarea, "ArrowLeft");
    expect(event.defaultPrevented, "the user is still typing this segment").toBe(false);
    expect(harness.value()).toBe("@src/comp");
    await harness.unmount();
  });

  it("still pops a `<namespace>:` prefix in one press", async () => {
    const harness = await mountPrimitive({ initialValue: "@issue:" });
    const event = pressKey(harness.textarea, "ArrowLeft");
    expect(event.defaultPrevented).toBe(true);
    expect(harness.value()).toBe("@");
    await harness.unmount();
  });

  it("leaves Backspace alone inside a path, exactly as upstream states", async () => {
    // The invariant this patch does NOT change (`ui/mention/AGENTS.md`): inside
    // a path Backspace still deletes one character at a time.
    const harness = await mountPrimitive({ initialValue: "@src/" });
    const event = pressKey(harness.textarea, "Backspace");
    expect(event.defaultPrevented).toBe(false);
    expect(harness.value()).toBe("@src/");
    await harness.unmount();
  });
});

describe("BUG-CA-06: the menu's Back control goes up by the same rule", () => {
  const menu = read(
    "vendor/lody/packages/components/src/components/mentions/mention-two-level-menu.tsx",
  );

  it("pops one level through the shared helper, not straight to the trigger", () => {
    expect(menu).toContain("import { getMentionDrillDownParent } from '@/ui/mention/mention-trigger'");
    expect(menu).toContain("onNavigateBack(getMentionDrillDownParent(search) ?? '')");
  });
});

// ===========================================================================
// BUG-CA-05: a chip answers the click that lands on it
// ===========================================================================

/** jsdom lays nothing out, so the chip's box is stated here. The hit test reads
 * `getClientRects()` and nothing else, which is exactly what a browser gives it. */
function placeChip(container: HTMLElement, box: { left: number; right: number }): void {
  const spans = container.querySelectorAll<HTMLElement>("[data-mention-start]");
  expect(spans.length, "the highlight mirror painted the range").toBeGreaterThan(0);
  for (const span of spans) {
    Object.defineProperty(span, "getClientRects", {
      configurable: true,
      value: () => [{ left: box.left, right: box.right, top: 10, bottom: 30 }],
    });
  }
}

function clickAt(textarea: HTMLTextAreaElement, caret: number, clientX: number): void {
  textarea.setSelectionRange(caret, caret);
  act(() => {
    textarea.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY: 20 }),
    );
  });
}

const README: MentionRange = { start: 0, end: 10, value: "README.md", kind: "file" };

describe("BUG-CA-05: a committed chip answers a click that lands on it", () => {
  it("selects the whole range, and reports the mention", async () => {
    const clicked: MentionRange[] = [];
    const harness = await mountPrimitive({
      initialValue: "@README.md ",
      initialMentions: [README],
      chips: true,
      onMentionClick: (mention) => clicked.push(mention),
    });
    placeChip(harness.textarea.parentElement as HTMLElement, { left: 10, right: 100 });

    clickAt(harness.textarea, 5, 50);

    expect(
      [harness.textarea.selectionStart, harness.textarea.selectionEnd],
      "the chip is selected, which is the state the mirror already paints",
    ).toEqual([0, 10]);
    expect(clicked).toEqual([README]);
    await harness.unmount();
  });

  it("selects it even for a composer that registers no handler", async () => {
    // The old code returned before the hit test whenever `onMentionClick` was
    // absent, so the gesture depended on a caller having an action for the kind.
    const harness = await mountPrimitive({
      initialValue: "@README.md ",
      initialMentions: [README],
      chips: true,
    });
    placeChip(harness.textarea.parentElement as HTMLElement, { left: 10, right: 100 });

    clickAt(harness.textarea, 5, 50);

    expect([harness.textarea.selectionStart, harness.textarea.selectionEnd]).toEqual([0, 10]);
    await harness.unmount();
  });

  it("leaves a click outside the chip exactly where it was", async () => {
    // The whole safety claim: typing clicks still land on the textarea and move
    // the caret, because the range is only touched on a real rect hit.
    const clicked: MentionRange[] = [];
    const harness = await mountPrimitive({
      initialValue: "@README.md ",
      initialMentions: [README],
      chips: true,
      onMentionClick: (mention) => clicked.push(mention),
    });
    placeChip(harness.textarea.parentElement as HTMLElement, { left: 10, right: 100 });

    clickAt(harness.textarea, 10, 400);

    expect([harness.textarea.selectionStart, harness.textarea.selectionEnd]).toEqual([10, 10]);
    expect(clicked).toEqual([]);
    await harness.unmount();
  });

  it("leaves a drag-selection alone", async () => {
    const harness = await mountPrimitive({
      initialValue: "@README.md ",
      initialMentions: [README],
      chips: true,
    });
    placeChip(harness.textarea.parentElement as HTMLElement, { left: 10, right: 100 });

    harness.textarea.setSelectionRange(3, 7);
    act(() => {
      harness.textarea.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }),
      );
    });

    expect([harness.textarea.selectionStart, harness.textarea.selectionEnd]).toEqual([3, 7]);
    await harness.unmount();
  });
});

// ===========================================================================
// The seam is declared where a merge agent reads it
// ===========================================================================

describe("seam patch 11 is declared in BLITZ-PATCHES.md", () => {
  const patches = read("vendor/lody/BLITZ-PATCHES.md");

  it("names the section and both rows", () => {
    expect(patches).toContain("### 11. The composer's mention chips and the file drill-down");
    expect(patches).toContain("BUG-CA-05");
    expect(patches).toContain("BUG-CA-06");
  });

  it("names every vendored file the seam touches", () => {
    for (const file of [
      "ui/mention/mention-trigger.ts",
      "ui/mention/mention-root.tsx",
      "ui/mention/mention-input.tsx",
      "components/mentions/mention-registry.ts",
      "components/mentions/mention-two-level-menu.tsx",
    ]) {
      expect(patches, `seam patch 11 declares ${file}`).toContain(file);
    }
  });
});
