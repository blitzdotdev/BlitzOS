// ---------------------------------------------------------------------------
// SCOPE FENCE — read this before adding anything to this module.
//
// The chat-session store serves the chat session list, replay, and resume.
// ONLY that. Two tables: `sessions` and `events`. Both journaled frame
// shapes — `session/update` and `blitz/permission_answered` — live in
// `events`, so replay keeps permission history without any side table.
//
// This is deliberately NOT an analytics, metering, or usage store. Usage and
// eval data comes from the native harness transcripts in the agent HOME on
// the state volume (`~/.claude/projects/…`, `~/.codex/sessions/…`). Do not
// add tables, columns, or queries here to answer usage questions; do not
// extend this store beyond chat.
// ---------------------------------------------------------------------------

import { existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { Provider } from "./types.js";

export interface SessionUpdateFrame {
  jsonrpc: "2.0";
  method: "session/update";
  params: {
    sessionId: string;
    update: SessionUpdate;
    actor: { userId: string; name?: string };
  };
}

export interface PermissionAnsweredFrame {
  jsonrpc: "2.0";
  method: "blitz/permission_answered";
  params: {
    sessionId: string;
    toolCallId: string;
    optionId: string | null;
    actor: { userId: string; name?: string };
  };
}

/** The box could not mint a credential for this provider, so the user has to
 * sign the harness in again. Deliberately absent from {@link JournalFrame}:
 * `ChatSessionStore.append` only accepts journaled frames, so this one cannot
 * be persisted by accident and replayed hours after the session recovered. */
export interface AuthRequiredFrame {
  jsonrpc: "2.0";
  method: "blitz/auth_required";
  params: {
    sessionId: string;
    provider: Provider;
  };
}

export type JournalFrame = SessionUpdateFrame | PermissionAnsweredFrame;

/** Everything a subscriber can receive: the journaled frames plus live-only ones. */
export type OutboundFrame = JournalFrame | AuthRequiredFrame;

export type StoredSession = {
  id: string;
  provider: Provider;
  cwd: string;
  resumeId: string | null;
  createdBy: string;
  updatedAt: number;
};

export interface SessionSummary {
  id: string;
  provider: Provider;
  createdBy: string;
  updatedAt: number;
}

export type JournalEvent = {
  seq: number;
  frame: string;
};

/** The store was named journal.db before the chat_session rename, so a reused
 * state volume may still carry that file. Adopt it — together with its SQLite
 * WAL and SHM siblings — under the new name before the first open. */
function adoptLegacyJournalFile(path: string): void {
  const legacy = join(dirname(path), "journal.db");
  if (!existsSync(legacy) || existsSync(path)) return;
  renameSync(legacy, path);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${legacy}${suffix}`)) renameSync(`${legacy}${suffix}`, `${path}${suffix}`);
  }
}

export class ChatSessionStore {
  private readonly database: Database.Database;

  public constructor(path: string) {
    adoptLegacyJournalFile(path);
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    // The DROPs retire the pre-rename side tables on reused volumes. Their
    // only consumer-visible content — permission answers — already lives in
    // `events` as `blitz/permission_answered` frames.
    this.database.exec(`
      DROP TABLE IF EXISTS turns;
      DROP TABLE IF EXISTS permissions;
      DROP TABLE IF EXISTS participants;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        cwd TEXT NOT NULL,
        resume_id TEXT,
        next_seq INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL DEFAULT 'legacy-owner',
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        frame TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
    `);
    const rawSessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all();
    // SAFETY: SQLite PRAGMA table_info rows always include the string column name used below.
    const sessionColumns = new Set((rawSessionColumns as Array<{ name: string }>).map(({ name }) => name));
    if (!sessionColumns.has("created_by")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN created_by TEXT NOT NULL DEFAULT 'legacy-owner'");
    }
    if (!sessionColumns.has("updated_at")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    }
  }

  public close(): void {
    this.database.close();
  }

  public createSession(session: StoredSession): void {
    this.database
      .prepare("INSERT INTO sessions (id, provider, cwd, resume_id, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(session.id, session.provider, session.cwd, session.resumeId, session.createdBy, session.updatedAt);
  }

  public session(id: string): StoredSession | undefined {
    // SAFETY: The query selects every StoredSession field from the schema-owned sessions table with the matching alias.
    const row = this.database
      .prepare("SELECT id, provider, cwd, resume_id AS resumeId, created_by AS createdBy, updated_at AS updatedAt FROM sessions WHERE id = ?")
      .get(id) as StoredSession | undefined;
    return row;
  }

  public setResumeId(sessionId: string, resumeId: string): void {
    this.database.prepare("UPDATE sessions SET resume_id = ?, updated_at = ? WHERE id = ?").run(resumeId, Date.now(), sessionId);
  }

  public listSessions(): SessionSummary[] {
    // SAFETY: The query projects the complete SessionSummary shape from schema-owned session rows.
    return this.database.prepare(
      "SELECT id, provider, created_by AS createdBy, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC, id",
    ).all() as SessionSummary[];
  }

  public append(sessionId: string, frame: JournalFrame): number {
    return this.database.transaction(() => {
      // SAFETY: The schema-owned sessions table declares next_seq as a non-null integer, aliased here as seq.
      const row = this.database.prepare("SELECT next_seq AS seq FROM sessions WHERE id = ?").get(sessionId) as
        | { seq: number }
        | undefined;
      if (!row) throw new Error("unknown session");
      this.database
        .prepare("INSERT INTO events (session_id, seq, frame) VALUES (?, ?, ?)")
        .run(sessionId, row.seq, JSON.stringify(frame));
      this.database.prepare("UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
      return row.seq;
    })();
  }

  public replay(sessionId: string, limit: number): JournalEvent[] {
    // SAFETY: The query selects the complete JournalEvent projection from schema-owned event rows.
    const rows = this.database
      .prepare(
        `SELECT seq, frame FROM (
           SELECT seq, frame FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq`,
      )
      .all(sessionId, limit) as JournalEvent[];
    return rows;
  }
}
