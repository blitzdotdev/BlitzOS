import { defineRule } from "@oxlint/plugins";

import { allowedFilesSchema, currentFileIsAllowed } from "./allowed-files.ts";
import { isGlobalValue } from "./global-reference.ts";

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
        if (isGlobalValue(context.sourceCode, node.object, "console")) {
          context.report({ node, messageId: "consoleInCore" });
        }
      },
    };
  },
});
