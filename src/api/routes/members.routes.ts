import type { MemberWithUser } from "../../database/repositories/user.repository.js";
import { COMPANY_ROLES, ROLE_LABELS } from "../../modules/auth/permissions.js";
import type { ApiServices } from "../app-services.js";
import { currentUser, requireCompanyAccess } from "../http/access.js";
import { ApiError, readJson, requiredEnum, requiredString, sendJson } from "../http/http-utils.js";
import type { Router } from "../http/router.js";

function toPublicMember(member: MemberWithUser) {
  return {
    userId: member.userId,
    email: member.user.email,
    fullName: member.user.fullName,
    isActive: member.user.isActive,
    role: member.role,
    roleLabel: ROLE_LABELS[member.role],
    grantedBy: member.grantedBy ?? null,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

export function registerMemberRoutes(router: Router, services: ApiServices): void {
  router.on("GET", "/api/companies/:companyId/members", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "members:read");
    const members = await services.access.listMembers(currentUser(user).id, params.companyId);
    sendJson(response, 200, { data: members.map(toPublicMember) });
  });

  router.on("GET", "/api/companies/:companyId/members/events", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "members:read");
    sendJson(response, 200, { data: await services.access.listMembershipHistory(currentUser(user).id, params.companyId) });
  });

  /** Agrega a una empresa a un usuario que ya tiene cuenta, identificado por su correo. */
  router.on("POST", "/api/companies/:companyId/members", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "members:manage");
    const body = await readJson(request);
    const role = requiredEnum(body, "role", COMPANY_ROLES);
    const target = await services.access.findUserByEmail(requiredString(body, "email", 254));
    if (!target) throw new ApiError(404, "USER_NOT_FOUND", "No existe una cuenta con ese correo.");
    if (await isMember(services, params.companyId, target.id)) {
      throw new ApiError(409, "ALREADY_MEMBER", "El usuario ya pertenece a la empresa; cambia su rol en su lugar.");
    }
    const membership = await services.access.setMemberRole(currentUser(user).id, params.companyId, target.id, role);
    sendJson(response, 201, { userId: target.id, email: target.email, role: membership.role, roleLabel: ROLE_LABELS[membership.role] });
  });

  router.on("PATCH", "/api/companies/:companyId/members/:userId", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "members:manage");
    if (!(await isMember(services, params.companyId, params.userId))) {
      throw new ApiError(404, "MEMBER_NOT_FOUND", "El usuario no pertenece a la empresa.");
    }
    const body = await readJson(request);
    const role = requiredEnum(body, "role", COMPANY_ROLES);
    const membership = await services.access.setMemberRole(currentUser(user).id, params.companyId, params.userId, role);
    sendJson(response, 200, { userId: params.userId, role: membership.role, roleLabel: ROLE_LABELS[membership.role] });
  });

  /** Quita a un miembro. Cualquier miembro puede retirarse a sí mismo (salvo el último titular). */
  router.on("DELETE", "/api/companies/:companyId/members/:userId", async ({ response, params, user }) => {
    const actor = currentUser(user);
    const self = actor.id === params.userId;
    await requireCompanyAccess(services, user, params.companyId, self ? "company:read" : "members:manage");
    if (!self && !(await isMember(services, params.companyId, params.userId))) {
      throw new ApiError(404, "MEMBER_NOT_FOUND", "El usuario no pertenece a la empresa.");
    }
    await services.access.removeMember(actor.id, params.companyId, params.userId);
    sendJson(response, 200, { status: "ok" });
  });
}

/** Miembro aunque su cuenta esté desactivada (getRole devuelve null en ese caso). */
function isMember(services: ApiServices, companyId: string, userId: string): Promise<boolean> {
  return services.access.isMember(companyId, userId);
}
