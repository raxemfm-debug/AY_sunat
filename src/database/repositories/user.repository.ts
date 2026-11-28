import { randomUUID } from "node:crypto";
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

export interface MemberWithUser extends CompanyMembership {
  user: PublicUser;
}

export interface IUserRepository {
  createUser(record: CreateUserRecord): Promise<PublicUser>;
  findById(id: string): Promise<PublicUser | null>;
  /** Incluye el hash: usar solo para verificar credenciales. */
  findCredentialsByEmail(email: string): Promise<UserWithCredentials | null>;
  updateUser(id: string, updates: UpdateUserRecord): Promise<PublicUser>;
  recordLogin(id: string): Promise<void>;

  getMembership(companyId: string, userId: string): Promise<CompanyMembership | null>;
  listMembershipsByUser(userId: string): Promise<CompanyMembership[]>;
  listMembersByCompany(companyId: string): Promise<MemberWithUser[]>;
  listMembershipEvents(companyId: string): Promise<MembershipEvent[]>;
  /**
   * Aplica un alta, cambio de rol o baja de forma atómica: evalúa las reglas
   * (assertMembershipChange) con los miembros de la empresa bloqueados y registra el evento.
   * Devuelve la membresía resultante o null si fue una baja.
   */
  applyMembershipChange(change: MembershipChange): Promise<CompanyMembership | null>;
}

const now = () => new Date().toISOString();
const toPublic = ({ passwordHash: _hash, ...user }: UserWithCredentials): PublicUser => ({ ...user });

export class MemoryUserRepository implements IUserRepository {
  private users = new Map<string, UserWithCredentials>();
  private memberships = new Map<string, CompanyMembership>();
  private events: MembershipEvent[] = [];

  constructor(private readonly companyExists: (companyId: string) => Promise<boolean> = async () => true) {}

  private key(companyId: string, userId: string) {
    return `${companyId}:${userId}`;
  }

  async createUser(record: CreateUserRecord): Promise<PublicUser> {
    if ([...this.users.values()].some((u) => u.email === record.email)) throw new DuplicateUserError(record.email);
    const timestamp = now();
    const user: UserWithCredentials = {
      id: randomUUID(),
      email: record.email,
      fullName: record.fullName,
      passwordHash: record.passwordHash,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.users.set(user.id, user);
    return toPublic(user);
  }

  async findById(id: string): Promise<PublicUser | null> {
    const user = this.users.get(id);
    return user ? toPublic(user) : null;
  }

  async findCredentialsByEmail(email: string): Promise<UserWithCredentials | null> {
    const user = [...this.users.values()].find((u) => u.email === email);
    return user ? { ...user } : null;
  }

  async updateUser(id: string, updates: UpdateUserRecord): Promise<PublicUser> {
    const user = this.users.get(id);
    if (!user) throw new UserNotFoundError(id);
    const next: UserWithCredentials = { ...user, updatedAt: now() };
    if (updates.fullName !== undefined) next.fullName = updates.fullName;
    if (updates.isActive !== undefined) next.isActive = updates.isActive;
    if (updates.passwordHash !== undefined) next.passwordHash = updates.passwordHash;
    this.users.set(id, next);
    return toPublic(next);
  }

  async recordLogin(id: string): Promise<void> {
    const user = this.users.get(id);
    if (user) this.users.set(id, { ...user, lastLoginAt: now() });
  }

  async getMembership(companyId: string, userId: string): Promise<CompanyMembership | null> {
    const membership = this.memberships.get(this.key(companyId, userId));
    return membership ? { ...membership } : null;
  }

  async listMembershipsByUser(userId: string): Promise<CompanyMembership[]> {
    return [...this.memberships.values()].filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }

  async listMembersByCompany(companyId: string): Promise<MemberWithUser[]> {
    return [...this.memberships.values()]
      .filter((m) => m.companyId === companyId)
      .map((m) => ({ ...m, user: toPublic(this.users.get(m.userId)!) }))
      .sort((a, b) => a.user.email.localeCompare(b.user.email));
  }

  async listMembershipEvents(companyId: string): Promise<MembershipEvent[]> {
    return this.events.filter((e) => e.companyId === companyId).map((e) => ({ ...e }));
  }

  async applyMembershipChange(change: MembershipChange): Promise<CompanyMembership | null> {
    // Sin await entre la lectura y la escritura: en memoria esto ya es atómico.
    const exists = await this.companyExists(change.companyId);
    if (!exists) throw new Error(`Empresa con ID ${change.companyId} no encontrada.`);
    const target = this.users.get(change.targetUserId);
    if (!target) throw new UserNotFoundError(change.targetUserId);

    const members = [...this.memberships.values()].filter((m) => m.companyId === change.companyId);
    const actor = change.actorUserId ? this.users.get(change.actorUserId) : undefined;
    const actorMembership = actor?.isActive ? members.find((m) => m.userId === actor.id) : undefined;
    const current = members.find((m) => m.userId === change.targetUserId) ?? null;

    assertMembershipChange({
      isSystem: change.actorUserId === null,
      actorRole: actorMembership?.role,
      isSelf: change.actorUserId === change.targetUserId,
      currentRole: current?.role ?? null,
      newRole: change.newRole,
      ownerCount: members.filter((m) => m.role === "OWNER").length,
    });

    const timestamp = now();
    this.events.push({
      companyId: change.companyId,
      userId: change.targetUserId,
      actorUserId: change.actorUserId ?? undefined,
      previousRole: current?.role ?? null,
      newRole: change.newRole,
      createdAt: timestamp,
    });
    const key = this.key(change.companyId, change.targetUserId);
    if (change.newRole === null) {
      this.memberships.delete(key);
      return null;
    }
    const membership: CompanyMembership = {
      companyId: change.companyId,
      userId: change.targetUserId,
      role: change.newRole as CompanyRole,
      grantedBy: change.actorUserId ?? undefined,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.memberships.set(key, membership);
    return { ...membership };
  }
}
