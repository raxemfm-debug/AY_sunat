import type { Pool, QueryResultRow } from "pg";
import type { CreateSessionRecord, ISessionRepository, SessionRecord } from "../repositories/session.repository.js";
import { isoTimestamp, isUuid, optional } from "./pg-utils.js";

interface SessionRow extends QueryResultRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

const COLUMNS = `s.id::text AS id, s.user_id::text AS user_id, ${isoTimestamp("s.created_at")} AS created_at,
  ${isoTimestamp("s.expires_at")} AS expires_at, ${isoTimestamp("s.revoked_at")} AS revoked_at`;

const TOKEN_HASH = /^[0-9a-f]{64}$/;

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: optional(row.revoked_at),
  };
}

export class PostgresSessionRepository implements ISessionRepository {
  constructor(private readonly pool: Pool) {}

  async create(record: CreateSessionRecord): Promise<SessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO private.user_sessions AS s (user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
      [record.userId, record.tokenHash, record.createdAt, record.expiresAt],
    );
    return toRecord(result.rows[0]);
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    if (!TOKEN_HASH.test(tokenHash)) return null;
    const result = await this.pool.query<SessionRow>(
      `SELECT ${COLUMNS} FROM private.user_sessions s
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [tokenHash, now],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    if (!TOKEN_HASH.test(tokenHash)) return;
    await this.pool.query(
      `UPDATE private.user_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash, now],
    );
  }

  async revokeAllForUser(userId: string, now: Date, exceptTokenHash?: string): Promise<number> {
    if (!isUuid(userId)) return 0;
    const result = await this.pool.query(
      `UPDATE private.user_sessions SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR token_hash <> $3)`,
      [userId, now, exceptTokenHash ?? null],
    );
    return result.rowCount ?? 0;
  }

  async deleteExpired(before: Date): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM private.user_sessions WHERE expires_at < $1 OR revoked_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }
}
