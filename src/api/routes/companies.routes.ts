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
import { currentUser, requireCompanyAccess } from "../http/access.js";
import { ROLE_LABELS } from "../../modules/auth/permissions.js";

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
  /** Solo las empresas de las que el usuario es miembro, con su rol en cada una. */
  router.on("GET", "/api/companies", async ({ response, query, user }) => {
    const active = query.get("active");
    const access = await services.access.listAccessibleCompanies(currentUser(user).id);
    const data = [];
    for (const item of access) {
      const company = await services.companies.findById(item.companyId);
      if (!company) continue;
      if (active !== null && company.isActive !== (active === "true")) continue;
      data.push({ ...toPublicCompany(company), role: item.role, roleLabel: ROLE_LABELS[item.role] });
    }
    data.sort((a, b) => a.legalName.localeCompare(b.legalName));
    sendJson(response, 200, { data });
  });

  /** Cualquier usuario autenticado puede registrar una empresa; queda como su titular. */
  router.on("POST", "/api/companies", async ({ request, response, user }) => {
    const actor = currentUser(user);
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
    await services.access.assignInitialOwner(company.id, actor.id);
    sendJson(response, 201, { ...toPublicCompany(company), role: "OWNER", roleLabel: ROLE_LABELS.OWNER });
  });

  router.on("GET", "/api/companies/:companyId", async ({ response, params, user }) => {
    const { company, role } = await requireCompanyAccess(services, user, params.companyId, "company:read");
    sendJson(response, 200, { ...toPublicCompany(company), role, roleLabel: ROLE_LABELS[role] });
  });

  router.on("PATCH", "/api/companies/:companyId", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "company:update");
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

  router.on("GET", "/api/companies/:companyId/series", async ({ response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "series:read");
    const series: DocumentSeriesEntity[] = await services.companies.listSeriesByCompany(params.companyId);
    sendJson(response, 200, { data: series });
  });

  router.on("POST", "/api/companies/:companyId/series", async ({ request, response, params, user }) => {
    await requireCompanyAccess(services, user, params.companyId, "series:create");
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
