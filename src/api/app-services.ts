import { AccessControlService } from "../modules/auth/access-control.service.js";
import { DEFAULT_SESSION_TTL_MS, LoginThrottle, LoginThrottleOptions, SessionService } from "../modules/auth/session.service.js";
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

export interface AuthSettings {
  /** Alta libre de usuarios por POST /api/auth/register. Apagada por defecto. */
  allowSignup: boolean;
  sessionTtlMs: number;
  /** Reloj inyectable (pruebas de vencimiento de sesión). */
  now?: () => Date;
  throttle?: LoginThrottleOptions;
}

export interface ApiServices {
  companies: ICompanyRepository;
  cpe: ICpeRepository;
  emission: CpeEmissionOrchestrator;
  purchases: PersistentPurchaseService;
  accounting: PersistentAccountingService;
  emissionSettings: EmissionSettings;
  /** Usuarios y permisos por empresa: toda ruta de empresa pasa por aquí. */
  access: AccessControlService;
  sessions: SessionService;
  loginThrottle: LoginThrottle;
  authSettings: AuthSettings;
}

export function createApiServices(
  persistence: Persistence,
  settings: Partial<EmissionSettings> = {},
  auth: Partial<AuthSettings> = {},
): ApiServices {
  const authSettings: AuthSettings = {
    allowSignup: auth.allowSignup ?? false,
    sessionTtlMs: auth.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    now: auth.now,
    throttle: auth.throttle,
  };
  const access = new AccessControlService(persistence.users);
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
    access,
    sessions: new SessionService(persistence.sessions, access, { ttlMs: authSettings.sessionTtlMs, now: authSettings.now }),
    loginThrottle: new LoginThrottle(authSettings.throttle),
    authSettings,
    emissionSettings,
  };
}
