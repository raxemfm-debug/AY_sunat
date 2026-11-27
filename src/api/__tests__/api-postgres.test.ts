import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistence } from "../../database/persistence.js";
import { createTestDatabase, TestDatabase, truncateAll } from "../../database/__tests__/helpers/pg-test-database.js";
import { createApiServices } from "../app-services.js";
import { ApiTestClient, companyBody, entryBody, invoiceBody, purchaseBody, startApi } from "./api-test-client.js";

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("API REST persistente sobre PostgreSQL real", () => {
  let db: TestDatabase;
  let api: ApiTestClient;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase(adminUrl!);
    api = await startApi({ services: createApiServices(createPersistence({ pool: db.pool })) });
  });
  afterAll(async () => {
    await api?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await truncateAll(db.pool);
    const created = await api.request("POST", "/api/companies", companyBody());
    expect(created.status).toBe(201);
    companyId = created.json.id;
  });

  it("emite en paralelo sin repetir correlativos y lo deja guardado", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody())),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.json.fullNumber).sort();
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => `F001-${String(i + 1).padStart(8, "0")}`));

    const rows = await db.pool.query("SELECT count(*)::int AS n FROM cpe_documents WHERE company_id = $1", [companyId]);
    expect(rows.rows[0].n).toBe(8);
    const list = await api.request("GET", `/api/companies/${companyId}/cpe?limit=5&offset=5`);
    expect(list.json.data).toHaveLength(3);
  });

  it("acepta una sola compra cuando llegan dos iguales a la vez", async () => {
    const [a, b] = await Promise.all([
      api.request("POST", `/api/companies/${companyId}/purchases`, purchaseBody()),
      api.request("POST", `/api/companies/${companyId}/purchases`, purchaseBody()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM private.purchase_documents");
    expect(rows.rows[0].n).toBe(1);
  });

  it("numera asientos concurrentes sin huecos y bloquea el período cerrado", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody())),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const list = await api.request("GET", `/api/companies/${companyId}/journal-entries?period=2026-03`);
    expect(list.json.data).toHaveLength(6);

    expect((await api.request("POST", `/api/companies/${companyId}/periods/2026-03/close`, {})).status).toBe(200);
    expect((await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody())).status).toBe(409);
    const stored = await db.pool.query(
      "SELECT status FROM private.accounting_periods WHERE company_id = $1 AND period = '2026-03'",
      [companyId],
    );
    expect(stored.rows[0].status).toBe("CLOSED");
  });

  it("devuelve 404 para un ID que no es UUID sin romper la consulta", async () => {
    expect((await api.request("GET", "/api/companies/no-es-uuid")).status).toBe(404);
    expect((await api.request("GET", `/api/companies/${companyId}/cpe/no-es-uuid`)).status).toBe(404);
  });
});
