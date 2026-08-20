import { describe, expect, it } from "vitest";
import { AGENT_RULES_DOC, contentVersion } from "../core/agent-rules.js";

// The box-image skeleton .md is the single source of truth for the rule bytes,
// and core/agent-rules.ts now imports it directly (a Text module in the Worker
// bundle, `?raw` here). This test is the guard that the wiring still reaches
// that file: a build that silently stopped inlining it, or started inlining a
// different file, fails here rather than shipping an empty rule doc to boxes.
const canonicalSources = import.meta.glob<string>(
  "../../box/rootfs/opt/blitz/skel/agent-rules.md",
  { eager: true, import: "default", query: "?raw" },
);

function canonicalDoc(): string {
  const entries = Object.values(canonicalSources);
  if (entries.length !== 1) {
    throw new Error(`expected one canonical agent-rules.md, found ${entries.length}`);
  }
  const [doc] = entries;
  if (doc === undefined) throw new Error("canonical agent-rules.md was not inlined");
  return doc;
}

describe("agent-rules canonical document", () => {
  it("serves the box-image skeleton .md byte for byte", () => {
    expect(AGENT_RULES_DOC).toBe(canonicalDoc());
    // A doc that arrived empty would still pass an equality check against an
    // equally empty read, so pin the shape too.
    expect(AGENT_RULES_DOC.startsWith("# Blitz box")).toBe(true);
    expect(AGENT_RULES_DOC.length).toBeGreaterThan(1_000);
  });

  it("versions a document purely from its own content", () => {
    expect(contentVersion(AGENT_RULES_DOC)).toMatch(/^[0-9a-f]{16}$/u);
    // No Date.now()/Math.random() anywhere in the hash: the same bytes must
    // produce the same version in every isolate and on every call.
    expect(contentVersion(AGENT_RULES_DOC)).toBe(contentVersion(canonicalDoc()));
    expect(contentVersion("")).not.toBe(contentVersion(AGENT_RULES_DOC));
  });
});
