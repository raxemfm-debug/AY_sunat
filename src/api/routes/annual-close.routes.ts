import type { AnnualCloseApplication, ConfirmAnnualCloseInput } from "../accounting/annual-close.application.js";
import { ApiError, readJson, requiredString, sendJson } from "../http/http-utils.js";
import type { Router } from "../http/router.js";
import type { ApiServices } from "../app-services.js";
import { actorLabel, currentUser, requireCompanyAccess } from "../http/access.js";

export function registerAnnualCloseRoutes(router: Router, application: AnnualCloseApplication, services: ApiServices): void {
  router.on("POST", "/api/accounting/annual-close/preview", async ({ request, response, user }) => {
    const body = await readJson(request);
    const companyId = requiredString(body, "companyId", 128);
    await requireCompanyAccess(services, user, companyId, "accounting:read");
    const fiscalYear = requiredString(body, "fiscalYear");
    if (!/^\d{4}$/.test(fiscalYear)) {
      throw new ApiError(400, "INVALID_INPUT", "fiscalYear debe tener formato YYYY.");
    }
    const result = await application.preview({
      companyId,
      fiscalYear,
      closingDate: typeof body.closingDate === "string" ? body.closingDate : undefined,
      closingPeriod: typeof body.closingPeriod === "string" ? body.closingPeriod : undefined,
      generateNextYearOpening: body.generateNextYearOpening === true,
    });
    sendJson(response, 200, result);
  });

  router.on("POST", "/api/accounting/annual-close/confirm", async ({ request, response, user }) => {
    const body = await readJson(request);
    const companyId = requiredString(body, "companyId", 128);
    await requireCompanyAccess(services, user, companyId, "accounting:annual_close");
    const fiscalYear = requiredString(body, "fiscalYear");
    const expectedRevision = body.expectedRevision;
    if (!/^\d{4}$/.test(fiscalYear) || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) {
      throw new ApiError(400, "INVALID_INPUT", "fiscalYear o expectedRevision no es válido.");
    }
    const result = await application.confirm({
      companyId,
      fiscalYear,
      expectedRevision: Number(expectedRevision),
      closedBy: actorLabel(currentUser(user)),
      notes: typeof body.notes === "string" ? body.notes : undefined,
      closingDate: typeof body.closingDate === "string" ? body.closingDate : undefined,
      closingPeriod: typeof body.closingPeriod === "string" ? body.closingPeriod : undefined,
      generateNextYearOpening: body.generateNextYearOpening === true,
    } as ConfirmAnnualCloseInput);
    sendJson(response, 200, result);
  });
}
