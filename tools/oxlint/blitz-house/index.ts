import { eslintCompatPlugin } from "@oxlint/plugins";

import { noConsoleInCoreRule } from "./rules/no-console-in-core.ts";
import { noRawFetchRule } from "./rules/no-raw-fetch.ts";

/** Repository-specific rules that enforce Blitz control-plane conventions. */
const blitzHousePlugin = eslintCompatPlugin({
  meta: { name: "blitz-house" },
  rules: {
    "no-console-in-core": noConsoleInCoreRule,
    "no-raw-fetch": noRawFetchRule,
  },
});

export default blitzHousePlugin;
