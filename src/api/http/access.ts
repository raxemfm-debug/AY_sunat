import type { CompanyEntity } from "../../database/repositories/types.js";
import { CompanyRole, Permission, roleHasPermission } from "../../modules/auth/permissions.js";
import type { PublicUser } from "../../modules/auth/types.js";
import type { ApiServices } from "../app-services.js";
import { ApiError } from "./http-utils.js";

export function currentUser(user: PublicUser | undefined): PublicUser {
  if (!user) throw new ApiError(401, "UNAUTHORIZED", "Autenticación requerida.");
  return user;
}

/** Identificador del usuario para campos de auditoría (closedBy, reopenedBy...). */
export function actorLabel(user: PublicUser): string {
  return user.email.length <= 200 ? user.email : user.id;
}

export interface CompanyAccessResult {
  company: CompanyEntity;
  role: CompanyRole;
}

/**
 * Punto único de autorización para rutas de empresa:
 * - Quien no es miembro recibe 404, igual que si la empresa no existiera (no se revela qué empresas hay).
 * - Un miembro sin el permiso recibe 403.
 */
export async function requireCompanyAccess(
  services: ApiServices,
  user: PublicUser | undefined,
  companyId: string,
  permission: Permission,
): Promise<CompanyAccessResult> {
  const actor = currentUser(user);
  const role = await services.access.getRole(actor.id, companyId);
  if (role === null) throw new ApiError(404, "COMPANY_NOT_FOUND", `Empresa con ID ${companyId} no encontrada.`);
  if (!roleHasPermission(role, permission)) {
    throw new ApiError(403, "FORBIDDEN", "Tu rol en esta empresa no permite esta acción.");
  }
  const company = await services.companies.findById(companyId);
  if (!company) throw new ApiError(404, "COMPANY_NOT_FOUND", `Empresa con ID ${companyId} no encontrada.`);
  return { company, role };
}
