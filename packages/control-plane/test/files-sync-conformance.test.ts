import { describe, expect, it } from "vitest";
import type {
  ListFolderAttachmentsResponse,
  ListFolderObjectsResponse,
} from "@blitzos/schema";

const fixtures = import.meta.glob<string>(
  "../../schema/fixtures/files-sync/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseList(value: unknown): ListFolderObjectsResponse {
  if (
    !isRecord(value)
    || !exactKeys(value, ["objects", "cursor", "truncated"])
    || !Array.isArray(value.objects)
    || !(value.cursor === null || typeof value.cursor === "string")
    || typeof value.truncated !== "boolean"
  ) throw new Error("invalid list");
  return {
    objects: value.objects.map((candidate) => {
      if (
        !isRecord(candidate)
        || !exactKeys(candidate, ["key", "size", "mtime", "editedBy"])
        || typeof candidate.key !== "string"
        || !Number.isSafeInteger(candidate.size)
        || !Number.isSafeInteger(candidate.mtime)
        || typeof candidate.editedBy !== "string"
      ) throw new Error("invalid object");
      return {
        key: candidate.key,
        size: Number(candidate.size),
        mtime: Number(candidate.mtime),
        editedBy: candidate.editedBy,
      };
    }),
    cursor: value.cursor,
    truncated: value.truncated,
  };
}

function parseAttachments(value: unknown): ListFolderAttachmentsResponse {
  if (!isRecord(value) || !exactKeys(value, ["folders"]) || !Array.isArray(value.folders)) {
    throw new Error("invalid attachments");
  }
  return { folders: value.folders.map((candidate) => {
    const role = isRecord(candidate) ? candidate.role : null;
    if (
      !isRecord(candidate)
      || !exactKeys(candidate, ["id", "name", "role", "version", "attachedAt"])
      || typeof candidate.id !== "string"
      || typeof candidate.name !== "string"
      || (role !== "owner" && role !== "admin" && role !== "editor" && role !== "viewer")
      || !Number.isSafeInteger(candidate.version)
      || !Number.isSafeInteger(candidate.attachedAt)
    ) throw new Error("invalid attachment");
    return {
      id: candidate.id,
      name: candidate.name,
      role,
      version: Number(candidate.version),
      attachedAt: Number(candidate.attachedAt),
    };
  }) };
}

describe("files sync shared fixtures on the control-plane side", () => {
  it("accepts valid fixtures and rejects invalid fixtures", () => {
    for (const [fixturePath, source] of Object.entries(fixtures)) {
      const value: unknown = JSON.parse(source);
      const parser = fixturePath.endsWith("list.json")
        || fixturePath.endsWith("list-missing-edited-by.json")
        ? parseList
        : parseAttachments;
      if (fixturePath.includes("/valid/")) expect(() => parser(value), fixturePath).not.toThrow();
      else expect(() => parser(value), fixturePath).toThrow();
    }
  });
});
