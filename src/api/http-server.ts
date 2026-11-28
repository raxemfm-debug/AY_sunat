import { createServer, IncomingMessage, Server } from "node:http";
import type { AnnualCloseApplication } from "./accounting/annual-close.application.js";
import type { ApiServices } from "./app-services.js";
import { sendJson, toApiError } from "./http/http-utils.js";
import { Router } from "./http/router.js";
import { registerAccountingRoutes } from "./routes/accounting.routes.js";
import { registerAnnualCloseRoutes } from "./routes/annual-close.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerCompanyRoutes } from "./routes/companies.routes.js";
import { registerCpeRoutes } from "./routes/cpe.routes.js";
import { registerMemberRoutes } from "./routes/members.routes.js";
import { registerPurchaseRoutes } from "./routes/purchases.routes.js";

export function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : undefined;
}

export interface ApiServerOptions {
  /** Cierre anual (rutas existentes /api/accounting/annual-close/*). */
  application?: AnnualCloseApplication;
  /** Empresas, emisión, compras, contabilidad, usuarios y sesiones. */
  services: ApiServices;
  host: string;
  /** Registro de errores internos; por defecto stderr. Nunca recibe cuerpos de solicitud. */
  logError?: (error: unknown, context: { method?: string; path: string }) => void;
}

const UNAUTHORIZED = { error: { code: "UNAUTHORIZED", message: "Autenticación requerida." } };

/**
 * Toda ruta /api exige una sesión de usuario (`Authorization: Bearer <token>`), salvo
 * las marcadas como públicas (inicio de sesión y registro). Sin sesión, cualquier ruta
 * (exista o no) responde 401, para no revelar qué rutas hay.
 */
export function createApiServer(input: ApiServerOptions): Server {
  const { services } = input;
  const router = new Router();
  registerAuthRoutes(router, services);
  registerCompanyRoutes(router, services);
  registerMemberRoutes(router, services);
  registerCpeRoutes(router, services);
  registerPurchaseRoutes(router, services);
  registerAccountingRoutes(router, services);
  if (input.application) registerAnnualCloseRoutes(router, input.application, services);

  const logError = input.logError ?? ((error, context) => {
    console.error(`[api] ${context.method} ${context.path}`, error);
  });

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    try {
      const matched = router.match(request.method ?? "GET", path);
      const isPublic = matched.kind === "found" && matched.public;
      let session = null;
      if (!isPublic) {
        session = await services.sessions.authenticate(bearerToken(request));
        if (!session) {
          sendJson(response, 401, UNAUTHORIZED, { "www-authenticate": 'Bearer realm="aysunat"' });
          return;
        }
      }
      if (matched.kind === "not_found") {
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Ruta no encontrada." } });
        return;
      }
      if (matched.kind === "method_not_allowed") {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Método no permitido para esta ruta." } });
        return;
      }
      await matched.handler({
        request,
        response,
        params: matched.params,
        query: url.searchParams,
        user: session?.user,
        sessionTokenHash: session?.tokenHash,
      });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError) {
        sendJson(response, apiError.statusCode, { error: { code: apiError.code, message: apiError.message } });
        return;
      }
      logError(error, { method: request.method, path });
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor." } });
    }
  });
}
