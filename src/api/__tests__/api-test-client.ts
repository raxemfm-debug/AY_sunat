import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiServer, ApiServerOptions } from "../http-server.js";

export interface ApiTestClient {
  baseUrl: string;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
  close(): Promise<void>;
}

/** Levanta el servidor real en un puerto efímero de loopback. */
export async function startApi(options: Omit<ApiServerOptions, "host">, token?: string): Promise<ApiTestClient> {
  const server: Server = createApiServer({ ...options, host: "127.0.0.1", bearerToken: token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    async request(method, path, body, headers = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : undefined };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export const companyBody = (over: Record<string, unknown> = {}) => ({
  ruc: "10445533811",
  legalName: "Jose Barrientos Negocios",
  tradeName: "AYSUNAT",
  taxRegime: "RMT",
  ubigeo: "150101",
  department: "LIMA",
  province: "LIMA",
  district: "LIMA",
  addressLine: "Av. Las Begonias 456",
  ...over,
});

export const invoiceBody = (over: Record<string, unknown> = {}) => ({
  cpeType: "01",
  series: "F001",
  issueDate: "2026-03-05",
  client: { docType: "6", docNumber: "20123456789", name: "CORPORACION INDUSTRIAL S.A.C." },
  paymentMethod: "CONTADO",
  items: [
    {
      code: "SERV-001",
      description: "Servicio de consultoría",
      quantity: "1",
      unitPrice: "2360.00",
      priceIncludesIgv: true,
      affectationType: "10",
    },
  ],
  ...over,
});

export const purchaseBody = (over: Record<string, unknown> = {}) => ({
  supplier: { docType: "6", docNumber: "20123456786", name: "PROVEEDOR CENTRAL S.A.C." },
  docType: "01",
  series: "F001",
  correlative: 1234,
  issueDate: "2026-03-05",
  accountingPeriod: "2026-03",
  currency: "PEN",
  paymentMethod: "CONTADO",
  isBancarizado: true,
  items: [{ description: "Mercadería", quantity: 10, unitValue: 100, taxDestination: "GRAVADO_EXCLUSIVO" }],
  ...over,
});

export const entryBody = (over: Record<string, unknown> = {}) => ({
  accountingPeriod: "2026-03",
  entryDate: "2026-03-05",
  glosa: "Venta F001-00000001",
  lines: [
    { accountCode: "1212", debit: "1180.00" },
    { accountCode: "40111", credit: "180.00" },
    { accountCode: "70121", credit: "1000.00" },
  ],
  ...over,
});
