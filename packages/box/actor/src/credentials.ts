import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isString } from "./type-guards.js";
import type { Provider } from "./types.js";

const execFileAsync = promisify(execFile);

/** What `promisify(execFile)` rejects with: the child's own streams, attached
 * to an Error. */
interface ExecFailure {
  stderr?: Buffer | string;
}

function execFailure(error: Error): ExecFailure {
  // SAFETY: promisify(execFile) attaches the child's captured streams to the
  // rejected Error. `stderr` is declared optional and read defensively, so any
  // other rejection shape simply yields no reason.
  return error as ExecFailure;
}

/** One short line of the broker's own words, for a log.
 *
 * `blitz-cred token` writes exactly one thing to stdout — the token — and every
 * refusal to stderr, so nothing minted can be routed here. Without it, a member
 * who has to log in again and a box wired to a harness the broker will not mint
 * for produce the identical, useless "Command failed".
 */
function brokerReason(failure: ExecFailure): string {
  const stderr = failure.stderr;
  const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : isString(stderr) ? stderr : "";
  const line = text
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)
    .at(-1);
  if (line === undefined) return "";
  // Bounded, and stripped of control characters: this reaches a log line and a
  // remote must not be able to forge one or repaint a terminal through it.
  return [...line]
    .filter((character) => character >= " " && character !== "\u007F")
    .join("")
    .slice(0, 200);
}

export class CredentialSource {
  public constructor(private readonly stateDir: string) {}

  public async token(provider: Provider): Promise<string | null> {
    try {
      await access(join(this.stateDir, "broker.json"), constants.R_OK);
    } catch {
      // No broker is configured for this workspace. That is a supported state,
      // not a failure: the turn runs signed out.
      return null;
    }
    let stdout: Buffer;
    try {
      ({ stdout } = await execFileAsync("blitz-cred", ["token", provider], {
        encoding: "buffer",
        maxBuffer: 1_048_576,
        env: { ...process.env, BLITZ_STATE_DIR: this.stateDir },
      }));
    } catch (error) {
      const reason = error instanceof Error ? brokerReason(execFailure(error)) : "";
      throw new Error(reason ? `broker mint failed: ${reason}` : "broker mint failed");
    }
    if (stdout.length === 0 || stdout.length > 1_048_576) {
      throw new Error("broker returned an invalid token");
    }
    return stdout.toString("utf8");
  }
}
