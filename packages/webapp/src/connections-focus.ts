import { isProviderName } from '@blitzos/schema';
import { gatewayEndpointUrl, PORTS_POLL_INTERVAL_MS } from './preview';
import { asJsonObject, isNumber, isString, type JsonValue } from './type-guards';

export { PORTS_POLL_INTERVAL_MS };

/** The marker `blitz connections open <provider>` writes and the Go gateway
 * serves at `GET /connections-focus` as `{ focus: ConnectionsFocus | null }`.
 * `requestedAt` is a millisecond epoch the webApp uses to open the workspace
 * connections panel at most once per focus. */
export type ConnectionsFocus = {
  version: 1;
  provider: string;
  requestedAt: number;
};

/** Parses the `GET /connections-focus` response body. Anything that is not a
 * version-1 object with a usable provider name (`isProviderName`, the schema
 * package's one provider-name rule) and a safe non-negative `requestedAt` —
 * an old box's 404 body, `{ focus: null }`, or a malformed marker —
 * collapses to null. Mirrors the Go gateway's parseConnectionsFocus so the
 * browser never selects a provider name no catalog or connection row could
 * carry. */
export function parseConnectionsFocus(value: JsonValue): ConnectionsFocus | null {
  const object = asJsonObject(value);
  if (object === null) return null;
  const focus = asJsonObject(object.focus);
  if (
    focus === null
    || focus.version !== 1
    || !isString(focus.provider)
    || !isProviderName(focus.provider)
    || !isNumber(focus.requestedAt)
    || !Number.isSafeInteger(focus.requestedAt)
    || focus.requestedAt < 0
  ) return null;
  return {
    version: 1,
    provider: focus.provider,
    requestedAt: focus.requestedAt,
  };
}

export function connectionsFocusEndpointUrl(filesBase: string): string {
  return gatewayEndpointUrl(filesBase, 'connections-focus');
}

/** "The box has no focus right now" and "we could not ask the box" are
 * different answers, and only the first may be adopted as the never-replay
 * baseline — the same rule the preview-focus poller keeps. */
export type ConnectionsFocusResult =
  | { ok: true; focus: ConnectionsFocus | null }
  | { ok: false };

export async function fetchWorkspaceConnectionsFocus(
  filesBase: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ConnectionsFocusResult> {
  try {
    const response = await fetcher(connectionsFocusEndpointUrl(filesBase), {
      credentials: 'include',
      signal,
    });
    // An old box 404s the route; that is a failure to read, not a report that
    // no focus exists, so it never becomes a baseline either.
    if (!response.ok) return { ok: false };
    // SAFETY: Response.json parses JSON text, whose values are representable by JsonValue.
    const value = await response.json() as JsonValue;
    return { ok: true, focus: parseConnectionsFocus(value) };
  } catch {
    return { ok: false };
  }
}
