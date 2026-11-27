import { timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server } from "node:http";
import type { AnnualCloseApplication } from "./accounting/annual-close.application.js";
import type { ApiServices } from "./app-services.js";
import { ApiError, sendJson, toApiError } from "./http/http-utils.js";
import { Router } from "./http/router.js";
import { registerAccountingRoutes } from "./routes/accounting.routes.js";
import { registerAnnualCloseRoutes } from "./routes/annual-close.routes.js";
import { registerCompanyRoutes } from "./routes/companies.routes.js";
import { registerCpeRoutes } from "./routes/cpe.routes.js";
import { registerPurchaseRoutes } from "./routes/purchases.routes.js";

function assertBearerToken(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization ?? "";
  const supplied = value.startsWith("Bearer ") ? Buffer.from(value.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

export interface ApiServerOptions {
  /** Cierre anual (rutas existentes /api/accounting/annual-close/*). */
  application?: AnnualCloseApplication;
  /** Empresas, emisión, compras y contabilidad persistentes. */
  services?: ApiServices;
  host: string;
  bearerToken?: string;
  /** Registro de errores internos; por defecto stderr. Nunca recibe cuerpos de solicitud. */
  logError?: (error: unknown, context: { method?: string; path: string }) => void;
}

export function createApiServer(input: ApiServerOptions): Server {
  if (!isLoopback(input.host) && !input.bearerToken) {
    throw new Error("API_BEARER_TOKEN es obligatorio si la API escucha fuera de loopback.");
  }

  const router = new Router();
  if (input.application) registerAnnualCloseRoutes(router, input.application);
  if (input.services) {
    registerCompanyRoutes(router, input.services);
    registerCpeRoutes(router, input.services);
    registerPurchaseRoutes(router, input.services);
    registerAccountingRoutes(router, input.services);
  }
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

    if (input.bearerToken && !assertBearerToken(request, input.bearerToken)) {
      sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Autenticación requerida." } });
      return;
    }

    try {
      const matched = router.match(request.method ?? "GET", path);
      if (!matched) throw new ApiError(404, "NOT_FOUND", "Ruta no encontrada.");
      await matched.handler({ request, response, params: matched.params, query: url.searchParams });
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
