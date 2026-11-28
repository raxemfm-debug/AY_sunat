import type { CreditNoteSpecificData, IgvAffectationCode, IdentityDocTypeCode, ItemCalculationInput } from "../../core/tax-engine/types.js";
import type { CpeDatabaseStatus } from "../../database/repositories/types.js";
import type { EmitCpeRequest, EmitCpeResult } from "../../modules/cpe/types.js";
import type { ApiServices } from "../app-services.js";
import {
  ApiError,
  JsonObject,
  LARGE_MAX_BODY_BYTES,
  optionalAmount,
  optionalBoolean,
  optionalDate,
  optionalEnum,
  optionalObject,
  optionalString,
  parseLimit,
  parseOffset,
  readJson,
  requiredAmount,
  requiredEnum,
  requiredObject,
  requiredObjectArray,
  requiredString,
  sendJson,
} from "../http/http-utils.js";
import type { Router } from "../http/router.js";
import { requireCompanyAccess } from "../http/access.js";
import { roleHasPermission } from "../../modules/auth/permissions.js";

const CPE_TYPES = ["01", "03", "07"] as const;
const IDENTITY_DOC_TYPES = ["0", "1", "4", "6", "7"] as const satisfies readonly IdentityDocTypeCode[];
const IGV_CODES = [
  "10", "11", "12", "13", "14", "15", "16", "17", "20", "21",
  "30", "31", "32", "33", "34", "35", "36", "40",
] as const satisfies readonly IgvAffectationCode[];
const CREDIT_NOTE_CODES = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13"] as const;
const FILE_KINDS = ["xml", "zip", "pdf", "ticket", "cdr"] as const;
type FileKind = (typeof FILE_KINDS)[number];
const DB_STATUSES = [
  "BORRADOR", "CALCULADO", "FIRMADO_XML", "ENVIADO_SUNAT", "ACEPTADO",
  "ACEPTADO_CON_OBSERVACIONES", "RECHAZADO", "DE_BAJA",
] as const satisfies readonly CpeDatabaseStatus[];
const MAX_ITEMS = 500;

function parseItem(item: JsonObject): ItemCalculationInput {
  const priceIncludesIgv = optionalBoolean(item, "priceIncludesIgv");
  if (priceIncludesIgv === undefined) {
    throw new ApiError(400, "INVALID_INPUT", "Cada ítem debe indicar priceIncludesIgv (true o false).");
  }
  return {
    code: optionalString(item, "code", 30),
    description: requiredString(item, "description", 500),
    quantity: requiredAmount(item, "quantity"),
    unitCode: optionalString(item, "unitCode", 3),
    unitPrice: requiredAmount(item, "unitPrice"),
    priceIncludesIgv,
    affectationType: requiredEnum(item, "affectationType", IGV_CODES),
    discountPercentage: optionalAmount(item, "discountPercentage"),
    discountAmount: optionalAmount(item, "discountAmount"),
  };
}

function parseCreditNote(body: JsonObject): CreditNoteSpecificData {
  const correlative = body.modifiedDocCorrelative;
  if (!Number.isSafeInteger(correlative) || Number(correlative) < 1) {
    throw new ApiError(400, "INVALID_INPUT", "creditNoteInfo.modifiedDocCorrelative debe ser un entero positivo.");
  }
  return {
    discrepancyCode: requiredEnum(body, "discrepancyCode", CREDIT_NOTE_CODES),
    discrepancyReason: requiredString(body, "discrepancyReason", 250),
    modifiedDocType: requiredEnum(body, "modifiedDocType", ["01", "03"] as const),
    modifiedDocSeries: requiredString(body, "modifiedDocSeries", 4).toUpperCase(),
    modifiedDocCorrelative: Number(correlative),
  };
}

export function parseEmitRequest(companyId: string, body: JsonObject): EmitCpeRequest {
  const client = requiredObject(body, "client");
  const cpeType = requiredEnum(body, "cpeType", CPE_TYPES);
  const creditNote = optionalObject(body, "creditNoteInfo");
  if (cpeType === "07" && !creditNote) {
    throw new ApiError(400, "INVALID_INPUT", "La nota de crédito (07) requiere creditNoteInfo.");
  }
  const issueTime = optionalString(body, "issueTime", 8);
  if (issueTime !== undefined && !/^\d{2}:\d{2}:\d{2}$/.test(issueTime)) {
    throw new ApiError(400, "INVALID_INPUT", "issueTime debe tener formato HH:mm:ss.");
  }
  return {
    companyId,
    cpeType,
    series: requiredString(body, "series", 4).toUpperCase(),
    client: {
      docType: requiredEnum(client, "docType", IDENTITY_DOC_TYPES),
      docNumber: requiredString(client, "docNumber", 15),
      name: requiredString(client, "name", 300),
      address: optionalString(client, "address", 300),
      email: optionalString(client, "email", 200),
    },
    items: requiredObjectArray(body, "items", MAX_ITEMS).map(parseItem),
    paymentMethod: requiredEnum(body, "paymentMethod", ["CONTADO", "CREDITO"] as const),
    issueDate: optionalDate(body, "issueDate"),
    issueTime,
    currency: optionalEnum(body, "currency", ["PEN", "USD"] as const),
    exchangeRate: optionalAmount(body, "exchangeRate"),
    globalDiscountAmount: optionalAmount(body, "globalDiscountAmount"),
    creditNoteInfo: creditNote && cpeType === "07" ? parseCreditNote(creditNote) : undefined,
  };
}

function parseFileKinds(options: JsonObject | undefined): Set<FileKind> {
  const value = options?.returnFiles;
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.some((kind) => !FILE_KINDS.includes(kind as FileKind))) {
    throw new ApiError(400, "INVALID_INPUT", `options.returnFiles admite: ${FILE_KINDS.join(", ")}.`);
  }
  return new Set(value as FileKind[]);
}

function toEmitResponse(result: EmitCpeResult, files: Set<FileKind>) {
  const { cdrRawXml, ...sunatResponse } = result.sunatResponse ?? ({} as NonNullable<EmitCpeResult["sunatResponse"]>);
  const payload: Record<string, unknown> = {
    cpeId: result.cpeId,
    fullNumber: result.fullNumber,
    status: result.status,
    hashCpe: result.hashCpe,
    qrPayload: result.qrPayload,
    zipFileName: result.zipFileName,
    totals: result.calculation.totals,
    sunatResponse: result.sunatResponse ? sunatResponse : null,
  };
  if (files.size > 0) {
    payload.files = {
      xmlSigned: files.has("xml") ? result.xmlSigned : undefined,
      zipBase64: files.has("zip") ? result.zipBuffer.toString("base64") : undefined,
      pdfA4Base64: files.has("pdf") ? result.pdfA4?.toString("base64") : undefined,
      ticket80mmBase64: files.has("ticket") ? result.ticket80mm?.toString("base64") : undefined,
      cdrXml: files.has("cdr") ? cdrRawXml : undefined,
    };
  }
  return payload;
}

export function registerCpeRoutes(router: Router, services: ApiServices): void {
  router.on("POST", "/api/companies/:companyId/cpe", async ({ request, response, params, user }) => {
    const { company, role } = await requireCompanyAccess(services, user, params.companyId, "cpe:emit");
    const body = await readJson(request, LARGE_MAX_BODY_BYTES);
    const emitRequest = parseEmitRequest(company.id, body);
    const options = optionalObject(body, "options");
    const files = parseFileKinds(options);
    const settings = services.emissionSettings;

    const requestedSend = options ? optionalBoolean(options, "sendToSunat") : undefined;
    if (requestedSend === true && !settings.sunatSendEnabled) {
      throw new ApiError(409, "SUNAT_SEND_DISABLED", "El envío a SUNAT está desactivado en este servidor (SUNAT_SEND_ENABLED).");
    }
    const sendToSunat = settings.sunatSendEnabled && requestedSend !== false;
    if (sendToSunat && !roleHasPermission(role, "cpe:send_sunat")) {
      throw new ApiError(403, "FORBIDDEN", "Tu rol en esta empresa no permite enviar comprobantes a SUNAT.");
    }
    if ((settings.requireCertificate || sendToSunat) && !settings.certificate) {
      throw new ApiError(503, "CERTIFICATE_NOT_CONFIGURED", "Configura el certificado digital del servidor antes de emitir.");
    }
    if (sendToSunat && settings.sunatEnvironment === "production" && !(company.solUserEncrypted && company.solPassEncrypted)) {
      throw new ApiError(422, "SOL_CREDENTIALS_MISSING", "La empresa no tiene credenciales SOL configuradas para producción.");
    }

    const result = await services.emission.emitDocument(emitRequest, {
      sendToSunat,
      validateXsd: options ? optionalBoolean(options, "validateXsd") ?? false : false,
      generatePdf: files.has("pdf"),
      generateTicket: files.has("ticket"),
      sunatEnvironment: settings.sunatEnvironment,
    });
    sendJson(response, 201, toEmitResponse(result, files));
  });

  router.on("GET", "/api/companies/:companyId/cpe", async ({ response, params, query, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "cpe:read");
    const filter = Object.fromEntries(
      ["cpeType", "series", "startDate", "endDate", "clientDocNumber", "status"]
        .map((key) => [key, query.get(key) ?? undefined])
        .filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    for (const key of ["startDate", "endDate"]) {
      if (filter[key] && !/^\d{4}-\d{2}-\d{2}$/.test(filter[key])) {
        throw new ApiError(400, "INVALID_INPUT", `${key} debe tener formato YYYY-MM-DD.`);
      }
    }
    if (filter.status && !DB_STATUSES.includes(filter.status as CpeDatabaseStatus)) {
      throw new ApiError(400, "INVALID_INPUT", `status debe ser uno de: ${DB_STATUSES.join(", ")}.`);
    }
    const limit = parseLimit(query.get("limit"), 50, 200);
    const offset = parseOffset(query.get("offset"));
    const documents = await services.cpe.listByCompany(params.companyId, {
      ...filter,
      status: filter.status as CpeDatabaseStatus | undefined,
      limit,
      offset,
    });
    sendJson(response, 200, { data: documents, limit, offset });
  });

  router.on("GET", "/api/companies/:companyId/cpe/:cpeId", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "cpe:read");
    const aggregate = await services.cpe.findById(params.cpeId);
    // Un comprobante de otra empresa se responde igual que uno inexistente.
    if (!aggregate || aggregate.document.companyId !== params.companyId) {
      throw new ApiError(404, "CPE_NOT_FOUND", "Comprobante no encontrado.");
    }
    sendJson(response, 200, aggregate);
  });
}
