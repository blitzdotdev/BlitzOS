import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { allowedFilesSchema, currentFileIsAllowed } from "./allowed-files.ts";
import { isUnshadowedGlobal } from "./global-reference.ts";

const GLOBAL_CONSOLE_OWNERS = new Set(["globalThis", "self", "window"]);

function isGlobalConsole(
  sourceCode: SourceCode,
  node: ESTree.Expression,
): boolean {
  if (node.type === "Identifier") {
    return isUnshadowedGlobal(sourceCode, node, "console");
  }
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") {
    return false;
  }
  if (
    !GLOBAL_CONSOLE_OWNERS.has(node.object.name) ||
    !isUnshadowedGlobal(sourceCode, node.object, node.object.name)
  ) {
    return false;
  }
  return node.computed
    ? node.property.type === "Literal" && node.property.value === "console"
    : node.property.type === "Identifier" && node.property.name === "console";
}

function isConsoleMember(
  sourceCode: SourceCode,
  node: ESTree.MemberExpression,
): boolean {
  return isGlobalConsole(sourceCode, node.object);
}

/** Keep core logging at explicit structured-logging chokepoints. */
export const noConsoleInCoreRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow console access in control-plane core code.",
    },
    messages: {
      consoleInCore:
        "console.* is restricted in control-plane core. Route structured events through a sanctioned logging chokepoint.",
    },
    schema: allowedFilesSchema,
    defaultOptions: [{ allowFiles: [] }],
  },
  create(context) {
    if (currentFileIsAllowed(context)) return {};
    return {
      MemberExpression(node) {
        if (isConsoleMember(context.sourceCode, node)) {
          context.report({ node, messageId: "consoleInCore" });
        }
      },
    };
  },
});
