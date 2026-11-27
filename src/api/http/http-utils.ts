import type { IncomingMessage, ServerResponse } from "node:http";
import { AnnualCloseApplicationError } from "../accounting/annual-close.application.js";
import { DuplicatePurchaseError } from "../../database/repositories/purchase.repository.js";
import { ConcurrentPeriodChangeError } from "../../database/repositories/accounting-ledger.repository.js";
import { CpeValidationError } from "../../modules/printing/cpe-validator.js";

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
export const LARGE_MAX_BODY_BYTES = 512 * 1024;

/** Error con estado HTTP y código estable para el cliente. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type JsonObject = Record<string, unknown>;

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

export async function readJson(request: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<JsonObject> {
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Envía el cuerpo como application/json.");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new ApiError(413, "BODY_TOO_LARGE", "El cuerpo de la solicitud excede el límite permitido.");
    }
    chunks.push(buffer);
  }

  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!isObject(body)) throw new Error("Expected an object");
    return body;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "El cuerpo JSON no es válido.");
  }
}

export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const invalid = (message: string) => new ApiError(400, "INVALID_INPUT", message);

export function requiredString(body: JsonObject, field: string, maxLength = 500): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw invalid(`El campo ${field} es obligatorio.`);
  if (value.length > maxLength) throw invalid(`El campo ${field} excede ${maxLength} caracteres.`);
  return value.trim();
}

export function optionalString(body: JsonObject, field: string, maxLength = 500): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalid(`El campo ${field} debe ser texto.`);
  if (value.length > maxLength) throw invalid(`El campo ${field} excede ${maxLength} caracteres.`);
  return value.trim();
}

export function optionalBoolean(body: JsonObject, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(`El campo ${field} debe ser true o false.`);
  return value;
}

/** Monto o cantidad: número finito o texto numérico. La precisión la resuelve el dominio. */
export function optionalAmount(body: JsonObject, field: string): number | string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  throw invalid(`El campo ${field} debe ser un número.`);
}

export function requiredAmount(body: JsonObject, field: string): number | string {
  const value = optionalAmount(body, field);
  if (value === undefined) throw invalid(`El campo ${field} es obligatorio.`);
  return value;
}

export function requiredEnum<T extends string>(body: JsonObject, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalid(`El campo ${field} debe ser uno de: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function optionalEnum<T extends string>(body: JsonObject, field: string, allowed: readonly T[]): T | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredEnum(body, field, allowed);
}

export function requiredObject(body: JsonObject, field: string): JsonObject {
  const value = body[field];
  if (!isObject(value)) throw invalid(`El campo ${field} debe ser un objeto.`);
  return value;
}

export function optionalObject(body: JsonObject, field: string): JsonObject | undefined {
  if (body[field] === undefined || body[field] === null) return undefined;
  return requiredObject(body, field);
}

export function requiredObjectArray(body: JsonObject, field: string, maxItems: number): JsonObject[] {
  const value = body[field];
  if (!Array.isArray(value) || value.length === 0) throw invalid(`El campo ${field} debe tener al menos un elemento.`);
  if (value.length > maxItems) throw invalid(`El campo ${field} admite como máximo ${maxItems} elementos.`);
  value.forEach((item, index) => {
    if (!isObject(item)) throw invalid(`${field}[${index}] debe ser un objeto.`);
  });
  return value as JsonObject[];
}

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function requirePeriod(value: string | null | undefined, field = "period"): string {
  if (!value || !PERIOD_PATTERN.test(value)) throw invalid(`${field} debe tener formato YYYY-MM.`);
  return value;
}

export function optionalDate(body: JsonObject, field: string): string | undefined {
  const value = optionalString(body, field, 10);
  if (value !== undefined && !DATE_PATTERN.test(value)) throw invalid(`${field} debe tener formato YYYY-MM-DD.`);
  return value;
}

export function requiredDate(body: JsonObject, field: string): string {
  const value = optionalDate(body, field);
  if (!value) throw invalid(`El campo ${field} es obligatorio (YYYY-MM-DD).`);
  return value;
}

export function parseLimit(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw invalid(`limit debe ser un entero entre 1 y ${max}.`);
  return parsed;
}

export function parseOffset(value: string | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw invalid("offset debe ser un entero mayor o igual a 0.");
  return parsed;
}

/** Errores de PostgreSQL (pg.DatabaseError) traen un SQLSTATE de 5 caracteres. */
function isDatabaseError(error: unknown): error is Error & { code: string } {
  if (!(error instanceof Error) || !("severity" in error)) return false;
  const code = (error as unknown as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Traduce errores del dominio a respuestas HTTP. Devuelve undefined para errores internos
 * (fallos de programación o de base de datos), que nunca exponen su mensaje al cliente.
 */
export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof AnnualCloseApplicationError) return new ApiError(error.statusCode, error.code, error.message);
  if (error instanceof DuplicatePurchaseError) return new ApiError(409, "DUPLICATE_PURCHASE", error.message);
  if (error instanceof ConcurrentPeriodChangeError) return new ApiError(409, "CONCURRENT_CHANGE", error.message);
  if (error instanceof CpeValidationError) return new ApiError(422, "CPE_VALIDATION_FAILED", error.message);
  if (isDatabaseError(error)) {
    if (error.code === "23505") return new ApiError(409, "CONFLICT", "El registro ya existe.");
    return undefined;
  }
  // Solo los Error "puros" vienen de reglas de negocio; TypeError, RangeError, etc. son fallos internos.
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype) {
    const message = error.message;
    if (/no encontrad|no existe/i.test(message)) return new ApiError(404, "NOT_FOUND", message);
    if (/ya existe|duplicad/i.test(message)) return new ApiError(409, "CONFLICT", message);
    if (/cerrad[oa]/i.test(message)) return new ApiError(409, "PERIOD_CLOSED", message);
    return new ApiError(422, "BUSINESS_RULE_VIOLATION", message);
  }
  return undefined;
}
