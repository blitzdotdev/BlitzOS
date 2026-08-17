import { describe, expect, it } from "vitest";
import { parseDavListing } from "../core/files/sync.js";

/** The dufs PROPFIND shape is a cross-runtime contract: the box image's file
 * server produces it, this parser consumes it. The fixtures pin the accepted
 * grammar; the guest side revalidates them when the box image is rebuilt. */
const xmlFixtures = import.meta.glob<string>(
  "../../schema/fixtures/dav-listing/*.xml",
  { eager: true, import: "default", query: "?raw" },
);
const expectations = import.meta.glob<{
  root: string;
  files: { key: string; size: number; mtime: number }[];
  directories: string[];
}>(
  "../../schema/fixtures/dav-listing/*.expected.json",
  { eager: true, import: "default" },
);

describe("dav listing fixtures", () => {
  it("has an expectation for every fixture and at least three fixtures", () => {
    const xmlNames = Object.keys(xmlFixtures).map((name) => name.replace(/\.xml$/u, ""));
    const expectedNames = Object.keys(expectations)
      .map((name) => name.replace(/\.expected\.json$/u, ""));
    expect(xmlNames.sort()).toEqual(expectedNames.sort());
    expect(xmlNames.length).toBeGreaterThanOrEqual(3);
  });

  for (const [path, xml] of Object.entries(xmlFixtures)) {
    it(`parses ${path.split("/").at(-1) ?? path}`, () => {
      const expected = expectations[path.replace(/\.xml$/u, ".expected.json")];
      if (expected === undefined) throw new Error(`missing expectation for ${path}`);
      expect(parseDavListing(xml, expected.root)).toEqual({
        files: expected.files,
        directories: expected.directories,
      });
    });
  }
});
