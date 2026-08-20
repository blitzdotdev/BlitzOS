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
    return parseToken(stdout);
  }
}

/** The broker's stdout, parsed into a token.
 *
 * The TRIM is load-bearing, not tidiness. The broker prints the minted token
 * with `fmt.Fprintln` (packages/broker/cmd/blitz-broker/main.go), so the bytes
 * that arrive here always end in a newline, and every hop between there and
 * here passes them through verbatim. The terminal shim survives it because
 * `$(…)` strips trailing newlines; the chat path does not — the value goes
 * straight into CLAUDE_CODE_OAUTH_TOKEN, and a token with a newline in it is
 * rejected by the vendor on every single request. A signed-in workspace whose
 * chat says "not logged in" is exactly that newline.
 *
 * Control characters are then a REFUSAL rather than something else to strip.
 * A token is one opaque line; anything else on this channel means the broker
 * sent something that is not a token, and quietly repairing it would deliver
 * whichever fragment survived the repair.
 */
function parseToken(stdout: Buffer): string {
  const token = stdout.toString("utf8").trim();
  if (token.length === 0 || [...token].some((character) => character < " " || character === "\u007F")) {
    throw new Error("broker returned an invalid token");
  }
  return token;
}
