import { relative } from "node:path";

import type { Context } from "@oxlint/plugins";

export const allowedFilesSchema = [
  {
    type: "object",
    properties: {
      allowFiles: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
      },
    },
    additionalProperties: false,
  },
] as const;

export function currentFileIsAllowed(context: Context): boolean {
  // SAFETY: before any linting runs, oxlint merges the rules' defaultOptions
  // ([{ allowFiles: [] }]) into the config options and AJV-validates the
  // result against allowedFilesSchema, aborting the whole run on mismatch —
  // so options[0] is always an object whose allowFiles is a string array.
  const { allowFiles } = context.options[0] as { allowFiles: string[] };
  const filename = relative(context.cwd, context.physicalFilename).replaceAll(
    "\\",
    "/",
  );
  return allowFiles.includes(filename);
}
