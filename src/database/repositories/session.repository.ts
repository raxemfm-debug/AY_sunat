import { randomUUID } from "node:crypto";

/** Sesión guardada. El token en claro nunca se almacena: solo su hash SHA-256. */
export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface CreateSessionRecord {
  userId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ISessionRepository {
  create(record: CreateSessionRecord): Promise<SessionRecord>;
  /** Sesión vigente (no revocada ni vencida en `now`) para ese hash, o null. */
  findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  revokeByTokenHash(tokenHash: string, now: Date): Promise<void>;
  /** Revoca todas las sesiones vigentes del usuario, salvo la indicada. Devuelve cuántas revocó. */
  revokeAllForUser(userId: string, now: Date, exceptTokenHash?: string): Promise<number>;
  /** Borra sesiones vencidas o revocadas antes de `before`. */
  deleteExpired(before: Date): Promise<number>;
}

interface StoredSession extends SessionRecord {
  tokenHash: string;
}

const publicRecord = ({ tokenHash: _hash, ...record }: StoredSession): SessionRecord => ({ ...record });

export class MemorySessionRepository implements ISessionRepository {
  private sessions = new Map<string, StoredSession>();

  async create(record: CreateSessionRecord): Promise<SessionRecord> {
    if (this.sessions.has(record.tokenHash)) throw new Error("Token de sesión repetido.");
    const session: StoredSession = {
      id: randomUUID(),
      userId: record.userId,
      tokenHash: record.tokenHash,
      createdAt: record.createdAt.toISOString(),
      expiresAt: record.expiresAt.toISOString(),
    };
    this.sessions.set(record.tokenHash, session);
    return publicRecord(session);
  }

  async findActiveByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= now.getTime()) return null;
    return publicRecord(session);
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = now.toISOString();
  }

  async revokeAllForUser(userId: string, now: Date, exceptTokenHash?: string): Promise<number> {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt && session.tokenHash !== exceptTokenHash) {
        session.revokedAt = now.toISOString();
        count++;
      }
    }
    return count;
  }

  async deleteExpired(before: Date): Promise<number> {
    let count = 0;
    for (const [hash, session] of this.sessions) {
      const revokedBefore = session.revokedAt && Date.parse(session.revokedAt) < before.getTime();
      if (revokedBefore || Date.parse(session.expiresAt) < before.getTime()) {
        this.sessions.delete(hash);
        count++;
      }
    }
    return count;
  }
}
