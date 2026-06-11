import type { ConnectOptions, Session } from "./types.js";
/** Open a session. Returns a Session object once register_reply { ok } is received. */
export declare function connect(opts: ConnectOptions): Promise<Session>;
