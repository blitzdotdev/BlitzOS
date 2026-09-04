import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const labDirectory = fileURLToPath(
  new URL("../../test/payload-lab/", import.meta.url),
);

describe("thin-image payload lab dry runs", () => {
  for (let experiment = 1; experiment <= 16; experiment += 1) {
    it(`dry-runs E${experiment}`, () => {
      const result = spawnSync("bash", [`${labDirectory}/e${experiment}.sh`], {
        encoding: "utf8",
        env: { ...process.env, PAYLOAD_LAB_DRY: "1" },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain(`E${experiment}`);
      expect(output).toContain("DRY");
    });
  }
});
