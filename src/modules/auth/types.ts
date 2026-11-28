import type { CompanyRole } from "./permissions.js";

/** Usuario tal como puede salir del servidor: nunca incluye el hash de la contraseña. */
export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Solo para verificar credenciales dentro del servidor. */
export interface UserWithCredentials extends PublicUser {
  passwordHash: string;
}

export interface CreateUserRecord {
  email: string;
  fullName: string;
  passwordHash: string;
}

export interface UpdateUserRecord {
  fullName?: string;
  isActive?: boolean;
  passwordHash?: string;
}

export interface CompanyMembership {
  companyId: string;
  userId: string;
  role: CompanyRole;
  grantedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MembershipEvent {
  companyId: string;
  userId: string;
  actorUserId?: string;
  previousRole: CompanyRole | null;
  newRole: CompanyRole | null;
  createdAt: string;
}

export interface MembershipChange {
  companyId: string;
  targetUserId: string;
  /** Rol nuevo; null quita al usuario de la empresa. */
  newRole: CompanyRole | null;
  /** null solo para la operación de sistema que asigna el primer titular. */
  actorUserId: string | null;
}

export class DuplicateUserError extends Error {
  constructor(email: string) {
    super(`Ya existe un usuario con el correo ${email}.`);
    this.name = "DuplicateUserError";
  }
}

export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`Usuario ${id} no encontrado.`);
    this.name = "UserNotFoundError";
  }
}

export class AccessDeniedError extends Error {
  constructor(message = "No tienes permiso para realizar esta acción en la empresa.") {
    super(message);
    this.name = "AccessDeniedError";
  }
}
