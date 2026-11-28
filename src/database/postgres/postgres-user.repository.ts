import type { Pool, QueryResultRow } from "pg";
import { assertMembershipChange, CompanyRole } from "../../modules/auth/permissions.js";
import {
  CompanyMembership,
  CreateUserRecord,
  DuplicateUserError,
  MembershipChange,
  MembershipEvent,
  PublicUser,
  UpdateUserRecord,
  UserNotFoundError,
  UserWithCredentials,
} from "../../modules/auth/types.js";
import type { IUserRepository, MemberWithUser } from "../repositories/user.repository.js";
import { isoTimestamp, isUniqueViolation, isUuid, optional, withTransaction } from "./pg-utils.js";

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MembershipRow extends QueryResultRow {
  company_id: string;
  user_id: string;
  role: CompanyRole;
  granted_by: string | null;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = `u.id::text AS id, u.email, u.full_name, u.password_hash, u.is_active,
  ${isoTimestamp("u.last_login_at")} AS last_login_at, ${isoTimestamp("u.created_at")} AS created_at,
  ${isoTimestamp("u.updated_at")} AS updated_at`;

const MEMBERSHIP_COLUMNS = `m.company_id::text AS company_id, m.user_id::text AS user_id, m.role,
  m.granted_by::text AS granted_by, ${isoTimestamp("m.created_at")} AS created_at, ${isoTimestamp("m.updated_at")} AS updated_at`;

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    isActive: row.is_active,
    lastLoginAt: optional(row.last_login_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMembership(row: MembershipRow): CompanyMembership {
  return {
    companyId: row.company_id,
    userId: row.user_id,
    role: row.role,
    grantedBy: optional(row.granted_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly pool: Pool) {}

  async createUser(record: CreateUserRecord): Promise<PublicUser> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO private.app_users AS u (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
        [record.email, record.fullName, record.passwordHash],
      );
      return toPublic(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error, "uq_app_users_email")) throw new DuplicateUserError(record.email);
      throw error;
    }
  }

  async findById(id: string): Promise<PublicUser | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM private.app_users u WHERE u.id = $1`, [id]);
    return result.rows[0] ? toPublic(result.rows[0]) : null;
  }

  async findCredentialsByEmail(email: string): Promise<UserWithCredentials | null> {
    const result = await this.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM private.app_users u WHERE u.email = $1`, [email]);
    const row = result.rows[0];
    return row ? { ...toPublic(row), passwordHash: row.password_hash } : null;
  }

  async updateUser(id: string, updates: UpdateUserRecord): Promise<PublicUser> {
    if (!isUuid(id)) throw new UserNotFoundError(id);
    const result = await this.pool.query<UserRow>(
      `UPDATE private.app_users AS u SET
         full_name = COALESCE($2, u.full_name),
         is_active = COALESCE($3, u.is_active),
         password_hash = COALESCE($4, u.password_hash),
         updated_at = NOW()
       WHERE u.id = $1 RETURNING ${USER_COLUMNS}`,
      [id, updates.fullName ?? null, updates.isActive ?? null, updates.passwordHash ?? null],
    );
    if (!result.rows[0]) throw new UserNotFoundError(id);
    return toPublic(result.rows[0]);
  }

  async recordLogin(id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.pool.query(`UPDATE private.app_users SET last_login_at = NOW() WHERE id = $1`, [id]);
  }

  async getMembership(companyId: string, userId: string): Promise<CompanyMembership | null> {
    if (!isUuid(companyId) || !isUuid(userId)) return null;
    const result = await this.pool.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM private.company_memberships m WHERE m.company_id = $1 AND m.user_id = $2`,
      [companyId, userId],
    );
    return result.rows[0] ? toMembership(result.rows[0]) : null;
  }

  async listMembershipsByUser(userId: string): Promise<CompanyMembership[]> {
    if (!isUuid(userId)) return [];
    const result = await this.pool.query<MembershipRow>(
      `SELECT ${MEMBERSHIP_COLUMNS} FROM private.company_memberships m WHERE m.user_id = $1 ORDER BY m.created_at`,
      [userId],
    );
    return result.rows.map(toMembership);
  }

  async listMembersByCompany(companyId: string): Promise<MemberWithUser[]> {
    if (!isUuid(companyId)) return [];
    const result = await this.pool.query<MembershipRow & {
      u_email: string; u_full_name: string; u_is_active: boolean; u_last_login_at: string | null;
      u_created_at: string; u_updated_at: string;
    }>(
      `SELECT ${MEMBERSHIP_COLUMNS}, u.email AS u_email, u.full_name AS u_full_name, u.is_active AS u_is_active,
              ${isoTimestamp("u.last_login_at")} AS u_last_login_at, ${isoTimestamp("u.created_at")} AS u_created_at,
              ${isoTimestamp("u.updated_at")} AS u_updated_at
         FROM private.company_memberships m JOIN private.app_users u ON u.id = m.user_id
        WHERE m.company_id = $1 ORDER BY u.email`,
      [companyId],
    );
    return result.rows.map((row) => ({
      ...toMembership(row),
      user: {
        id: row.user_id,
        email: row.u_email,
        fullName: row.u_full_name,
        isActive: row.u_is_active,
        lastLoginAt: optional(row.u_last_login_at),
        createdAt: row.u_created_at,
        updatedAt: row.u_updated_at,
      },
    }));
  }

  async listMembershipEvents(companyId: string): Promise<MembershipEvent[]> {
    if (!isUuid(companyId)) return [];
    const result = await this.pool.query<{
      company_id: string; user_id: string; actor_user_id: string | null;
      previous_role: CompanyRole | null; new_role: CompanyRole | null; created_at: string;
    }>(
      `SELECT company_id::text, user_id::text, actor_user_id::text, previous_role, new_role,
              ${isoTimestamp("created_at")} AS created_at
         FROM private.company_membership_events WHERE company_id = $1 ORDER BY id`,
      [companyId],
    );
    return result.rows.map((row) => ({
      companyId: row.company_id,
      userId: row.user_id,
      actorUserId: optional(row.actor_user_id),
      previousRole: row.previous_role,
      newRole: row.new_role,
      createdAt: row.created_at,
    }));
  }

  async applyMembershipChange(change: MembershipChange): Promise<CompanyMembership | null> {
    if (!isUuid(change.companyId)) throw new Error(`Empresa con ID ${change.companyId} no encontrada.`);
    if (!isUuid(change.targetUserId)) throw new UserNotFoundError(change.targetUserId);

    return withTransaction(this.pool, async (client) => {
      // Bloquear la fila de la empresa serializa todos los cambios de miembros de esa empresa.
      const company = await client.query(`SELECT 1 FROM public.companies WHERE id = $1 FOR UPDATE`, [change.companyId]);
      if (company.rowCount === 0) throw new Error(`Empresa con ID ${change.companyId} no encontrada.`);
      const target = await client.query(`SELECT 1 FROM private.app_users WHERE id = $1`, [change.targetUserId]);
      if (target.rowCount === 0) throw new UserNotFoundError(change.targetUserId);

      const members = await client.query<{ user_id: string; role: CompanyRole; is_active: boolean }>(
        `SELECT m.user_id::text AS user_id, m.role, u.is_active
           FROM private.company_memberships m JOIN private.app_users u ON u.id = m.user_id
          WHERE m.company_id = $1`,
        [change.companyId],
      );
      const actor = change.actorUserId ? members.rows.find((m) => m.user_id === change.actorUserId && m.is_active) : undefined;
      const current = members.rows.find((m) => m.user_id === change.targetUserId);

      assertMembershipChange({
        isSystem: change.actorUserId === null,
        actorRole: actor?.role,
        isSelf: change.actorUserId === change.targetUserId,
        currentRole: current?.role ?? null,
        newRole: change.newRole,
        ownerCount: members.rows.filter((m) => m.role === "OWNER").length,
      });

      await client.query(
        `INSERT INTO private.company_membership_events (company_id, user_id, actor_user_id, previous_role, new_role)
         VALUES ($1, $2, $3, $4, $5)`,
        [change.companyId, change.targetUserId, change.actorUserId, current?.role ?? null, change.newRole],
      );

      if (change.newRole === null) {
        await client.query(`DELETE FROM private.company_memberships WHERE company_id = $1 AND user_id = $2`, [
          change.companyId,
          change.targetUserId,
        ]);
        return null;
      }
      const saved = await client.query<MembershipRow>(
        `INSERT INTO private.company_memberships AS m (company_id, user_id, role, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = NOW()
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [change.companyId, change.targetUserId, change.newRole, change.actorUserId],
      );
      return toMembership(saved.rows[0]);
    });
  }
}
