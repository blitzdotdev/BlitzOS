import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const labDirectory = fileURLToPath(
  new URL("../../test/payload-lab/", import.meta.url),
);

describe("thin-image payload lab dry runs", () => {
  it("exposes the headless session-driver commands", () => {
    const result = spawnSync(
      "node",
      [`${labDirectory}/session-driver/drive.mjs`, "--help"],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("open --ssh <user@host[:port]> --key <private-key>");
    expect(result.stdout).toContain("session create --agent <claude|codex>");
    expect(result.stdout).toContain("session prompt <session-id> <text>");
    expect(result.stdout).toContain("session status <session-id>");
    expect(result.stdout).toContain("session wait <session-id> --timeout <seconds>");
  });

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
      expect(result.stdout.trim()).toMatch(new RegExp(`^E${experiment} PASS .+$`, "u"));
    });
  }
});
