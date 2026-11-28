import type { ApiServices } from "../app-services.js";
import { currentUser } from "../http/access.js";
import { ApiError, readJson, requiredString, sendJson } from "../http/http-utils.js";
import type { Router } from "../http/router.js";
import { ROLE_LABELS } from "../../modules/auth/permissions.js";

const INVALID_CREDENTIALS = new ApiError(401, "INVALID_CREDENTIALS", "Correo o contraseña incorrectos.");

export function registerAuthRoutes(router: Router, services: ApiServices): void {
  router.on("POST", "/api/auth/register", async ({ request, response }) => {
    if (!services.authSettings.allowSignup) {
      throw new ApiError(403, "SIGNUP_DISABLED", "El registro libre de usuarios está desactivado en este servidor.");
    }
    const body = await readJson(request);
    const user = await services.access.registerUser({
      email: requiredString(body, "email", 254),
      fullName: requiredString(body, "fullName", 200),
      password: typeof body.password === "string" ? body.password : "",
    });
    sendJson(response, 201, { user });
  }, { public: true });

  router.on("POST", "/api/auth/login", async ({ request, response }) => {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
    const ip = request.socket.remoteAddress ?? "desconocida";
    const throttle = services.loginThrottle;

    const wait = throttle.retryAfterSeconds(email, ip);
    if (wait > 0) {
      sendJson(
        response,
        429,
        { error: { code: "TOO_MANY_ATTEMPTS", message: "Demasiados intentos fallidos. Vuelve a intentarlo más tarde." } },
        { "retry-after": String(wait) },
      );
      return;
    }

    const session = await services.sessions.login(body.email, body.password);
    if (!session) {
      throttle.recordFailure(email, ip);
      throw INVALID_CREDENTIALS;
    }
    throttle.recordSuccess(email);
    sendJson(response, 200, { token: session.token, tokenType: "Bearer", expiresAt: session.expiresAt, user: session.user });
  }, { public: true });

  router.on("POST", "/api/auth/logout", async ({ response, sessionTokenHash }) => {
    if (sessionTokenHash) await services.sessions.logout(sessionTokenHash);
    sendJson(response, 200, { status: "ok" });
  });

  router.on("GET", "/api/auth/me", async ({ response, user }) => {
    const actor = currentUser(user);
    const access = await services.access.listAccessibleCompanies(actor.id);
    const companies = [];
    for (const item of access) {
      const company = await services.companies.findById(item.companyId);
      if (!company) continue;
      companies.push({
        companyId: item.companyId,
        ruc: company.ruc,
        legalName: company.legalName,
        role: item.role,
        roleLabel: ROLE_LABELS[item.role],
        permissions: item.permissions,
      });
    }
    sendJson(response, 200, { user: actor, companies });
  });

  router.on("POST", "/api/auth/password", async ({ request, response, user, sessionTokenHash }) => {
    const actor = currentUser(user);
    const body = await readJson(request);
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    await services.access.changePassword(actor.id, currentPassword, newPassword);
    // Las demás sesiones quedan cerradas: si alguien tenía la contraseña anterior, pierde el acceso.
    const revokedSessions = await services.sessions.revokeOtherSessions(actor.id, sessionTokenHash ?? "");
    sendJson(response, 200, { status: "ok", revokedSessions });
  });
}
