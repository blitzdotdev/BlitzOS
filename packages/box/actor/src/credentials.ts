import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

export class CredentialSource {
  public constructor(private readonly stateDir: string) {}

  public async token(provider: Provider): Promise<string | null> {
    try {
      await access(join(this.stateDir, "broker.json"), constants.R_OK);
    } catch {
      return null;
    }
    const { stdout } = await execFileAsync("blitz-cred", ["token", provider], {
      encoding: "buffer",
      maxBuffer: 1_048_576,
      env: { ...process.env, BLITZ_STATE_DIR: this.stateDir },
    });
    if (stdout.length === 0 || stdout.length > 1_048_576) {
      throw new Error("broker returned an invalid token");
    }
    return stdout.toString("utf8");
  }
}
