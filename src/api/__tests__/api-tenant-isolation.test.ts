import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPersistence } from "../../database/persistence.js";
import { createTestDatabase, TestDatabase, truncateAll } from "../../database/__tests__/helpers/pg-test-database.js";
import { createApiServices } from "../app-services.js";
import { ApiTestClient, companyBody, entryBody, invoiceBody, purchaseBody, startApi } from "./api-test-client.js";

/**
 * Aislamiento entre empresas: entrando por la ruta de la empresa B no se puede
 * leer ni modificar nada de la empresa A, aunque se conozcan sus IDs.
 * Se ejecuta en memoria y, si hay TEST_DATABASE_URL, también sobre PostgreSQL.
 */
const adminUrl = process.env.TEST_DATABASE_URL;

interface Backend {
  name: string;
  enabled: boolean;
  setup(): Promise<{ api: ApiTestClient; reset(): Promise<void>; teardown(): Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "memoria",
    enabled: true,
    async setup() {
      let api = await startApi({ services: createApiServices(createPersistence({ allowMemory: true })) });
      const holder = {
        get api() { return api; },
        async reset() {
          await api.close();
          api = await startApi({ services: createApiServices(createPersistence({ allowMemory: true })) });
        },
        teardown: () => api.close(),
      };
      return holder;
    },
  },
  {
    name: "PostgreSQL",
    enabled: Boolean(adminUrl),
    async setup() {
      const db: TestDatabase = await createTestDatabase(adminUrl!);
      const api = await startApi({ services: createApiServices(createPersistence({ pool: db.pool })) });
      return {
        api,
        async reset() {
          await truncateAll(db.pool);
          await api.resetDefaultUser();
        },
        async teardown() {
          await api.close();
          await db.drop();
        },
      };
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`Aislamiento entre empresas (${backend.name})`, () => {
    let env: Awaited<ReturnType<Backend["setup"]>>;
    let api: ApiTestClient;
    let a: { id: string; ruc: string };
    let b: { id: string; ruc: string };
    let cpeA: string;
    let carA: string;
    let draftA: string;

    const A = (path: string) => `/api/companies/${a.id}${path}`;
    const B = (path: string) => `/api/companies/${b.id}${path}`;

    beforeAll(async () => {
      env = await backend.setup();
    });
    afterAll(async () => env?.teardown());

    beforeEach(async () => {
      await env.reset();
      api = env.api;
      const ca = await api.request("POST", "/api/companies", companyBody());
      const cb = await api.request("POST", "/api/companies", companyBody({ ruc: "20123456786", legalName: "OTRA EMPRESA S.A.C." }));
      expect([ca.status, cb.status]).toEqual([201, 201]);
      a = { id: ca.json.id, ruc: ca.json.ruc };
      b = { id: cb.json.id, ruc: cb.json.ruc };

      // Datos de la empresa A
      const emitted = await api.request("POST", A("/cpe"), invoiceBody());
      expect(emitted.status).toBe(201);
      cpeA = emitted.json.cpeId;
      const purchase = await api.request("POST", A("/purchases"), purchaseBody());
      expect(purchase.status).toBe(201);
      carA = purchase.json.car;
      expect((await api.request("POST", A("/journal-entries"), entryBody())).status).toBe(201);
      const draft = await api.request("POST", A("/journal-entries"), entryBody({ status: "DRAFT", glosa: "Borrador A" }));
      expect(draft.status).toBe(201);
      draftA = draft.json.id;
      expect((await api.request("POST", A("/series"), { cpeType: "01", series: "F777" })).status).toBe(201);
    });

    describe("lectura", () => {
      it("no devuelve un comprobante de A por la ruta de B y no lo lista", async () => {
        const crossed = await api.request("GET", B(`/cpe/${cpeA}`));
        expect(crossed.status).toBe(404);
        expect(JSON.stringify(crossed.json)).not.toContain(a.ruc);
        const list = await api.request("GET", B("/cpe?limit=200"));
        expect(list.status).toBe(200);
        expect(list.json.data).toHaveLength(0);
      });

      it("no lista ni resume compras de A, ni las encuentra por CAR", async () => {
        const list = await api.request("GET", B("/purchases?period=2026-03"));
        expect(list.json.data).toHaveLength(0);
        const summary = await api.request("GET", B("/purchases/summary?period=2026-03"));
        expect(summary.json.totalDocuments).toBe(0);
        expect((await api.request("GET", B(`/purchases/${carA}`))).status).toBe(404);
      });

      it("no muestra asientos, balance ni Mayor de A", async () => {
        const entries = await api.request("GET", B("/journal-entries?period=2026-03"));
        expect(entries.json.data).toHaveLength(0);
        const balance = await api.request("GET", B("/trial-balance?period=2026-03"));
        expect(balance.status).toBe(200);
        expect(JSON.stringify(balance.json)).not.toContain("1180");
        const ledger = await api.request("GET", B("/general-ledger?period=2026-03"));
        expect(ledger.status).toBe(200);
        expect(JSON.stringify(ledger.json)).not.toContain("1180");
      });

      it("no muestra las series de A", async () => {
        const series = await api.request("GET", B("/series"));
        expect(series.json.data.map((s: { series: string }) => s.series)).not.toContain("F777");
      });
    });

    describe("escritura", () => {
      it("no cambia el estado SIRE de una compra de A", async () => {
        const crossed = await api.request("PATCH", B(`/purchases/${carA}/sire-status`), { status: "EXCLUIDO" });
        expect(crossed.status).toBe(404);
        const original = await api.request("GET", A(`/purchases/${carA}`));
        expect(original.json.sireStatus).not.toBe("EXCLUIDO");
      });

      it("no contabiliza un borrador de A", async () => {
        const crossed = await api.request("POST", B(`/journal-entries/${draftA}/post`));
        expect(crossed.status).toBe(404);
        const entries = await api.request("GET", A("/journal-entries?period=2026-03"));
        const draft = entries.json.data.find((e: { id: string }) => e.id === draftA);
        expect(draft.status).not.toBe("POSTED");
      });

      it("cerrar el período en B no cierra el de A", async () => {
        expect((await api.request("POST", B("/periods/2026-03/close"), { allowEmptyPeriod: true })).status).toBe(200);
        const periodA = await api.request("GET", A("/periods/2026-03"));
        expect(periodA.json.status).not.toBe("CLOSED");
        expect((await api.request("POST", A("/journal-entries"), entryBody())).status).toBe(201);
      });

      it("ignora companyId y companyRuc de A enviados en el cuerpo", async () => {
        const entry = await api.request("POST", B("/journal-entries"), entryBody({ companyId: a.id }));
        expect(entry.status).toBe(201);
        expect(entry.json.companyId).toBe(b.id);

        const purchase = await api.request("POST", B("/purchases"), purchaseBody({ companyRuc: a.ruc, correlative: 9001 }));
        expect(purchase.status).toBe(201);
        expect(purchase.json.companyRuc).toBe(b.ruc);

        const cpe = await api.request("POST", B("/cpe"), invoiceBody({ companyId: a.id }));
        expect(cpe.status).toBe(201);
        const stored = await api.request("GET", B(`/cpe/${cpe.json.cpeId}`));
        expect(stored.json.document.companyId).toBe(b.id);

        // A sigue con solo sus propios registros
        expect((await api.request("GET", A("/journal-entries?period=2026-03"))).json.data).toHaveLength(2);
        expect((await api.request("GET", A("/purchases?period=2026-03"))).json.data).toHaveLength(1);
        expect((await api.request("GET", A("/cpe"))).json.data).toHaveLength(1);
      });

      it("numera los comprobantes de cada empresa por separado", async () => {
        const firstB = await api.request("POST", B("/cpe"), invoiceBody());
        expect(firstB.json.fullNumber).toBe("F001-00000001");
        const secondA = await api.request("POST", A("/cpe"), invoiceBody());
        expect(secondA.json.fullNumber).toBe("F001-00000002");
      });

      it("no permite cambiar el RUC de B por el de A al actualizar", async () => {
        await api.request("PATCH", `/api/companies/${b.id}`, { ruc: a.ruc, tradeName: "OTRA" });
        const company = await api.request("GET", `/api/companies/${b.id}`);
        expect(company.json.ruc).toBe(b.ruc);
      });
    });
  });
}
