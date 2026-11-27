import { readFileSync } from "node:fs";
import { createPersistence } from "../database/persistence.js";
import { loadCertificateFromPfx } from "../modules/signing/certificate.service.js";
import type { CertificateData } from "../modules/signing/types.js";
import { AnnualCloseApplication } from "./accounting/annual-close.application.js";
import { MemoryAnnualCloseRepository } from "./accounting/memory-annual-close.repository.js";
import { PostgresAnnualCloseRepository } from "./accounting/postgres-annual-close.repository.js";
import { createApiServices } from "./app-services.js";
import { createApiServer } from "./http-server.js";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT debe ser un puerto válido entre 1 y 65535.");
}
const production = process.env.NODE_ENV === "production";

// Lanza error en producción si falta DATABASE_URL: nunca arranca con datos en memoria.
const persistence = createPersistence({ databaseUrl: process.env.DATABASE_URL });

function loadServerCertificate(): CertificateData | undefined {
  const certPath = process.env.SUNAT_CERT_PATH;
  if (!certPath) return undefined;
  return loadCertificateFromPfx(readFileSync(certPath), process.env.SUNAT_CERT_PASSWORD ?? "");
}

const sunatEnvironment = process.env.SUNAT_ENVIRONMENT === "production" ? "production" : "beta";
const services = createApiServices(persistence, {
  sunatSendEnabled: process.env.SUNAT_SEND_ENABLED === "true",
  sunatEnvironment,
  certificate: loadServerCertificate(),
  requireCertificate: production,
});

const annualCloseRepository = persistence.pool
  ? new PostgresAnnualCloseRepository(persistence.pool)
  : new MemoryAnnualCloseRepository();
const server = createApiServer({
  application: new AnnualCloseApplication(annualCloseRepository),
  services,
  host,
  bearerToken: process.env.API_BEARER_TOKEN,
});

server.listen(port, host, () => {
  const storage = persistence.kind === "postgres" ? "PostgreSQL" : "memoria (solo desarrollo)";
  const sunat = services.emissionSettings.sunatSendEnabled ? `envío SUNAT ${sunatEnvironment}` : "envío SUNAT desactivado";
  process.stdout.write(`API local disponible en http://${host}:${port} · ${storage} · ${sunat}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => {
    void persistence.close().finally(() => process.exit(0));
  }));
}
