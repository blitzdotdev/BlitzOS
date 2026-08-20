/** Blitz's own additions to the Agent Client Protocol.
 *
 * ACP itself is owned by `@agentclientprotocol/sdk`; only the `blitz/…`
 * extensions live here. They cross a runtime boundary — the box actor writes
 * them onto the websocket, the browser chat panel reads them — so per
 * CLAUDE.md they get one typed declaration, a fixture corpus under
 * `fixtures/acp/`, and conformance tests on both sides.
 *
 * The box actor deliberately does NOT import this package. It builds and ships
 * standalone into the box image, where a workspace dependency on
 * `@blitzos/schema` would have to be bundled or vendored, so it keeps its own
 * `AuthRequiredFrame` in `packages/box/actor/src/journal.ts`. Do not "unify"
 * the two by adding the dependency — that breaks the box build. The two
 * declarations are held together by the shared fixture instead:
 * `actor/test/actor.test.ts` asserts what the actor emits against
 * `fixtures/acp/auth-required.jsonl`, and `webapp/test/acp-reducer.test.ts`
 * plus `webapp/test/chat-auth-required.test.tsx` replay the same file.
 */

import { HARNESSES } from "./broker.js";

/** Which harness needs a sign-in.
 *
 * Read off `HARNESSES` rather than re-spelled as a union: the same list decides
 * who the broker will mint for, and a chat panel that offers a sign-in for a
 * harness the broker does not serve — or silently drops one it does — is the
 * drift this indirection exists to make impossible.
 */
export type AuthRequiredProvider = (typeof HARNESSES)[number];

/** JSON-RPC method name of the live-only sign-in signal. */
export const ACP_AUTH_REQUIRED_METHOD = "blitz/auth_required";

export interface AuthRequiredParams {
  sessionId: string;
  provider: AuthRequiredProvider;
}

/** A `blitz/auth_required` notification, whole.
 *
 * Notification, never a request, and never journaled: the box announces it when
 * a credential mint fails mid-turn, and replaying it onto an attach tomorrow
 * would demand a sign-in the session no longer needs. The persisted half of the
 * event is the ordinary `session/update` prose bubble the actor emits beside
 * it, which is why the fixture carries both frames.
 */
export interface AuthRequiredNotification {
  jsonrpc: "2.0";
  method: typeof ACP_AUTH_REQUIRED_METHOD;
  params: AuthRequiredParams;
}
