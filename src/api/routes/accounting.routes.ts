import type { CreateJournalEntryInput, OriginDocumentType } from "../../modules/accounting/types.js";
import type { ApiServices } from "../app-services.js";
import {
  ApiError,
  JsonObject,
  LARGE_MAX_BODY_BYTES,
  optionalAmount,
  optionalBoolean,
  optionalEnum,
  optionalObject,
  optionalString,
  readJson,
  requiredDate,
  requiredEnum,
  requiredObjectArray,
  requiredString,
  requirePeriod,
  sendJson,
} from "../http/http-utils.js";
import type { Router } from "../http/router.js";
import { actorLabel, currentUser, requireCompanyAccess } from "../http/access.js";

// OPENING y CLOSING quedan reservados a los cierres del sistema.
const ORIGIN_TYPES = ["CPE_SALE", "PURCHASE", "COLLECTION", "PAYMENT", "ADJUSTMENT", "MANUAL"] as const;

function parseLine(line: JsonObject) {
  const accountCode = requiredString(line, "accountCode", 12);
  if (!/^\d{2,12}$/.test(accountCode)) throw new ApiError(400, "INVALID_INPUT", "accountCode debe ser numérico (PCGE).");
  return {
    accountCode,
    accountName: optionalString(line, "accountName", 200),
    debit: optionalAmount(line, "debit"),
    credit: optionalAmount(line, "credit"),
    glosa: optionalString(line, "glosa", 300),
    costCenter: optionalString(line, "costCenter", 30),
    referenceDoc: optionalString(line, "referenceDoc", 60),
  };
}

export function parseJournalEntry(companyId: string, body: JsonObject): CreateJournalEntryInput {
  const origin = optionalObject(body, "originDocument");
  return {
    companyId, // siempre la empresa de la ruta
    accountingPeriod: requirePeriod(optionalString(body, "accountingPeriod", 7), "accountingPeriod"),
    entryDate: requiredDate(body, "entryDate"),
    glosa: requiredString(body, "glosa", 500),
    currency: optionalEnum(body, "currency", ["PEN", "USD"] as const),
    exchangeRate: optionalAmount(body, "exchangeRate")?.toString(),
    status: optionalEnum(body, "status", ["POSTED", "PENDING", "DRAFT"] as const),
    originDocument: origin
      ? {
          type: requiredEnum(origin, "type", ORIGIN_TYPES) as OriginDocumentType,
          documentId: requiredString(origin, "documentId", 128),
          cpeType: optionalString(origin, "cpeType", 2),
          series: optionalString(origin, "series", 4),
          correlative: optionalString(origin, "correlative", 10),
          fullNumber: optionalString(origin, "fullNumber", 20),
          entityDocNumber: optionalString(origin, "entityDocNumber", 15),
          entityName: optionalString(origin, "entityName", 300),
        }
      : undefined,
    lines: requiredObjectArray(body, "lines", 500).map(parseLine),
  };
}

export function registerAccountingRoutes(router: Router, services: ApiServices): void {
  const accounting = services.accounting;

  router.on("POST", "/api/companies/:companyId/journal-entries", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:write");
    const input = parseJournalEntry(params.companyId, await readJson(request, LARGE_MAX_BODY_BYTES));
    const entry = input.status === "DRAFT" || input.status === "PENDING"
      ? await accounting.registerDraftEntry(input)
      : await accounting.registerEntry(input);
    sendJson(response, 201, entry);
  });

  router.on("GET", "/api/companies/:companyId/journal-entries", async ({ response, params, query, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:read");
    const period = requirePeriod(query.get("period"));
    sendJson(response, 200, { data: await accounting.getJournalEntries(params.companyId, period), period });
  });

  router.on("POST", "/api/companies/:companyId/journal-entries/:entryId/post", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:write");
    sendJson(response, 200, await accounting.postEntry(params.companyId, params.entryId));
  });

  router.on("GET", "/api/companies/:companyId/periods/:period", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:read");
    sendJson(response, 200, await accounting.getPeriodRecord(params.companyId, requirePeriod(params.period)));
  });

  router.on("POST", "/api/companies/:companyId/periods/:period/close", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:close_period");
    const body = await readJson(request);
    sendJson(response, 200, await accounting.closePeriod({
      companyId: params.companyId,
      period: requirePeriod(params.period),
      closedBy: actorLabel(currentUser(user)),
      notes: optionalString(body, "notes", 1000),
      allowEmptyPeriod: optionalBoolean(body, "allowEmptyPeriod"),
    }));
  });

  router.on("POST", "/api/companies/:companyId/periods/:period/reopen", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:reopen_period");
    const body = await readJson(request);
    sendJson(response, 200, await accounting.reopenPeriod({
      companyId: params.companyId,
      period: requirePeriod(params.period),
      reopenedBy: actorLabel(currentUser(user)),
      reason: requiredString(body, "reason", 1000),
    }));
  });

  router.on("GET", "/api/companies/:companyId/trial-balance", async ({ response, params, query, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:read");
    sendJson(response, 200, await accounting.generateTrialBalance(params.companyId, requirePeriod(query.get("period"))));
  });

  router.on("GET", "/api/companies/:companyId/general-ledger", async ({ response, params, query, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "accounting:read");
    sendJson(response, 200, await accounting.generateGeneralLedger(params.companyId, requirePeriod(query.get("period"))));
  });
}
