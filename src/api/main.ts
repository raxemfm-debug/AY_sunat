import { AnnualCloseApplication } from "./accounting/annual-close.application.js";
import { MemoryAnnualCloseRepository } from "./accounting/memory-annual-close.repository.js";
import {
  createPostgresPool,
  PostgresAnnualCloseRepository,
} from "./accounting/postgres-annual-close.repository.js";
import { createApiServer } from "./http-server.js";

const host = process.env.API_HOST ?? "127.0.0.1";
const port = Number(process.env.API_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT debe ser un puerto válido entre 1 y 65535.");
}

const databaseUrl = process.env.DATABASE_URL;
if (process.env.NODE_ENV === "production" && !databaseUrl) {
  throw new Error("DATABASE_URL es obligatoria en producción; no se permite iniciar con almacenamiento en memoria.");
}
const pool = databaseUrl ? createPostgresPool(databaseUrl) : undefined;
const repository = pool
  ? new PostgresAnnualCloseRepository(pool)
  : new MemoryAnnualCloseRepository();
const application = new AnnualCloseApplication(repository);
const server = createApiServer({
  application,
  host,
  bearerToken: process.env.API_BEARER_TOKEN,
});

server.listen(port, host, () => {
  process.stdout.write(`API local disponible en http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => {
    void pool?.end().finally(() => process.exit(0));
    if (!pool) process.exit(0);
  }));
}
