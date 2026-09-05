import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(result.stdout).toContain("--permissions <allow|deny|ask>");
    expect(result.stdout).toContain("session prompt <session-id> <text>");
    expect(result.stdout).toContain("session status <session-id>");
    expect(result.stdout).toContain("session wait <session-id> --timeout <seconds>");
    expect(result.stdout).toContain("session cancel <session-id>");
    expect(result.stdout).toContain("session list");
  });

  it("dry-runs cancellation through the shared lab helper", () => {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; cancel_turn workspace-1 session-1', "payload-lab", `${labDirectory}/lib.sh`],
      { encoding: "utf8", env: { ...process.env, PAYLOAD_LAB_DRY: "1" } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("DRY session-driver cancel session-1 on <workspace:workspace-1>");
  });

  it("reads a quoted image pin from the deployment config once", () => {
    const root = mkdtempSync(join(tmpdir(), "payload-lab-config-"));
    try {
      mkdirSync(join(root, "packages/control-plane"), { recursive: true });
      writeFileSync(
        join(root, "packages/control-plane/wrangler.toml"),
        'BOX_IMAGE_REF = "https://control-plane.example/box-image/thin-7/manifest.json"\n',
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; PAYLOAD_LAB_REPO=$2; _wrangler_string_var BOX_IMAGE_REF',
          "payload-lab",
          `${labDirectory}/lib.sh`,
          root,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("https://control-plane.example/box-image/thin-7/manifest.json\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      if (experiment <= 4) {
        expect(output).toContain("normal updater poll");
        expect(output).toContain("deploy only the payload pin");
      }
      if (experiment === 2) {
        expect(output).toContain("uniquely named tmux session");
        expect(output).toContain("fresh local gateway/ttyd websocket");
      }
    });
  }
});
