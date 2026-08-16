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
  const option = context.options[0];
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    return false;
  }
  const allowFiles = option.allowFiles;
  if (!Array.isArray(allowFiles)) return false;
  const filename = relative(context.cwd, context.physicalFilename).replaceAll(
    "\\",
    "/",
  );
  return allowFiles.includes(filename);
}
