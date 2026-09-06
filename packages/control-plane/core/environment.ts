/** Largest legal create/update body: userData 48 KiB, a credential manifest,
 * a member roster and JSON escaping on top. JSON.parse runs before any of it
 * is validated, so the ceiling stays close to real. */
export const WORKSPACE_REQUEST_MAX_BYTES = 128 * 1024;
