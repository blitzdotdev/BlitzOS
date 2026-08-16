import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { allowedFilesSchema, currentFileIsAllowed } from "./allowed-files.ts";
import { isUnshadowedGlobal } from "./global-reference.ts";

const GLOBAL_FETCH_OWNERS = new Set(["globalThis", "self", "window"]);

function isDirectFetchCall(
  sourceCode: SourceCode,
  node: ESTree.CallExpression,
): boolean {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    return isUnshadowedGlobal(sourceCode, callee, "fetch");
  }
  if (callee.type !== "MemberExpression" || callee.object.type !== "Identifier") {
    return false;
  }
  if (
    !GLOBAL_FETCH_OWNERS.has(callee.object.name) ||
    !isUnshadowedGlobal(sourceCode, callee.object, callee.object.name)
  ) {
    return false;
  }
  return callee.computed
    ? callee.property.type === "Literal" && callee.property.value === "fetch"
    : callee.property.type === "Identifier" && callee.property.name === "fetch";
}

/** Require core network requests to pass through the repository's fetch boundary. */
export const noRawFetchRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct fetch calls in control-plane core code.",
    },
    messages: {
      rawFetch:
        "Direct fetch calls bypass the control-plane request boundary. Use the canonical provider helper or an injected fetcher.",
    },
    schema: allowedFilesSchema,
    defaultOptions: [{ allowFiles: [] }],
  },
  create(context) {
    if (currentFileIsAllowed(context)) return {};
    return {
      CallExpression(node) {
        if (isDirectFetchCall(context.sourceCode, node)) {
          context.report({ node, messageId: "rawFetch" });
        }
      },
    };
  },
});
