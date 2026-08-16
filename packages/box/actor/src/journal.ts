import Database from "better-sqlite3";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { Provider } from "./types.js";

export interface SessionUpdateFrame {
  jsonrpc: "2.0";
  method: "session/update";
  params: {
    sessionId: string;
    update: SessionUpdate;
  };
}

export type StoredSession = {
  id: string;
  provider: Provider;
  cwd: string;
  resumeId: string | null;
};

export type JournalEvent = {
  seq: number;
  frame: string;
};

export class Journal {
  private readonly database: Database.Database;

  public constructor(path: string) {
    this.database = new Database(path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        cwd TEXT NOT NULL,
        resume_id TEXT,
        next_seq INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        frame TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        terminal TEXT
      );
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request TEXT NOT NULL,
        response TEXT
      );
    `);
    this.database.prepare("UPDATE turns SET terminal = 'refusal' WHERE terminal IS NULL").run();
  }

  public close(): void {
    this.database.close();
  }

  public createSession(session: StoredSession): void {
    this.database
      .prepare("INSERT INTO sessions (id, provider, cwd, resume_id) VALUES (?, ?, ?, ?)")
      .run(session.id, session.provider, session.cwd, session.resumeId);
  }

  public session(id: string): StoredSession | undefined {
    // SAFETY: The query selects every StoredSession field from the schema-owned sessions table with the matching alias.
    const row = this.database
      .prepare("SELECT id, provider, cwd, resume_id AS resumeId FROM sessions WHERE id = ?")
      .get(id) as StoredSession | undefined;
    return row;
  }

  public setResumeId(sessionId: string, resumeId: string): void {
    this.database.prepare("UPDATE sessions SET resume_id = ? WHERE id = ?").run(resumeId, sessionId);
  }

  public append(sessionId: string, frame: SessionUpdateFrame): number {
    return this.database.transaction(() => {
      // SAFETY: The schema-owned sessions table declares next_seq as a non-null integer, aliased here as seq.
      const row = this.database.prepare("SELECT next_seq AS seq FROM sessions WHERE id = ?").get(sessionId) as
        | { seq: number }
        | undefined;
      if (!row) throw new Error("unknown session");
      this.database
        .prepare("INSERT INTO events (session_id, seq, frame) VALUES (?, ?, ?)")
        .run(sessionId, row.seq, JSON.stringify(frame));
      this.database.prepare("UPDATE sessions SET next_seq = next_seq + 1 WHERE id = ?").run(sessionId);
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

  public startTurn(id: string, sessionId: string): void {
    this.database.prepare("INSERT INTO turns (id, session_id) VALUES (?, ?)").run(id, sessionId);
  }

  public finishTurn(id: string, terminal: string): boolean {
    return this.database.prepare("UPDATE turns SET terminal = ? WHERE id = ? AND terminal IS NULL").run(terminal, id)
      .changes === 1;
  }

  public terminal(id: string): string | null | undefined {
    // SAFETY: The query projects the nullable terminal column from at most one schema-owned turn row.
    return (this.database.prepare("SELECT terminal FROM turns WHERE id = ?").get(id) as
      | { terminal: string | null }
      | undefined)?.terminal;
  }

  public addPermission(id: string, sessionId: string, request: RequestPermissionRequest): void {
    this.database
      .prepare("INSERT INTO permissions (id, session_id, request) VALUES (?, ?, ?)")
      .run(id, sessionId, JSON.stringify(request));
  }

  public answerPermission(id: string, response: RequestPermissionResponse): boolean {
    return this.database
      .prepare("UPDATE permissions SET response = ? WHERE id = ? AND response IS NULL")
      .run(JSON.stringify(response), id).changes === 1;
  }

  public pendingPermissions(sessionId: string): Array<{ id: string; request: string }> {
    // SAFETY: The query projects the non-null id and request text columns from schema-owned permission rows.
    return this.database
      .prepare("SELECT id, request FROM permissions WHERE session_id = ? AND response IS NULL ORDER BY rowid")
      .all(sessionId) as Array<{ id: string; request: string }>;
  }

  public sequences(sessionId: string): number[] {
    // SAFETY: The query projects the integer seq column from schema-owned event rows.
    return (
      this.database.prepare("SELECT seq FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as Array<{
        seq: number;
      }>
    ).map(({ seq }) => seq);
  }

  public terminals(sessionId: string): string[] {
    // SAFETY: The WHERE clause excludes null terminals before projecting schema-owned turn rows.
    return (
      this.database.prepare("SELECT terminal FROM turns WHERE session_id = ? ORDER BY rowid").all(sessionId) as Array<{
        terminal: string;
      }>
    ).map(({ terminal }) => terminal);
  }

  public answeredPermissions(sessionId: string): number {
    // SAFETY: COUNT(*) always produces one row with an integer count value.
    return (
      this.database
        .prepare("SELECT count(*) AS count FROM permissions WHERE session_id = ? AND response IS NOT NULL")
        .get(sessionId) as { count: number }
    ).count;
  }
}
