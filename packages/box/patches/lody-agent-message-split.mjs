#!/usr/bin/env node
// Stops one assistant message from being stored as two text blocks with a tool
// card wedged between them, in the PUBLISHED `lody` npm bundle.
//
// WHY THIS EXISTS. A real transcript from a canary box, three consecutive items
// of ONE assistant entry:
//
//   [21] text       "Three"
//   [22] tool_call  toolu_0166kpDv… (grep …)
//   [23] text       " characterization agents are running in parallel, plus the
//                    full suite on step 1."
//
// Item 23 begins with a space because it is the SAME Anthropic message as item
// 21, cut in half. Measured on this box: 13 of 271 stored assistant text blocks
// (~5%) start that way.
//
// The daemon already knows which message a delta belongs to. `claude-acp.js`
// computes `messageIdForGrouping(message)` — the Anthropic assistant message
// `id`, falling back to `message.uuid` — and `applyMessageId(update, messageId)`
// stamps it on every `agent_message_chunk` / `agent_thought_chunk` /
// `user_message_chunk`. The streaming path uses the same value
// (`currentStreamMessageId`, read from the `message_start` event), so every
// delta of one API message carries one id. The ACP schema keeps it:
// `zContentChunk = withMeta({ content: zContentBlock, messageId: z.string().nullish() })`.
// It is emitted explicitly FOR GROUPING.
//
// The history applier throws it away. `buildMessageContentFromNotification`
// maps the chunk to `{ type: "text", text }` and drops the id, and both copies
// of `appendOrMergeAdjacentText` merge a delta only into `items[items.length - 1]`.
// So ANY item appended between two deltas of one message — a tool_call, a
// subagent_task, an image — ends that text block permanently, and the rest of
// the sentence lands in a new one.
//
// WHAT THE PATCH DOES, in six hunks that are one idea:
//
//   1. one shared helper, `blitzTextMergeTargetIndex`, beside
//      `compactAdjacentTextAndThought`;
//   2. `buildMessageContentFromNotification` carries `update.messageId` onto the
//      `text` and `thought` items it emits;
//   3.+5. the two `case "text"` / `case "thought"` arms (the class applier and
//      the batch applier) forward `message.messageId` to the merge;
//   4.+6. both `appendOrMergeAdjacentText` copies ask the helper WHERE to merge
//      instead of assuming the last slot, and stamp the id on what they write.
//
// The helper scans back past trailing NON-text items and stops at the first
// text-or-thought item it meets. That item decides: same kind and same id, merge
// there; anything else, push a new block. The scan is O(1) amortized — once a
// new block exists it is the last item again.
//
// THE DISCRIMINATOR IS THE ID AND NOTHING ELSE. No text heuristic: "starts with
// a space", "starts lowercase" and friends all corrupt legitimate content, and a
// legitimate `text → tool → text` across TWO messages carries two different ids
// and must still render as two blocks. It does.
//
// BACKWARD COMPATIBLE IN BOTH DIRECTIONS. With no id on the incoming delta
// (every non-Claude adapter, and `applyMessageContentsBatch`'s materialized rich
// content) the helper returns exactly today's answer: the last slot if it is of
// the right kind, otherwise a new block. With an id on the delta but NO id on
// the stored item — history written by a pre-patch daemon, or a text block that
// `postProcessTouchedAssistantEntries` re-parsed out of `<thinking>` tags — it
// also returns today's answer, so an untagged item can never be split by this
// change. It gains the id when it is merged into, and groups normally after that.
//
// The extra field is safe to persist: `LoroSessionDoc.updateHistory` writes the
// items straight into the Loro mirror with no schema in the way, and every zod
// object that reads history back is a stripping `z.object`, not `.strict()`.
// The conditional spread means an id-less chunk still produces the byte-identical
// `{ type, text }` object it produces today — nothing writes `messageId: undefined`.
//
// SCOPE. Strictly a MERGE-TARGET change. No item is dropped, no item is
// reordered, no item type other than `text`/`thought` is touched. The one
// behaviour that narrows is two ADJACENT stored text items that both carry ids
// and disagree: they stay two blocks where today they would fuse. That is the
// same rule this patch exists to enforce, and it is the rare shape — two API
// messages with nothing at all between them.
//
// WHY THE GUARD IS NOT A WHOLE-FILE SHA. Four patches now run over the same
// artifact, and a file hash can only pin whichever runs first — a later one
// would have to hash its siblings' output and would break whenever any of them
// changed. So this one pins the two things that are actually load-bearing: the
// installed package's VERSION, and each anchor's exact text at exactly one
// occurrence. A refactor that moves any of the six fails here with a count of 0.
//
// Recorded in vendor/lody/BLITZ-PATCHES.md. Usage:
//   node lody-agent-message-split.mjs <path to lody/dist/index.js>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const EXPECTED_VERSION = "0.88.1";
const EXPECTED_OCCURRENCES = 1;

/** The marker the idempotency check looks for. It is the shared helper's name,
 * which appears nowhere in the published bundle. */
const MARKER = "blitzTextMergeTargetIndex";

/** Emitted once, immediately above `compactAdjacentTextAndThought`, which is a
 * top-level `const` in the same bundle scope as BOTH appliers and is defined
 * before either of them runs.
 *
 * These two are a TRANSCRIPTION of `findStreamedTextMergeIndex` and
 * `mergeStreamedTextItem` from the upstream fix (blitzdotdev/Lody
 * `fix/acp-text-block-split-by-tool-call`, `packages/shared/src/acp/history-apply.ts`).
 * Keep them byte-equivalent in BEHAVIOUR: this patch only exists until a daemon
 * release carries that fix, and a box must not answer differently from the
 * renderer beside it (CLAUDE.md: copy Lody's behaviour rather than reconcile).
 *
 * Adjacency still wins first, so a delta landing right after its own block
 * merges exactly as it does today, whatever the ids say. What `messageId` adds
 * is REACH: when the last item is not text, the first text/thought item from
 * the end decides -- same kind and same id merges there, past any tool_call in
 * between; anything else starts a new block. A merge never invents an id, and a
 * block that ends up holding two messages drops the id it can no longer claim. */
const HELPER = `  const blitzTextMergeTargetIndex = (items2, kind, messageId) => {
    const lastIndex = items2.length - 1;
    const last2 = items2[lastIndex];
    if (last2 && last2.type === kind) return lastIndex;
    if (typeof messageId !== "string" || messageId.length === 0) return -1;
    for (let i2 = lastIndex; i2 >= 0; i2--) {
      const item = items2[i2];
      if (!item || item.type !== "text" && item.type !== "thought") continue;
      return item.type === kind && item.messageId === messageId ? i2 : -1;
    }
    return -1;
  };
  const blitzMergedTextItem = (existing, text, messageId) => {
    if (existing.messageId !== void 0 && messageId !== void 0 && existing.messageId !== messageId) {
      const { messageId: spansTwoMessages, ...rest } = existing;
      return { ...rest, text };
    }
    return { ...existing, text };
  };
`;

/** `messageId` is written only when the delta carried one, so an id-less delta
 * still yields the byte-identical `{ type, text }` object it yields today.
 * Takes the indent of the site so the emitted bundle stays readable. */
const idSpread = (indent) =>
  `...typeof messageId === "string" && messageId.length > 0 ? {\n` +
  `${indent}  messageId\n` +
  `${indent}} : {}`;

const hunks = [
  {
    name: "the shared merge-target helper",
    what: "compactAdjacentTextAndThought's definition",
    find: `  const compactAdjacentTextAndThought = (items2) => {`,
    replace: `${HELPER}  const compactAdjacentTextAndThought = (items2) => {`,
  },
  {
    name: "carry messageId out of the notification",
    what: "buildMessageContentFromNotification's two chunk arms",
    find: `      case "agent_message_chunk":
        switch (update2.content.type) {
          case "text":
            return [
              {
                type: "text",
                text: update2.content.text
              }
            ];
          case "image":
          case "audio":
          case "resource_link":
          case "resource":
            return [];
        }
      case "agent_thought_chunk":
        switch (update2.content.type) {
          case "text":
            return [
              {
                type: "thought",
                text: update2.content.text
              }
            ];
          case "image":
          case "audio":
          case "resource_link":
          case "resource":
            return [];
        }`,
    replace: `      case "agent_message_chunk":
        switch (update2.content.type) {
          case "text":
            return [
              {
                type: "text",
                text: update2.content.text,
                ...typeof update2.messageId === "string" && update2.messageId.length > 0 ? {
                  messageId: update2.messageId
                } : {}
              }
            ];
          case "image":
          case "audio":
          case "resource_link":
          case "resource":
            return [];
        }
      case "agent_thought_chunk":
        switch (update2.content.type) {
          case "text":
            return [
              {
                type: "thought",
                text: update2.content.text,
                ...typeof update2.messageId === "string" && update2.messageId.length > 0 ? {
                  messageId: update2.messageId
                } : {}
              }
            ];
          case "image":
          case "audio":
          case "resource_link":
          case "resource":
            return [];
        }`,
  },
  {
    name: "forward the id (streaming applier)",
    what: "NotificationOnHistoryApplier.applyMessageContent's text/thought arms",
    find: `    applyMessageContent(message) {
      switch (message.type) {
        case "text": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) return;
          const entryIndex = this.ensureActiveAssistantEntry();
          this.appendOrMergeAdjacentText(entryIndex, "text", text);
          return;
        }
        case "thought": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) return;
          const entryIndex = this.ensureActiveAssistantEntry();
          this.appendOrMergeAdjacentText(entryIndex, "thought", text);
          return;
        }`,
    replace: `    applyMessageContent(message) {
      switch (message.type) {
        case "text": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) return;
          const entryIndex = this.ensureActiveAssistantEntry();
          this.appendOrMergeAdjacentText(entryIndex, "text", text, message.messageId);
          return;
        }
        case "thought": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) return;
          const entryIndex = this.ensureActiveAssistantEntry();
          this.appendOrMergeAdjacentText(entryIndex, "thought", text, message.messageId);
          return;
        }`,
  },
  {
    name: "merge by id (streaming applier)",
    what: "NotificationOnHistoryApplier.appendOrMergeAdjacentText",
    find: `    appendOrMergeAdjacentText(entryIndex, kind, delta) {
      if (!delta) return;
      const items2 = this.ensureEntryItems(entryIndex);
      const last2 = items2[items2.length - 1];
      if (last2 && last2.type === kind) {
        const existing = last2;
        const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
        if (!text) {
          items2.pop();
          this.touchedAssistantEntryIndices.add(entryIndex);
          this.changed = true;
          return;
        }
        items2[items2.length - 1] = {
          ...existing,
          text
        };
        this.touchedAssistantEntryIndices.add(entryIndex);
        this.changed = true;
        return;
      }
      items2.push({
        type: kind,
        text: delta
      });
      this.touchedAssistantEntryIndices.add(entryIndex);
      this.changed = true;
    }`,
    replace: `    appendOrMergeAdjacentText(entryIndex, kind, delta, messageId) {
      if (!delta) return;
      const items2 = this.ensureEntryItems(entryIndex);
      const targetIndex = blitzTextMergeTargetIndex(items2, kind, messageId);
      if (targetIndex >= 0) {
        const existing = items2[targetIndex];
        const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
        if (!text) {
          items2.splice(targetIndex, 1);
          this.touchedAssistantEntryIndices.add(entryIndex);
          this.changed = true;
          return;
        }
        items2[targetIndex] = blitzMergedTextItem(existing, text, messageId);
        this.touchedAssistantEntryIndices.add(entryIndex);
        this.changed = true;
        return;
      }
      items2.push({
        type: kind,
        text: delta,
        ${idSpread("        ")}
      });
      this.touchedAssistantEntryIndices.add(entryIndex);
      this.changed = true;
    }`,
  },
  {
    name: "forward the id (batch applier)",
    what: "applyMessageContentsBatch's message loop",
    find: `    for (const message of messages) {
      switch (message.type) {
        case "text": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) break;
          const entryIndex = ensureActiveAssistantEntry();
          appendOrMergeAdjacentText(entryIndex, "text", text);
          break;
        }
        case "thought": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) break;
          const entryIndex = ensureActiveAssistantEntry();
          appendOrMergeAdjacentText(entryIndex, "thought", text);
          break;
        }`,
    replace: `    for (const message of messages) {
      switch (message.type) {
        case "text": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) break;
          const entryIndex = ensureActiveAssistantEntry();
          appendOrMergeAdjacentText(entryIndex, "text", text, message.messageId);
          break;
        }
        case "thought": {
          const text = sanitizeLodyInternalInstructions(message.text);
          if (!text) break;
          const entryIndex = ensureActiveAssistantEntry();
          appendOrMergeAdjacentText(entryIndex, "thought", text, message.messageId);
          break;
        }`,
  },
  {
    name: "merge by id (batch applier)",
    what: "applyMessageContentsBatch's appendOrMergeAdjacentText",
    find: `    const appendOrMergeAdjacentText = (entryIndex, kind, delta) => {
      if (!delta) return;
      const state2 = entryStates[entryIndex];
      if (!state2) return;
      const last2 = state2.items[state2.items.length - 1];
      if (last2 && last2.type === kind) {
        const existing = last2;
        const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
        if (text) {
          state2.items[state2.items.length - 1] = {
            ...existing,
            text
          };
        } else {
          state2.items.pop();
        }
      } else {
        state2.items.push({
          type: kind,
          text: delta
        });
      }
      state2.dirty = true;
    };`,
    replace: `    const appendOrMergeAdjacentText = (entryIndex, kind, delta, messageId) => {
      if (!delta) return;
      const state2 = entryStates[entryIndex];
      if (!state2) return;
      const targetIndex = blitzTextMergeTargetIndex(state2.items, kind, messageId);
      if (targetIndex >= 0) {
        const existing = state2.items[targetIndex];
        const text = sanitizeLodyInternalInstructions(mergeStreamChunk(existing.text, delta));
        if (text) {
          state2.items[targetIndex] = blitzMergedTextItem(existing, text, messageId);
        } else {
          state2.items.splice(targetIndex, 1);
        }
      } else {
        state2.items.push({
          type: kind,
          text: delta,
          ${idSpread("          ")}
        });
      }
      state2.dirty = true;
    };`,
  },
];

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: lody-agent-message-split.mjs <path to lody/dist/index.js>");
  process.exit(2);
}

// `dist/index.js` -> the package root beside it. Read rather than assumed: the
// version is what a bump changes, and it is the first thing to check.
const manifestPath = join(dirname(dirname(target)), "package.json");
let version;
try {
  version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
} catch (cause) {
  console.error(`lody-agent-message-split: cannot read ${manifestPath}: ${String(cause)}`);
  process.exit(1);
}
if (version !== EXPECTED_VERSION) {
  console.error(
    `lody-agent-message-split: refusing to patch ${target}.\n` +
      `  expected lody@${EXPECTED_VERSION}, found lody@${String(version)}\n` +
      "  The pinned lody version moved. Re-check whether the history applier still\n" +
      "  drops `update.messageId` and still merges only into the LAST item — if a\n" +
      "  bump groups by message id upstream, DELETE this patch instead of updating it.",
  );
  process.exit(1);
}

let source = readFileSync(target, "utf8");
if (source.includes(MARKER)) {
  console.log(`lody-agent-message-split: ${target} is already patched.`);
  process.exit(0);
}

for (const hunk of hunks) {
  const occurrences = source.split(hunk.find).length - 1;
  if (occurrences !== EXPECTED_OCCURRENCES) {
    console.error(
      `lody-agent-message-split: expected ${EXPECTED_OCCURRENCES} occurrence of\n` +
        `  ${hunk.what} in ${target}, found ${occurrences}.\n` +
        `  Hunk "${hunk.name}" cannot be applied. The ACP history applier moved.\n` +
        "  Re-audit it before shipping a box: without this patch one assistant\n" +
        "  message is stored as two text blocks whenever a tool call lands between\n" +
        "  two of its deltas, which reads as a sentence cut in half.",
    );
    process.exit(1);
  }
  source = source.split(hunk.find).join(hunk.replace);
}

writeFileSync(target, source);
console.log(
  `lody-agent-message-split: grouped assistant text by messageId in ${target} ` +
    `(lody@${EXPECTED_VERSION}, ${hunks.length} hunks).`,
);
