import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistence } from "../../database/persistence.js";
import { createApiServices, ApiServices, EmissionSettings } from "../app-services.js";
import { ApiTestClient, companyBody, entryBody, invoiceBody, purchaseBody, startApi } from "./api-test-client.js";

describe("API REST persistente (almacenamiento en memoria)", () => {
  let api: ApiTestClient;
  let services: ApiServices;
  let companyId: string;
  const logged: unknown[] = [];

  async function boot(settings: Partial<EmissionSettings> = {}) {
    services = createApiServices(createPersistence({ allowMemory: true }), settings);
    api = await startApi({ services, logError: (error) => logged.push(error) });
    const created = await api.request("POST", "/api/companies", companyBody());
    companyId = created.json?.id;
  }

  beforeEach(async () => {
    logged.length = 0;
    await boot();
  });
  afterEach(async () => api.close());

  describe("seguridad y protocolo", () => {
    it("exige una sesión de usuario, salvo en /health", async () => {
      const health = await fetch(`${api.baseUrl}/health`);
      expect(health.status).toBe(200);
      const anonymous = await fetch(`${api.baseUrl}/api/companies`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
      const wrong = await api.request("GET", "/api/companies", undefined, { authorization: "Bearer otro-token-xyz" });
      expect(wrong.status).toBe(401);
      expect((await api.request("GET", "/api/companies")).status).toBe(200);
    });

    it("responde 404, 405 y 415 con el formato de error estándar", async () => {
      expect((await api.request("GET", "/api/no-existe")).json.error.code).toBe("NOT_FOUND");
      expect((await api.request("DELETE", "/api/companies")).status).toBe(405);
      const notJson = await api.request("POST", "/api/companies", "ruc=1", { "content-type": "text/plain" });
      expect(notJson.status).toBe(415);
    });

    it("oculta los errores internos y los registra sin exponerlos", async () => {
      services.companies.findById = async () => {
        throw new TypeError("detalle interno secreto");
      };
      const response = await api.request("GET", "/api/companies");
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.json)).not.toContain("secreto");
      expect(logged).toHaveLength(1);
    });
  });

  describe("empresas y series", () => {
    it("registra la empresa sin exponer credenciales SOL", async () => {
      const response = await api.request("GET", `/api/companies/${companyId}`);
      expect(response.status).toBe(200);
      expect(response.json.ruc).toBe("10445533811");
      expect(response.json.hasSolCredentials).toBe(false);
      expect(response.json).not.toHaveProperty("solUserEncrypted");
      expect(response.json).not.toHaveProperty("solPassEncrypted");
    });

    it("ignora credenciales SOL enviadas en el cuerpo", async () => {
      const response = await api.request("POST", "/api/companies", companyBody({
        ruc: "20123456786",
        solUserEncrypted: "USUARIO",
        solPassEncrypted: "CLAVE",
      }));
      expect(response.status).toBe(201);
      expect(response.json.hasSolCredentials).toBe(false);
    });

    it("rechaza RUC duplicado (409), mal formado (400) y empresa inexistente (404)", async () => {
      expect((await api.request("POST", "/api/companies", companyBody())).status).toBe(409);
      expect((await api.request("POST", "/api/companies", companyBody({ ruc: "123" }))).status).toBe(400);
      expect((await api.request("GET", "/api/companies/no-existe")).status).toBe(404);
    });

    it("actualiza datos permitidos y crea series nuevas", async () => {
      const patched = await api.request("PATCH", `/api/companies/${companyId}`, { tradeName: "AYSUNAT PLUS" });
      expect(patched.json.tradeName).toBe("AYSUNAT PLUS");
      const series = await api.request("POST", `/api/companies/${companyId}/series`, { cpeType: "01", series: "F002" });
      expect(series.status).toBe(201);
      const list = await api.request("GET", `/api/companies/${companyId}/series`);
      expect(list.json.data.map((s: { series: string }) => s.series)).toContain("F002");
      expect((await api.request("POST", `/api/companies/${companyId}/series`, { cpeType: "01", series: "F002" })).status).toBe(409);
    });
  });

  describe("emisión de comprobantes", () => {
    it("emite una factura, la guarda y asigna correlativos consecutivos", async () => {
      const first = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody());
      expect(first.status).toBe(201);
      expect(first.json.fullNumber).toBe("F001-00000001");
      expect(first.json.status).toBe("FIRMADO");
      expect(first.json.sunatResponse).toBeNull();
      expect(first.json.totals.totalPagar).toBe("2360.00");
      expect(first.json.hashCpe).toBeTruthy();
      expect(first.json).not.toHaveProperty("files");

      const second = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody());
      expect(second.json.fullNumber).toBe("F001-00000002");

      const stored = await api.request("GET", `/api/companies/${companyId}/cpe/${first.json.cpeId}`);
      expect(stored.status).toBe(200);
      expect(stored.json.document.status).toBe("FIRMADO_XML");
      expect(stored.json.items).toHaveLength(1);

      const list = await api.request("GET", `/api/companies/${companyId}/cpe?cpeType=01&limit=10`);
      expect(list.json.data).toHaveLength(2);
    });

    it("devuelve XML, ZIP y PDF solo cuando se piden", async () => {
      const response = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody({
        options: { returnFiles: ["xml", "zip", "pdf"] },
      }));
      expect(response.status).toBe(201);
      expect(response.json.files.xmlSigned).toContain("<Signature");
      expect(Buffer.from(response.json.files.zipBase64, "base64").subarray(0, 2).toString()).toBe("PK");
      expect(Buffer.from(response.json.files.pdfA4Base64, "base64").subarray(0, 4).toString()).toBe("%PDF");
      expect(response.json.files.ticket80mmBase64).toBeUndefined();
    });

    it("emite una nota de crédito que referencia la factura", async () => {
      await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody());
      const response = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody({
        cpeType: "07",
        series: "FC01",
        creditNoteInfo: {
          discrepancyCode: "01",
          discrepancyReason: "Anulación de la operación",
          modifiedDocType: "01",
          modifiedDocSeries: "F001",
          modifiedDocCorrelative: 1,
        },
      }));
      expect(response.status).toBe(201);
      expect(response.json.fullNumber).toBe("FC01-00000001");
    });

    it("valida la estructura (400) y las reglas tributarias (422)", async () => {
      const noFlag = invoiceBody({ items: [{ description: "x", quantity: 1, unitPrice: 10, affectationType: "10" }] });
      expect((await api.request("POST", `/api/companies/${companyId}/cpe`, noFlag)).status).toBe(400);
      const badCode = invoiceBody({ items: [{ description: "x", quantity: 1, unitPrice: 10, priceIncludesIgv: true, affectationType: "99" }] });
      expect((await api.request("POST", `/api/companies/${companyId}/cpe`, badCode)).status).toBe(400);
      expect((await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody({ cpeType: "07" }))).status).toBe(400);
      const badClient = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody({
        client: { docType: "6", docNumber: "123", name: "CLIENTE" },
      }));
      expect(badClient.status).toBe(422);
    });

    it("no envía a SUNAT si el servidor no lo habilita", async () => {
      const response = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody({ options: { sendToSunat: true } }));
      expect(response.status).toBe(409);
      expect(response.json.error.code).toBe("SUNAT_SEND_DISABLED");
    });

    it("exige certificado propio cuando el servidor lo requiere (producción)", async () => {
      await api.close();
      await boot({ requireCertificate: true });
      const response = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody());
      expect(response.status).toBe(503);
      expect(response.json.error.code).toBe("CERTIFICATE_NOT_CONFIGURED");
    });

    it("no muestra comprobantes de otra empresa", async () => {
      const other = await api.request("POST", "/api/companies", companyBody({ ruc: "20123456786" }));
      const emitted = await api.request("POST", `/api/companies/${companyId}/cpe`, invoiceBody());
      const crossed = await api.request("GET", `/api/companies/${other.json.id}/cpe/${emitted.json.cpeId}`);
      expect(crossed.status).toBe(404);
    });
  });

  describe("compras (RCE)", () => {
    it("registra, lista, resume y actualiza el estado SIRE", async () => {
      const created = await api.request("POST", `/api/companies/${companyId}/purchases`, purchaseBody({ companyRuc: "99999999999" }));
      expect(created.status).toBe(201);
      expect(created.json.companyRuc).toBe("10445533811");
      const car = created.json.car;

      const list = await api.request("GET", `/api/companies/${companyId}/purchases?period=2026-03`);
      expect(list.json.data).toHaveLength(1);
      const summary = await api.request("GET", `/api/companies/${companyId}/purchases/summary?period=2026-03`);
      expect(summary.json.totalDocuments).toBe(1);

      const one = await api.request("GET", `/api/companies/${companyId}/purchases/${car}`);
      expect(one.json.car).toBe(car);
      const patched = await api.request("PATCH", `/api/companies/${companyId}/purchases/${car}/sire-status`, { status: "ACEPTADO" });
      expect(patched.json.sireStatus).toBe("ACEPTADO");
    });

    it("bloquea comprobantes duplicados y períodos mal formados", async () => {
      await api.request("POST", `/api/companies/${companyId}/purchases`, purchaseBody());
      const duplicate = await api.request("POST", `/api/companies/${companyId}/purchases`, purchaseBody({ accountingPeriod: "2026-04" }));
      expect(duplicate.status).toBe(409);
      expect(duplicate.json.error.code).toBe("DUPLICATE_PURCHASE");
      expect((await api.request("GET", `/api/companies/${companyId}/purchases?period=2026-13`)).status).toBe(400);
      expect((await api.request("GET", `/api/companies/${companyId}/purchases/NOEXISTE`)).status).toBe(404);
    });
  });

  describe("contabilidad", () => {
    it("registra asientos, genera reportes y respeta el cierre mensual", async () => {
      const entry = await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody());
      expect(entry.status).toBe(201);
      expect(entry.json.companyId).toBe(companyId);

      const list = await api.request("GET", `/api/companies/${companyId}/journal-entries?period=2026-03`);
      expect(list.json.data).toHaveLength(1);
      const balance = await api.request("GET", `/api/companies/${companyId}/trial-balance?period=2026-03`);
      expect(balance.status).toBe(200);
      const ledger = await api.request("GET", `/api/companies/${companyId}/general-ledger?period=2026-03`);
      expect(ledger.status).toBe(200);

      const closed = await api.request("POST", `/api/companies/${companyId}/periods/2026-03/close`, { closedBy: "contador" });
      expect(closed.status).toBe(200);
      expect(closed.json.status).toBe("CLOSED");

      const blocked = await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody());
      expect(blocked.status).toBe(409);

      const reopened = await api.request("POST", `/api/companies/${companyId}/periods/2026-03/reopen`, {
        reopenedBy: "contador",
        reason: "Ajuste de provisión",
      });
      expect(reopened.json.status).toBe("OPEN");
      expect((await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody())).status).toBe(201);
    });

    it("rechaza asientos descuadrados (422) y exige motivo para reabrir (400)", async () => {
      const unbalanced = await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody({
        lines: [{ accountCode: "1212", debit: "100.00" }, { accountCode: "70121", credit: "90.00" }],
      }));
      expect(unbalanced.status).toBe(422);
      expect((await api.request("POST", `/api/companies/${companyId}/periods/2026-03/reopen`, { reopenedBy: "x" })).status).toBe(400);
    });

    it("registra un borrador y lo contabiliza después", async () => {
      const draft = await api.request("POST", `/api/companies/${companyId}/journal-entries`, entryBody({ status: "DRAFT" }));
      expect(draft.status).toBe(201);
      expect(draft.json.status).not.toBe("POSTED");
      const posted = await api.request("POST", `/api/companies/${companyId}/journal-entries/${draft.json.id}/post`);
      expect(posted.status).toBe(200);
      expect(posted.json.status).toBe("POSTED");
    });
  });
});
