import type { CompanyEntity, DocumentSeriesEntity, UpdateCompanyDto } from "../../database/repositories/types.js";
import type { TaxRegimeCode } from "../../core/tax-engine/types.js";
import type { ApiServices } from "../app-services.js";
import {
  ApiError,
  JsonObject,
  optionalBoolean,
  optionalString,
  readJson,
  requiredEnum,
  requiredString,
  sendJson,
} from "../http/http-utils.js";
import type { Router } from "../http/router.js";

const TAX_REGIMES = ["RMT", "RER", "RG", "NRUS"] as const satisfies readonly TaxRegimeCode[];
const SERIES_CPE_TYPES = ["01", "03", "07", "08", "09"] as const;

/** Representación pública: las credenciales SOL nunca salen de la API. */
export function toPublicCompany(company: CompanyEntity) {
  const { solUserEncrypted, solPassEncrypted, ...rest } = company;
  return { ...rest, hasSolCredentials: Boolean(solUserEncrypted && solPassEncrypted) };
}

export async function requireCompany(services: ApiServices, companyId: string): Promise<CompanyEntity> {
  const company = await services.companies.findById(companyId);
  if (!company) throw new ApiError(404, "COMPANY_NOT_FOUND", `Empresa con ID ${companyId} no encontrada.`);
  return company;
}

function addressFields(body: JsonObject, required: boolean) {
  const read = required ? requiredString : optionalString;
  const ubigeo = read(body, "ubigeo", 6);
  if (ubigeo !== undefined && !/^\d{6}$/.test(ubigeo)) {
    throw new ApiError(400, "INVALID_INPUT", "ubigeo debe tener 6 dígitos.");
  }
  return {
    ubigeo,
    department: read(body, "department", 100),
    province: read(body, "province", 100),
    district: read(body, "district", 100),
    addressLine: read(body, "addressLine", 300),
  };
}

export function registerCompanyRoutes(router: Router, services: ApiServices): void {
  router.on("GET", "/api/companies", async ({ response, query }) => {
    const active = query.get("active");
    const filter = active === null ? undefined : { isActive: active === "true" };
    const companies = await services.companies.listAll(filter);
    sendJson(response, 200, { data: companies.map(toPublicCompany) });
  });

  router.on("POST", "/api/companies", async ({ request, response }) => {
    const body = await readJson(request);
    const ruc = requiredString(body, "ruc", 11);
    if (!/^\d{11}$/.test(ruc)) throw new ApiError(400, "INVALID_INPUT", "ruc debe tener 11 dígitos.");
    const address = addressFields(body, true) as Record<"ubigeo" | "department" | "province" | "district" | "addressLine", string>;
    const company = await services.companies.create({
      ruc,
      legalName: requiredString(body, "legalName", 300),
      tradeName: optionalString(body, "tradeName", 300),
      taxRegime: requiredEnum(body, "taxRegime", TAX_REGIMES),
      certAlias: optionalString(body, "certAlias", 100),
      ...address,
    });
    sendJson(response, 201, toPublicCompany(company));
  });

  router.on("GET", "/api/companies/:companyId", async ({ response, params }) => {
    sendJson(response, 200, toPublicCompany(await requireCompany(services, params.companyId)));
  });

  router.on("PATCH", "/api/companies/:companyId", async ({ request, response, params }) => {
    await requireCompany(services, params.companyId);
    const body = await readJson(request);
    const updates: UpdateCompanyDto = {
      legalName: optionalString(body, "legalName", 300),
      tradeName: optionalString(body, "tradeName", 300),
      taxRegime: body.taxRegime === undefined ? undefined : requiredEnum(body, "taxRegime", TAX_REGIMES),
      isActive: optionalBoolean(body, "isActive"),
      isHabido: optionalBoolean(body, "isHabido"),
      certAlias: optionalString(body, "certAlias", 100),
      ...addressFields(body, false),
    };
    const clean = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
    const company = await services.companies.update(params.companyId, clean as UpdateCompanyDto);
    sendJson(response, 200, toPublicCompany(company));
  });

  router.on("GET", "/api/companies/:companyId/series", async ({ response, params }) => {
    await requireCompany(services, params.companyId);
    const series: DocumentSeriesEntity[] = await services.companies.listSeriesByCompany(params.companyId);
    sendJson(response, 200, { data: series });
  });

  router.on("POST", "/api/companies/:companyId/series", async ({ request, response, params }) => {
    await requireCompany(services, params.companyId);
    const body = await readJson(request);
    const series = requiredString(body, "series", 4).toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(series)) throw new ApiError(400, "INVALID_INPUT", "series debe tener 4 caracteres alfanuméricos.");
    const initial = body.initialCorrelative;
    if (initial !== undefined && (!Number.isSafeInteger(initial) || Number(initial) < 0)) {
      throw new ApiError(400, "INVALID_INPUT", "initialCorrelative debe ser un entero mayor o igual a 0.");
    }
    const created = await services.companies.createSeries({
      companyId: params.companyId,
      cpeType: requiredEnum(body, "cpeType", SERIES_CPE_TYPES),
      series,
      initialCorrelative: initial as number | undefined,
      description: optionalString(body, "description", 200),
    });
    sendJson(response, 201, created);
  });
}
