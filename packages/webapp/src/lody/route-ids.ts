/**
 * The three route ids, in a module of their own.
 *
 * They were `router.tsx`'s exports and still are — it re-exports them, so no
 * reader has to learn a second place. They moved here because
 * `MobileSessionStack.tsx` looks a session up by id (`useSearch({ from })`) and
 * `router.tsx` mounts that stack, so leaving the constants in `router.tsx` would
 * make the two files import each other.
 *
 * THE IDS ARE UPSTREAM'S, BYTE FOR BYTE. Their own components read sessions out
 * of the router by these strings — `components/mobile/mobile-workspace-stack.tsx:14`
 * and `components/tasks/task-routes.ts:6` — and every one of those lookups passes
 * `shouldThrow: false`. A mismatch would not crash; it would answer `undefined`
 * and a mobile drawer would quietly stop opening.
 */
export const LODY_CHAT_ROUTE = "/$workspaceName/_auth/chat";
export const LODY_SESSION_ROUTE = "/$workspaceName/_auth/sessions/$sessionId";
export const LODY_ARCHIVE_ROUTE = "/$workspaceName/_auth/archive";
