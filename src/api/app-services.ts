import type { Persistence } from "../database/persistence.js";
import type { ICompanyRepository } from "../database/repositories/company.repository.js";
import type { ICpeRepository } from "../database/repositories/cpe.repository.js";
import { CpeEmissionOrchestrator } from "../modules/cpe/cpe-orchestrator.js";
import { PersistentPurchaseService } from "../modules/purchases/persistent-purchase-service.js";
import { PersistentAccountingService } from "../modules/accounting/persistent-accounting-service.js";
import type { CertificateData } from "../modules/signing/types.js";

export interface EmissionSettings {
  /** Envío real a SUNAT. Apagado por defecto: la API solo calcula, firma y guarda. */
  sunatSendEnabled: boolean;
  sunatEnvironment: "beta" | "production";
  /** Certificado digital del servidor. Nunca se recibe en el cuerpo de una solicitud. */
  certificate?: CertificateData;
  /** En producción se exige certificado propio: no se firma con uno autogenerado. */
  requireCertificate: boolean;
}

export interface ApiServices {
  companies: ICompanyRepository;
  cpe: ICpeRepository;
  emission: CpeEmissionOrchestrator;
  purchases: PersistentPurchaseService;
  accounting: PersistentAccountingService;
  emissionSettings: EmissionSettings;
}

export function createApiServices(persistence: Persistence, settings: Partial<EmissionSettings> = {}): ApiServices {
  const emissionSettings: EmissionSettings = {
    sunatSendEnabled: settings.sunatSendEnabled ?? false,
    sunatEnvironment: settings.sunatEnvironment ?? "beta",
    certificate: settings.certificate,
    requireCertificate: settings.requireCertificate ?? false,
  };
  return {
    companies: persistence.companies,
    cpe: persistence.cpe,
    emission: new CpeEmissionOrchestrator({
      companyRepo: persistence.companies,
      cpeRepo: persistence.cpe,
      defaultCertData: emissionSettings.certificate,
      defaultEnvironment: emissionSettings.sunatEnvironment,
    }),
    purchases: new PersistentPurchaseService(persistence.purchases),
    accounting: new PersistentAccountingService(persistence.ledger),
    emissionSettings,
  };
}
