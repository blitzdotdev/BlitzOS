import type { SkillRenderInput } from "./types.js";

/** Canonical examples for every provider skill, written as `node -e` programs.
 *
 * The box image ships neither `curl` nor the `gh` CLI (packages/box/Dockerfile
 * installs neither, and the smoke test reaches for a sidecar curl container
 * precisely because there is none inside). Every canonical example in every
 * skill used to be a curl invocation, so not one of them ran — an agent that
 * followed a skill literally got "command not found" and invented its own
 * call. Node 22 is on PATH with a global `fetch`, so that is the shell the
 * examples speak.
 *
 * Two properties this module exists to hold:
 *
 * 1. The program is wrapped in shell single quotes, so it may never contain
 *    one. Everything interpolated goes through `JSON.stringify`, which emits
 *    double quotes, and the callers write object literals with double quotes.
 * 2. `node -e` runs as CommonJS, so there is no top-level `await`. The chain
 *    is `.then`, deliberately.
 *
 * `test/connections-catalog.test.ts` compiles every emitted program to prove
 * both, so a hand-written example that breaks either rule fails the build
 * rather than the agent.
 */

/** A JS expression that evaluates to the connection's base URL: the variable
 * in proxy mode, where the lease token only works against the control plane's
 * own proxy, and the literal vendor URL where the token goes direct. */
function baseExpression(input: SkillRenderInput): string {
  return input.baseUrlEnv === null
    ? JSON.stringify(input.baseUrl)
    : `process.env.${input.baseUrlEnv}`;
}

/** The connection's own auth header, plus whatever the call adds. */
function headersExpression(
  input: SkillRenderInput,
  extra: Readonly<Record<string, string>>,
): string {
  const entries = [
    `${JSON.stringify(input.tokenHeader.name)}: ${JSON.stringify(input.tokenHeader.prefix)} + process.env.${input.tokenEnv}`,
    ...Object.entries(extra).map(
      ([name, value]) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`,
    ),
  ];
  return `{${entries.join(", ")}}`;
}

export interface NodeFetchExample {
  /** Appended to the connection's base URL. Written exactly as the vendor
   * documents it, placeholders and all. */
  path: string;
  method?: "POST";
  /** Extra request headers beyond the connection's own auth header. */
  headers?: Readonly<Record<string, string>>;
  /** Source of a JS object literal, sent as a JSON body. Double quotes only —
   * a single quote here would end the shell string. */
  body?: string;
}

/** One runnable line (or short block) an agent can paste. */
export function nodeFetch(
  input: SkillRenderInput,
  example: NodeFetchExample,
): string {
  const url = `${baseExpression(input)} + ${JSON.stringify(example.path)}`;
  const tail = ").then(r => r.text()).then(console.log)'";
  if (example.method === undefined && example.body === undefined) {
    const headers = headersExpression(input, example.headers ?? {});
    return `node -e 'fetch(${url}, {headers: ${headers}}${tail}`;
  }
  const extra: Record<string, string> = {};
  if (example.body !== undefined) extra["Content-Type"] = "application/json";
  for (const [name, value] of Object.entries(example.headers ?? {})) {
    extra[name] = value;
  }
  const headers = headersExpression(input, extra);
  const lines = [
    `node -e 'fetch(${url}, {`,
    `  method: ${JSON.stringify(example.method ?? "POST")},`,
    `  headers: ${headers},`,
  ];
  if (example.body !== undefined) lines.push(`  body: JSON.stringify(${example.body}),`);
  // A newline inside the shell's single quotes is part of the one argument
  // node receives, so a multi-line program pastes and runs exactly as printed.
  lines.push(`}${tail}`);
  return lines.join("\n");
}
