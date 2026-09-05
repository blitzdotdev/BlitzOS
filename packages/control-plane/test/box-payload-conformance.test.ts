import {
  BOX_PAYLOAD_OUTCOMES,
  isJsonObject,
  isJsonString,
  parseBoxPayloadManifest,
  parseBoxPayloadResultRequest,
  parseJson,
} from "@blitzos/schema";
import { describe, expect, it } from "vitest";

const fixtureSources = import.meta.glob<string>(
  "../../schema/fixtures/box-payload/**/*.json",
  { eager: true, import: "default", query: "?raw" },
);

const fixtureMarker = "/box-payload/";

function relativeFixturePath(fixturePath: string): string {
  const markerIndex = fixturePath.indexOf(fixtureMarker);
  if (markerIndex < 0) throw new Error(`box-payload fixture path is outside the corpus: ${fixturePath}`);
  return fixturePath.slice(markerIndex + fixtureMarker.length);
}

function fixtureEntries(prefix: string): Array<[string, string]> {
  return Object.entries(fixtureSources)
    .map(([fixturePath, source]): [string, string] => [relativeFixturePath(fixturePath), source])
    .filter(([fixturePath]) => fixturePath.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right));
}

function expectedInvalidFields(): Map<string, string> {
  const casesEntry = Object.entries(fixtureSources)
    .find(([fixturePath]) => relativeFixturePath(fixturePath) === "cases.json");
  if (casesEntry === undefined) throw new Error("box-payload cases.json is missing");
  const cases = parseJson(casesEntry[1]);
  if (!isJsonObject(cases)) throw new Error("box-payload cases.json must be an object");

  const fields = new Map<string, string>();
  for (const [fixturePath, field] of Object.entries(cases)) {
    if (!isJsonString(field)) {
      throw new Error(`box-payload cases.json field for ${fixturePath} must be a string`);
    }
    fields.set(fixturePath, field);
  }
  return fields;
}

const manifestValidPaths = [
  "valid/full-manifest.json",
  "valid/min-updater-unsupported.json",
  "valid/no-daemon.json",
  "valid/single-file.json",
];

const resultValidPaths = [
  "payload-result/valid/applied.json",
  "payload-result/valid/booted.json",
  "payload-result/valid/deferred.json",
  "payload-result/valid/fetch-failed.json",
  "payload-result/valid/rolled-back.json",
  "payload-result/valid/start-failed.json",
  "payload-result/valid/unsupported.json",
  "payload-result/valid/up-to-date.json",
  "payload-result/valid/verify-failed.json",
];

describe("box-payload v2 fixture conformance", () => {
  it("accepts every valid manifest, including a valid but unsupported updater version", () => {
    const entries = fixtureEntries("valid/");
    expect(entries.map(([fixturePath]) => fixturePath)).toEqual(manifestValidPaths);

    for (const [fixturePath, source] of entries) {
      const manifest = parseBoxPayloadManifest(parseJson(source));
      expect(manifest.files.length, fixturePath).toBeGreaterThan(0);
      expect(manifest.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)), fixturePath)
        .toBe(true);
      if (fixturePath.endsWith("min-updater-unsupported.json")) {
        expect(manifest.minUpdater).toBe(3);
      }
      if (manifest.minUpdater === 2) {
        expect(manifest.directories).toContain(
          "rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d",
        );
      }
      if (fixturePath.endsWith("no-daemon.json")) {
        expect(manifest.daemon).toBeUndefined();
      }
    }
  });

  it("accepts all nine payload-result outcomes", () => {
    const entries = fixtureEntries("payload-result/valid/");
    expect(entries.map(([fixturePath]) => fixturePath)).toEqual(resultValidPaths);
    const outcomes = entries.map(([, source]) =>
      parseBoxPayloadResultRequest(parseJson(source)).outcome);
    expect(outcomes.toSorted()).toEqual([...BOX_PAYLOAD_OUTCOMES].sort());
  });

  it("rejects every invalid body with the expected field name", () => {
    const invalidEntries = [
      ...fixtureEntries("invalid/"),
      ...fixtureEntries("payload-result/invalid/"),
    ].sort(([left], [right]) => left.localeCompare(right));
    const expectedFields = expectedInvalidFields();
    expect(invalidEntries.map(([fixturePath]) => fixturePath))
      .toEqual([...expectedFields.keys()].sort());

    for (const [fixturePath, source] of invalidEntries) {
      const expectedField = expectedFields.get(fixturePath);
      if (expectedField === undefined) throw new Error(`missing expected field for ${fixturePath}`);
      const parse = fixturePath.startsWith("payload-result/")
        ? parseBoxPayloadResultRequest
        : parseBoxPayloadManifest;
      expect(() => parse(parseJson(source)), fixturePath).toThrow(expectedField);
    }
  });
});
