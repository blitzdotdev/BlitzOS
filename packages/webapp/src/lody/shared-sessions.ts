/**
 * What the rail needs to draw "Shared with you"
 * (plans/LODY-SHARING.md §8 step 3, §10.3).
 *
 * A grantee's own runtime is connected to their own box, so the sessions other
 * members shared with them are not in its session mirror and cannot be: they
 * live on somebody else's daemon. Two reads make a row:
 *
 * 1. WHICH sessions — `GET /workspaces/:id/session-shares`, the `received`
 *    half. That is the control plane's word, and it is the only authority for
 *    which grants exist.
 * 2. What they are CALLED — one `join {scope:"meta"}` against the owner's box,
 *    over the shared prefix.
 *
 * THE SECOND READ IS DELIBERATELY NOT A RUNTIME. `SessionMeta` reaches a
 * `LoroRepo` through the meta flock, and the flock arrives as `flock-json` — a
 * plain `{version, entries}` bundle whose keys are JSON-encoded document paths
 * (`plans/LODY-SHARING.md` §10.1). So a title is `["m","session-<id>","title"]`
 * out of one frame, with no repo, no WASM instance, no IndexedDB and no second
 * runtime. The bridge has already narrowed that bundle to the granted documents
 * before it arrives, so this read is also the cheapest proof the projection
 * works.
 *
 * A title that does not arrive is not an error. The row falls back to the
 * session's short id, which is what the rail would show for an untitled session
 * anyway, and the surface still opens.
 */
import { isJsonArray, isJsonObject, isJsonString, parseJson, type JsonValue } from "@blitzos/schema";
import type { SessionShareLevel } from "@blitzos/schema";
import { isTextPayload, type WebSocketPayload } from "./data-plane-connection.js";

/** One row of the rail's "Shared with you" section. */
export interface SharedSessionRow {
  sessionId: string;
  /** The membership whose machine runs it — the `:membershipId` in the shared
   * prefix, and the key the surface is remounted under. */
  ownerMembershipId: string;
  level: SessionShareLevel;
  /** The owner's display name, or their membership id when the workspace's
   * member list has not arrived. */
  ownerName: string;
  /** The session's own title, or `null` while the owner's box has not answered. */
  title: string | null;
}

/** The one protocol-v7 frame this module sends. */
const PROTOCOL_VERSION = 7;
const SESSION_DOC_PREFIX = "session-";
const TITLE_FIELD = "title";
/** A meta room that does not answer inside this window leaves the rows titled
 * by id. Generous, because the box may be booting; bounded, because the rail
 * re-reads on every change to the grant list. */
const META_READ_TIMEOUT_MS = 8_000;

/** `["m","session-<id>","title"]` → `<id>`, and `null` for every other key. */
export function titleKeySessionId(encodedKey: string): string | null {
  const key = parseJson(encodedKey);
  if (!isJsonArray(key) || key.length !== 3) return null;
  const [kind, docId, field] = key;
  if (kind !== "m" || docId === undefined || !isJsonString(docId)) return null;
  if (field !== TITLE_FIELD) return null;
  return docId.startsWith(SESSION_DOC_PREFIX) ? docId.slice(SESSION_DOC_PREFIX.length) : null;
}

/**
 * Every session title a meta-flock bundle carries, by session id.
 *
 * Exported because it is the whole of this module that is worth testing without
 * a socket: the frame shape is pinned by
 * `packages/schema/fixtures/lody-share-claim/decisions.json`, and this reads it.
 */
export function sessionTitlesFromMetaBundle(bundle: JsonValue | undefined): Map<string, string> {
  const titles = new Map<string, string>();
  if (bundle === undefined || !isJsonObject(bundle)) return titles;
  const entries = bundle.entries;
  if (entries === undefined || !isJsonObject(entries)) return titles;
  for (const [encodedKey, record] of Object.entries(entries)) {
    const sessionId = titleKeySessionId(encodedKey);
    if (sessionId === null || !isJsonObject(record)) continue;
    const value = record.d;
    if (value !== undefined && isJsonString(value) && value !== "") titles.set(sessionId, value);
  }
  return titles;
}

export interface SharedMetaReadOptions {
  /** The owner's `lodySyncUrl`, built by `EndpointResolver.resolveShared`. */
  syncUrl: string;
  /** The OWNER daemon's workspace id, from their narrowed `/lody/platform`. */
  workspaceId: string;
  webSocketConstructor?: typeof WebSocket;
  timeoutMs?: number;
}

/**
 * Reads the granted sessions' titles off one owner's box.
 *
 * Opens a socket, joins `meta`, takes the first `joined` frame and closes. The
 * connection is not kept: the rail wants a label, and a live subscription would
 * be a second data plane per owner for the sake of a string.
 */
export async function readSharedSessionTitles(
  options: SharedMetaReadOptions,
): Promise<Map<string, string>> {
  const Socket = options.webSocketConstructor ?? WebSocket;
  const socket = new Socket(options.syncUrl);
  try {
    return await new Promise<Map<string, string>>((resolve) => {
      const timer = setTimeout(() => resolve(new Map()), options.timeoutMs ?? META_READ_TIMEOUT_MS);
      const settle = (titles: Map<string, string>): void => {
        clearTimeout(timer);
        resolve(titles);
      };
      socket.onerror = () => settle(new Map());
      socket.onclose = () => settle(new Map());
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "join",
            protocolVersion: PROTOCOL_VERSION,
            requestId: crypto.randomUUID(),
            workspaceId: options.workspaceId,
            peerId: `renderer:${crypto.randomUUID()}`,
            room: { scope: "meta" },
          }),
        );
      };
      socket.onmessage = (event: MessageEvent<WebSocketPayload>) => {
        // The bridge only ever sends text frames; anything else is not ours.
        if (!isTextPayload(event.data)) return;
        const frame = parseJson(event.data);
        if (!isJsonObject(frame)) return;
        // A refusal settles the read as surely as an answer does: the rows keep
        // their ids and the rail stops waiting.
        if (frame.type === "error") settle(new Map());
        if (frame.type !== "joined") return;
        const payload = frame.payload;
        if (payload === undefined || !isJsonObject(payload)) return settle(new Map());
        settle(sessionTitlesFromMetaBundle(payload.bundle));
      };
    });
  } finally {
    socket.close();
  }
}
