import type { IdentityDocTypeCode } from "../../core/tax-engine/types.js";
import type { PurchaseDocumentInput, PurchaseItemInput } from "../../modules/purchases/types.js";
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
  readJson,
  requiredAmount,
  requiredDate,
  requiredEnum,
  requiredObject,
  requiredObjectArray,
  requiredString,
  requirePeriod,
  sendJson,
} from "../http/http-utils.js";
import type { Router } from "../http/router.js";
import { requireCompanyAccess } from "../http/access.js";

const IDENTITY_DOC_TYPES = ["0", "1", "4", "6", "7"] as const satisfies readonly IdentityDocTypeCode[];
const PURCHASE_DOC_TYPES = ["01", "03", "07", "08", "50"] as const;
const TAX_DESTINATIONS = ["GRAVADO_EXCLUSIVO", "GRAVADO_COMUN", "GRAVADO_SIN_CREDITO", "NO_GRAVADO"] as const;
const SIRE_STATUSES = ["PROPUESTA_PENDIENTE", "ACEPTADO", "COMPLEMENTADO", "EXCLUIDO"] as const;

function parseItem(item: JsonObject): PurchaseItemInput {
  return {
    description: requiredString(item, "description", 500),
    quantity: requiredAmount(item, "quantity"),
    unitValue: requiredAmount(item, "unitValue"),
    taxDestination: requiredEnum(item, "taxDestination", TAX_DESTINATIONS),
    classification: optionalEnum(item, "classification", ["1", "2", "3", "4", "5"] as const),
    igvRate: optionalAmount(item, "igvRate"),
  };
}

export function parsePurchase(companyRuc: string, body: JsonObject): PurchaseDocumentInput {
  const supplier = requiredObject(body, "supplier");
  const correlative = requiredAmount(body, "correlative");
  const detraction = optionalObject(body, "detraction");
  const modified = optionalObject(body, "modifiedDocument");
  return {
    companyRuc, // siempre la empresa de la ruta, nunca la del cuerpo
    supplier: {
      docType: requiredEnum(supplier, "docType", IDENTITY_DOC_TYPES),
      docNumber: requiredString(supplier, "docNumber", 15),
      name: requiredString(supplier, "name", 300),
      tradeName: optionalString(supplier, "tradeName", 300),
      isHabido: optionalBoolean(supplier, "isHabido"),
      isActive: optionalBoolean(supplier, "isActive"),
      address: optionalString(supplier, "address", 300),
      email: optionalString(supplier, "email", 200),
    },
    docType: requiredEnum(body, "docType", PURCHASE_DOC_TYPES),
    series: requiredString(body, "series", 4).toUpperCase(),
    correlative,
    issueDate: requiredDate(body, "issueDate"),
    dueDate: optionalDate(body, "dueDate"),
    accountingPeriod: requirePeriod(optionalString(body, "accountingPeriod", 7), "accountingPeriod"),
    currency: requiredEnum(body, "currency", ["PEN", "USD"] as const),
    exchangeRate: optionalAmount(body, "exchangeRate"),
    paymentMethod: requiredEnum(body, "paymentMethod", ["CONTADO", "CREDITO"] as const),
    isBancarizado: optionalBoolean(body, "isBancarizado"),
    bancarizacionMedium: optionalString(body, "bancarizacionMedium", 100),
    detraction: detraction
      ? {
          hasDetraction: optionalBoolean(detraction, "hasDetraction") ?? false,
          detractionCode: optionalString(detraction, "detractionCode", 10),
          detractionPercentage: optionalAmount(detraction, "detractionPercentage"),
          detractionAmount: optionalAmount(detraction, "detractionAmount"),
          depositDate: optionalDate(detraction, "depositDate"),
          depositProofNumber: optionalString(detraction, "depositProofNumber", 30),
        }
      : undefined,
    retentionApplied: optionalBoolean(body, "retentionApplied"),
    retentionAmount: optionalAmount(body, "retentionAmount"),
    modifiedDocument: modified
      ? {
          docType: requiredEnum(modified, "docType", ["01", "03", "50"] as const),
          series: requiredString(modified, "series", 4).toUpperCase(),
          correlative: requiredAmount(modified, "correlative"),
          issueDate: requiredDate(modified, "issueDate"),
        }
      : undefined,
    items: requiredObjectArray(body, "items", 500).map(parseItem),
  };
}

export function registerPurchaseRoutes(router: Router, services: ApiServices): void {
  router.on("POST", "/api/companies/:companyId/purchases", async ({ request, response, params, user }) => {
    const { company } = await requireCompanyAccess(services, user, params.companyId, "purchases:write");
    const body = await readJson(request, LARGE_MAX_BODY_BYTES);
    const record = await services.purchases.registerPurchase(parsePurchase(company.ruc, body));
    sendJson(response, 201, record);
  });

  router.on("GET", "/api/companies/:companyId/purchases", async ({ response, params, query, user }) => {
    const { company } = await requireCompanyAccess(services, user, params.companyId, "purchases:read");
    const period = requirePeriod(query.get("period"));
    sendJson(response, 200, { data: await services.purchases.listByPeriod(company.ruc, period), period });
  });

  // Registrada antes de /:car para que "summary" no se lea como un CAR.
  router.on("GET", "/api/companies/:companyId/purchases/summary", async ({ response, params, query, user }) => {
    const { company } = await requireCompanyAccess(services, user, params.companyId, "purchases:read");
    const period = requirePeriod(query.get("period"));
    sendJson(response, 200, await services.purchases.getMonthlySummary(company.ruc, period));
  });

  router.on("GET", "/api/companies/:companyId/purchases/:car", async ({ response, params, user }) => {
    const { company } = await requireCompanyAccess(services, user, params.companyId, "purchases:read");
    const record = await services.purchases.findByCar(company.ruc, params.car);
    if (!record) throw new ApiError(404, "PURCHASE_NOT_FOUND", "Comprobante de compra no encontrado.");
    sendJson(response, 200, record);
  });

  router.on("PATCH", "/api/companies/:companyId/purchases/:car/sire-status", async ({ request, response, params, user }) => {
    const { company } = await requireCompanyAccess(services, user, params.companyId, "purchases:write");
    const body = await readJson(request);
    const status = requiredEnum(body, "status", SIRE_STATUSES);
    sendJson(response, 200, await services.purchases.updateSireStatus(company.ruc, params.car, status));
  });
}
