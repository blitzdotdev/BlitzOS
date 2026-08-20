import Database from "better-sqlite3";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { Provider } from "./types.js";
import type { ConnectionIdentity } from "./auth.js";

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
 * `Journal.append` only accepts journaled frames, so this one cannot be
 * persisted by accident and replayed hours after the session recovered. */
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
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        terminal TEXT
      );
      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        request TEXT NOT NULL,
        response TEXT,
        responded_by TEXT,
        responded_name TEXT
      );
      CREATE TABLE IF NOT EXISTS participants (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        membership_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
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
    const rawPermissionColumns = this.database.prepare("PRAGMA table_info(permissions)").all();
    // SAFETY: SQLite PRAGMA table_info rows always include the string column name used below.
    const permissionColumns = new Set((rawPermissionColumns as Array<{ name: string }>).map(({ name }) => name));
    if (!permissionColumns.has("responded_by")) {
      this.database.exec("ALTER TABLE permissions ADD COLUMN responded_by TEXT");
    }
    if (!permissionColumns.has("responded_name")) {
      this.database.exec("ALTER TABLE permissions ADD COLUMN responded_name TEXT");
    }
    this.database.prepare("UPDATE turns SET terminal = 'refusal' WHERE terminal IS NULL").run();
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

  public addParticipant(sessionId: string, identity: ConnectionIdentity, now = Date.now()): void {
    this.database.prepare(
      `INSERT INTO participants (session_id, user_id, membership_id, role, name, joined_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, user_id) DO UPDATE SET
         membership_id = excluded.membership_id, role = excluded.role,
         name = excluded.name, joined_at = excluded.joined_at`,
    ).run(sessionId, identity.userId, identity.membershipId, identity.role, identity.name ?? null, now);
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

  public answerPermission(id: string, response: RequestPermissionResponse, identity: ConnectionIdentity): boolean {
    return this.database
      .prepare("UPDATE permissions SET response = ?, responded_by = ?, responded_name = ? WHERE id = ? AND response IS NULL")
      .run(JSON.stringify(response), identity.userId, identity.name ?? null, id).changes === 1;
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
