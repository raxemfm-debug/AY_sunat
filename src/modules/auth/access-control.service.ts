import type { IUserRepository, MemberWithUser } from "../../database/repositories/user.repository.js";
import { CompanyRole, Permission, permissionsForRole, roleHasPermission } from "./permissions.js";
import { getDummyPasswordHash, hashPassword, validatePasswordStrength, verifyPassword } from "./password.js";
import { AccessDeniedError, CompanyMembership, MembershipEvent, PublicUser, UserNotFoundError } from "./types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") throw new Error("El correo es obligatorio.");
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) throw new Error("El correo no tiene un formato válido.");
  return normalized;
}

function normalizeName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length < 2) throw new Error("El nombre debe tener al menos 2 caracteres.");
  const trimmed = name.trim();
  if (trimmed.length > 200) throw new Error("El nombre no puede superar 200 caracteres.");
  return trimmed;
}

export interface RegisterUserInput {
  email: string;
  fullName: string;
  password: string;
}

export interface CompanyAccess {
  companyId: string;
  role: CompanyRole;
  permissions: Permission[];
}

/**
 * Usuarios, credenciales y permisos por empresa. Toda decisión de acceso pasa por aquí;
 * las rutas HTTP solo deben llamar a authorize()/can() con el usuario autenticado.
 */
export class AccessControlService {
  constructor(private readonly users: IUserRepository) {}

  async registerUser(input: RegisterUserInput): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const fullName = normalizeName(input.fullName);
    const errors = validatePasswordStrength(input.password);
    if (errors.length > 0) throw new Error(errors.join(" "));
    return this.users.createUser({ email, fullName, passwordHash: await hashPassword(input.password) });
  }

  /**
   * Devuelve el usuario si el correo y la contraseña son correctos y la cuenta está activa.
   * Gasta el mismo tiempo cuando el correo no existe, para no revelar qué cuentas hay.
   */
  async verifyCredentials(email: unknown, password: unknown): Promise<PublicUser | null> {
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch {
      return null;
    }
    const user = await this.users.findCredentialsByEmail(normalized);
    const valid = await verifyPassword(typeof password === "string" ? password : "", user?.passwordHash ?? (await getDummyPasswordHash()));
    if (!user || !valid || !user.isActive) return null;
    await this.users.recordLogin(user.id);
    const { passwordHash: _hash, ...publicUser } = user;
    return publicUser;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new UserNotFoundError(userId);
    const credentials = await this.users.findCredentialsByEmail(user.email);
    if (!credentials || !(await verifyPassword(currentPassword, credentials.passwordHash))) {
      throw new AccessDeniedError("La contraseña actual no es correcta.");
    }
    await this.users.updateUser(userId, { passwordHash: await hashPassword(newPassword) });
  }

  async deactivateUser(userId: string): Promise<PublicUser> {
    return this.users.updateUser(userId, { isActive: false });
  }

  getUser(userId: string): Promise<PublicUser | null> {
    return this.users.findById(userId);
  }

  /** Rol efectivo del usuario en la empresa; null si no es miembro o su cuenta está inactiva. */
  async getRole(userId: string, companyId: string): Promise<CompanyRole | null> {
    const [user, membership] = await Promise.all([this.users.findById(userId), this.users.getMembership(companyId, userId)]);
    if (!user?.isActive || !membership) return null;
    return membership.role;
  }

  async can(userId: string, companyId: string, permission: Permission): Promise<boolean> {
    const role = await this.getRole(userId, companyId);
    return role !== null && roleHasPermission(role, permission);
  }

  /** Lanza AccessDeniedError si el usuario no tiene el permiso en esa empresa. */
  async authorize(userId: string, companyId: string, permission: Permission): Promise<CompanyRole> {
    const role = await this.getRole(userId, companyId);
    if (role === null || !roleHasPermission(role, permission)) throw new AccessDeniedError();
    return role;
  }

  /** Empresas a las que el usuario tiene acceso, con sus permisos. */
  async listAccessibleCompanies(userId: string): Promise<CompanyAccess[]> {
    const user = await this.users.findById(userId);
    if (!user?.isActive) return [];
    const memberships = await this.users.listMembershipsByUser(userId);
    return memberships.map((m) => ({ companyId: m.companyId, role: m.role, permissions: permissionsForRole(m.role) }));
  }

  /** Asigna el primer titular al crear una empresa. Falla si la empresa ya tiene titular. */
  assignInitialOwner(companyId: string, userId: string): Promise<CompanyMembership> {
    return this.users
      .applyMembershipChange({ companyId, targetUserId: userId, newRole: "OWNER", actorUserId: null })
      .then((m) => m!);
  }

  /** Alta o cambio de rol hecho por un miembro con permiso members:manage. */
  async setMemberRole(actorUserId: string, companyId: string, targetUserId: string, role: CompanyRole): Promise<CompanyMembership> {
    return (await this.users.applyMembershipChange({ companyId, targetUserId, newRole: role, actorUserId }))!;
  }

  async removeMember(actorUserId: string, companyId: string, targetUserId: string): Promise<void> {
    await this.users.applyMembershipChange({ companyId, targetUserId, newRole: null, actorUserId });
  }

  async listMembers(actorUserId: string, companyId: string): Promise<MemberWithUser[]> {
    await this.authorize(actorUserId, companyId, "members:read");
    return this.users.listMembersByCompany(companyId);
  }

  async listMembershipHistory(actorUserId: string, companyId: string): Promise<MembershipEvent[]> {
    await this.authorize(actorUserId, companyId, "members:read");
    return this.users.listMembershipEvents(companyId);
  }
}
