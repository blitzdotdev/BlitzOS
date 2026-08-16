import { describe, expect, it } from "vitest";
import {
  createPhoneHomeResponse,
  parsePhoneHomeRequest,
} from "../core/workspaces.js";

interface FixtureExpectation {
  valid: boolean;
  kind?: "success" | "failure";
  hostPublicKey?: string;
  message?: string;
  canonicalKeys?: string[];
}

interface FixtureDescriptor {
  contentType: string;
  body: string | Record<string, unknown> | unknown[];
  expect: FixtureExpectation;
}

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/phone-home/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

function fixturePaths(relativeDirectory: string): string[] {
  const marker = `/phone-home/${relativeDirectory}/`;
  return Object.keys(fixtureSources)
    .filter((fixturePath) => fixturePath.includes(marker))
    .map((fixturePath) => fixturePath.slice(fixturePath.indexOf("/phone-home/") + 12))
    .sort();
}

function fixture(relativePath: string): FixtureDescriptor {
  const suffix = `/phone-home/${relativePath}`;
  const source = Object.entries(fixtureSources)
    .find(([fixturePath]) => fixturePath.endsWith(suffix))?.[1];
  if (source === undefined) throw new Error(`missing phone-home fixture ${relativePath}`);
  return JSON.parse(source) as FixtureDescriptor;
}

function encodedBody(descriptor: FixtureDescriptor): string {
  return typeof descriptor.body === "string"
    ? descriptor.body
    : JSON.stringify(descriptor.body);
}

function canonicalResponse(
  value: string | Record<string, unknown> | unknown[],
  fields: string[],
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === fields.length &&
    actual.every((field, index) => field === fields[index]) &&
    actual.every((field) => typeof value[field] === "string" && value[field] !== "");
}

describe("phone-home shared fixtures", () => {
  it("parses every canonical and legacy request and rejects every invalid request", () => {
    const paths = [
      ...fixturePaths("requests/valid"),
      ...fixturePaths("requests/invalid"),
      ...fixturePaths("requests/legacy"),
    ];
    let accepted = 0;
    let rejected = 0;
    for (const relativePath of paths) {
      const descriptor = fixture(relativePath);
      if (!descriptor.expect.valid) {
        expect(
          () => parsePhoneHomeRequest(
            descriptor.contentType,
            encodedBody(descriptor),
          ),
          relativePath,
        ).toThrow();
        rejected += 1;
        continue;
      }
      const result = parsePhoneHomeRequest(
        descriptor.contentType,
        encodedBody(descriptor),
      );
      expect(result.kind, relativePath).toBe(descriptor.expect.kind);
      expect(result.canonicalKeys, relativePath).toEqual(
        descriptor.expect.canonicalKeys,
      );
      if (result.kind === "success") {
        expect(result.hostPublicKey, relativePath).toBe(
          descriptor.expect.hostPublicKey,
        );
      } else {
        expect(result.message, relativePath).toBe(descriptor.expect.message);
      }
      accepted += 1;
    }
    console.info(
      `phone-home server request conformance: ${accepted} accepted + ${rejected} rejected fixtures`,
    );
  });

  it("emits exactly the canonical response fixture fields", () => {
    const validPaths = fixturePaths("responses/valid");
    const invalidPaths = fixturePaths("responses/invalid");
    const descriptor = fixture(validPaths[0] ?? "");
    if (typeof descriptor.body !== "object" || descriptor.body === null || Array.isArray(descriptor.body)) {
      throw new Error("valid phone-home response fixture must have an object body");
    }
    const fields = descriptor.expect.canonicalKeys ?? [];
    const response = createPhoneHomeResponse(
      String(descriptor.body.box_id),
      String(descriptor.body.access_token),
      String(descriptor.body.refresh_token),
    );
    expect(response).toEqual(descriptor.body);
    expect(canonicalResponse(response, fields)).toBe(true);
    for (const relativePath of invalidPaths) {
      expect(canonicalResponse(fixture(relativePath).body, fields), relativePath).toBe(false);
    }
    console.info(
      `phone-home server response conformance: ${validPaths.length} valid + ${invalidPaths.length} invalid fixtures`,
    );
  });
});
