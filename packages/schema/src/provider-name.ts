/** The provider-name rule every runtime agrees on.
 *
 * A provider name is a catalog id or a member-named generic connection. It
 * becomes the box wire's `integration` value and a file name inside the box,
 * and rides grants, org connection rows, template stipulations, and the
 * `blitz connections open` focus marker — so independent readers apply one
 * rule. The rule lives here; the control plane's grant validator
 * (`PROVIDER_NAME` in core/connections/user-grants.ts) mirrors it because
 * control-plane core keeps to relative imports, and the two guest-side
 * readers — the CLI producer (packages/box/rootfs/usr/local/bin/blitz) and
 * the Go gateway (packages/box/gateway/main.go) — mirror it because they
 * cannot import TypeScript. Every copy is pinned by
 * packages/schema/fixtures/connections-focus/.
 */

/** The grant validator's cap: at most 63 characters. */
export const MAX_PROVIDER_NAME_LENGTH = 63;

/** Lowercase alphanumeric plus `.` `_` `-`, starting alphanumeric. */
const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export function isProviderName(value: string): boolean {
  return PROVIDER_NAME_PATTERN.test(value);
}
