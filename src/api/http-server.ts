import { timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import {
  AnnualCloseApplication,
  AnnualCloseApplicationError,
  ConfirmAnnualCloseInput,
} from "./accounting/annual-close.application.js";

const MAX_BODY_BYTES = 32 * 1024;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AnnualCloseApplicationError(415, "UNSUPPORTED_MEDIA_TYPE", "Envía el cuerpo como application/json.");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      throw new AnnualCloseApplicationError(413, "BODY_TOO_LARGE", "El cuerpo de la solicitud excede el límite permitido.");
    }
    chunks.push(buffer);
  }

  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AnnualCloseApplicationError(400, "INVALID_JSON", "El cuerpo JSON no es válido.");
  }
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AnnualCloseApplicationError(400, "INVALID_INPUT", `El campo ${field} es obligatorio.`);
  }
  return value.trim();
}

function assertBearerToken(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization ?? "";
  const supplied = value.startsWith("Bearer ") ? Buffer.from(value.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host.toLowerCase() === "localhost";
}

export function createApiServer(input: {
  application: AnnualCloseApplication;
  host: string;
  bearerToken?: string;
}): Server {
  if (!isLoopback(input.host) && !input.bearerToken) {
    throw new Error("API_BEARER_TOKEN es obligatorio si la API escucha fuera de loopback.");
  }

  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (input.bearerToken && !assertBearerToken(request, input.bearerToken)) {
      sendJson(response, 401, { error: { code: "UNAUTHORIZED", message: "Autenticación requerida." } });
      return;
    }

    try {
      if (request.method === "POST" && path === "/api/accounting/annual-close/preview") {
        const body = await readJson(request);
        const companyId = requiredString(body, "companyId");
        const fiscalYear = requiredString(body, "fiscalYear");
        if (!/^\d{4}$/.test(fiscalYear)) {
          throw new AnnualCloseApplicationError(400, "INVALID_INPUT", "fiscalYear debe tener formato YYYY.");
        }
        const result = await input.application.preview({
          companyId,
          fiscalYear,
          closingDate: typeof body.closingDate === "string" ? body.closingDate : undefined,
          closingPeriod: typeof body.closingPeriod === "string" ? body.closingPeriod : undefined,
          generateNextYearOpening: body.generateNextYearOpening === true,
        });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && path === "/api/accounting/annual-close/confirm") {
        const body = await readJson(request);
        const companyId = requiredString(body, "companyId");
        const fiscalYear = requiredString(body, "fiscalYear");
        const expectedRevision = body.expectedRevision;
        if (!/^\d{4}$/.test(fiscalYear) || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
          throw new AnnualCloseApplicationError(400, "INVALID_INPUT", "fiscalYear o expectedRevision no es válido.");
        }
        const result = await input.application.confirm({
          companyId,
          fiscalYear,
          expectedRevision: Number(expectedRevision),
          closedBy: typeof body.closedBy === "string" ? body.closedBy : undefined,
          notes: typeof body.notes === "string" ? body.notes : undefined,
          closingDate: typeof body.closingDate === "string" ? body.closingDate : undefined,
          closingPeriod: typeof body.closingPeriod === "string" ? body.closingPeriod : undefined,
          generateNextYearOpening: body.generateNextYearOpening === true,
        } as ConfirmAnnualCloseInput);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Ruta no encontrada." } });
    } catch (error) {
      if (error instanceof AnnualCloseApplicationError) {
        sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor." } });
    }
  });
}
