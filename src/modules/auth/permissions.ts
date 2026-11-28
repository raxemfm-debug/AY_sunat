/**
 * Roles por empresa y la matriz de permisos. Un mismo usuario puede tener
 * roles distintos en empresas distintas.
 */
export const COMPANY_ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "BILLING", "VIEWER"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export const PERMISSIONS = [
  "company:read",
  "company:update",
  "members:read",
  "members:manage",
  "series:read",
  "series:create",
  "cpe:read",
  "cpe:emit",
  "cpe:send_sunat",
  "purchases:read",
  "purchases:write",
  "accounting:read",
  "accounting:write",
  "accounting:close_period",
  "accounting:reopen_period",
  "accounting:annual_close",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_LABELS: Record<CompanyRole, string> = {
  OWNER: "Titular",
  ADMIN: "Administrador",
  ACCOUNTANT: "Contador",
  BILLING: "Facturador",
  VIEWER: "Consulta",
};

const READ_ONLY: Permission[] = [
  "company:read",
  "series:read",
  "cpe:read",
  "purchases:read",
  "accounting:read",
];

const ROLE_PERMISSIONS: Record<CompanyRole, ReadonlySet<Permission>> = {
  OWNER: new Set(PERMISSIONS),
  ADMIN: new Set(PERMISSIONS),
  ACCOUNTANT: new Set<Permission>([
    ...READ_ONLY,
    "purchases:write",
    "accounting:write",
    "accounting:close_period",
    "accounting:reopen_period",
    "accounting:annual_close",
  ]),
  BILLING: new Set<Permission>(["company:read", "series:read", "cpe:read", "cpe:emit", "cpe:send_sunat"]),
  VIEWER: new Set<Permission>(READ_ONLY),
};

export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === "string" && (COMPANY_ROLES as readonly string[]).includes(value);
}

export function roleHasPermission(role: CompanyRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsForRole(role: CompanyRole): Permission[] {
  return PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].has(permission));
}

export class MembershipRuleError extends Error {
  constructor(
    public readonly code: "FORBIDDEN" | "LAST_OWNER" | "NOT_A_MEMBER" | "NO_CHANGE",
    message: string,
  ) {
    super(message);
    this.name = "MembershipRuleError";
  }
}

export interface MembershipChangeContext {
  /** null = operación del sistema (alta del primer titular al crear la empresa). */
  actorRole: CompanyRole | null | undefined;
  isSystem: boolean;
  isSelf: boolean;
  currentRole: CompanyRole | null;
  newRole: CompanyRole | null;
  ownerCount: number;
}

/**
 * Reglas de cambio de membresía, compartidas por los repositorios en memoria y PostgreSQL
 * (que las evalúan con las filas de la empresa bloqueadas):
 * - Solo quien tiene members:manage cambia miembros.
 * - Solo un OWNER otorga, modifica o quita el rol OWNER.
 * - Nadie puede ascenderse a sí mismo.
 * - La empresa nunca se queda sin OWNER.
 */
export function assertMembershipChange(ctx: MembershipChangeContext): void {
  if (ctx.currentRole === ctx.newRole) {
    throw new MembershipRuleError("NO_CHANGE", "El usuario ya tiene ese rol en la empresa.");
  }
  if (ctx.newRole === null && ctx.currentRole === null) {
    throw new MembershipRuleError("NOT_A_MEMBER", "El usuario no pertenece a la empresa.");
  }

  if (!ctx.isSystem) {
    const actor = ctx.actorRole;
    // Retirarse uno mismo de la empresa está permitido a cualquier miembro.
    const selfLeaving = ctx.isSelf && ctx.newRole === null && ctx.currentRole !== null;
    if (!selfLeaving) {
      if (!actor || !roleHasPermission(actor, "members:manage")) {
        throw new MembershipRuleError("FORBIDDEN", "No tienes permiso para administrar los miembros de esta empresa.");
      }
      const touchesOwner = ctx.currentRole === "OWNER" || ctx.newRole === "OWNER";
      if (touchesOwner && actor !== "OWNER") {
        throw new MembershipRuleError("FORBIDDEN", "Solo un titular puede otorgar, cambiar o quitar el rol de titular.");
      }
      if (ctx.isSelf && ctx.newRole !== null && rank(ctx.newRole) < rank(ctx.currentRole)) {
        throw new MembershipRuleError("FORBIDDEN", "No puedes aumentar tu propio rol.");
      }
    }
  } else if (ctx.newRole !== "OWNER" || ctx.ownerCount > 0) {
    throw new MembershipRuleError("FORBIDDEN", "El sistema solo puede asignar el primer titular de una empresa.");
  }

  const losesOwner = ctx.currentRole === "OWNER" && ctx.newRole !== "OWNER";
  if (losesOwner && ctx.ownerCount <= 1) {
    throw new MembershipRuleError("LAST_OWNER", "La empresa debe conservar al menos un titular.");
  }
}

/** Menor número = más privilegios. */
function rank(role: CompanyRole | null): number {
  return role === null ? COMPANY_ROLES.length : COMPANY_ROLES.indexOf(role);
}
