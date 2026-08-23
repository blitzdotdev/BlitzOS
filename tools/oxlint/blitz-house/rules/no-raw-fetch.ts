import { defineRule } from "@oxlint/plugins";

import { allowedFilesSchema, currentFileIsAllowed } from "./allowed-files.ts";
import { isGlobalValue } from "./global-reference.ts";

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
        if (isGlobalValue(context.sourceCode, node.callee, "fetch")) {
          context.report({ node, messageId: "rawFetch" });
        }
      },
    };
  },
});
