import { describe, expect, it, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { CompanyRepository } from "../../database/repositories/company.repository.js";
import { CpeRepository } from "../../database/repositories/cpe.repository.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { CpePrintService } from "../printing/pdf-renderer.js";
import { CpeEmissionOrchestrator } from "../cpe/cpe-orchestrator.js";
import { EmitCpeRequest } from "../cpe/types.js";

// Helper para emular XML de CDR oficial de SUNAT
function createSampleCdrXml(options: {
  referenceId: string;
  responseCode?: string;
  description?: string;
  notes?: string[];
}): string {
  const responseCode = options.responseCode ?? "0";
  const description = options.description ?? `El comprobante ${options.referenceId} ha sido aceptado`;
  const notesXml = (options.notes || []).map((n) => `<cbc:Note>${n}</cbc:Note>`).join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
                        xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
                        xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>R-${options.referenceId}</cbc:ID>
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ReferenceID>${options.referenceId}</cbc:ReferenceID>
      <cbc:ResponseCode>${responseCode}</cbc:ResponseCode>
      <cbc:Description>${description}</cbc:Description>
    </cac:Response>
    ${notesXml}
  </cac:DocumentResponse>
</ar:ApplicationResponse>`;
}

async function createSampleCdrZipBase64(cdrXml: string, fileName: string): Promise<string> {
  const zip = new JSZip();
  zip.file(fileName, cdrXml);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return buffer.toString("base64");
}

function createSendBillSoapResponse(applicationResponseBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ser="http://service.sunat.gob.pe">
  <soapenv:Body>
    <ser:sendBillResponse>
      <applicationResponse>${applicationResponseBase64}</applicationResponse>
    </ser:sendBillResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
}

describe("Orquestador Integral de Emisión (CpeEmissionOrchestrator)", () => {
  let companyRepo: CompanyRepository;
  let cpeRepo: CpeRepository;
  let auditLogger: AuditLogger;
  let printService: CpePrintService;
  let orchestrator: CpeEmissionOrchestrator;
  let companyId: string;
  const testRuc = "10445533811"; // Persona Natural con Negocio válida

  beforeEach(async () => {
    companyRepo = new CompanyRepository();
    cpeRepo = new CpeRepository();
    auditLogger = new AuditLogger();
    printService = new CpePrintService();

    orchestrator = new CpeEmissionOrchestrator({
      companyRepo,
      cpeRepo,
      auditLogger,
      printService,
    });

    const company = await companyRepo.create({
      ruc: testRuc,
      legalName: "Jose Barrientos Sistemas",
      tradeName: "AYSUNAT SOFTWARE",
      taxRegime: "RMT",
      ubigeo: "150101",
      department: "Lima",
      province: "Lima",
      district: "Lima",
      addressLine: "Av. Nicolás de Piérola 123",
      solUserEncrypted: "MODDATOS",
      solPassEncrypted: "moddatos",
    });
    companyId = company.id;

// Series por defecto ya creadas por companyRepo.create
  });

  it("1. emite una Factura (01) de punta a punta: cálculo, UBL 2.1, firma, ZIP, SOAP y PDF/Ticket", async () => {
    const cdrXml = createSampleCdrXml({
      referenceId: "F001-00000001",
      responseCode: "0",
      description: "La Factura F001-00000001 ha sido aceptada por SUNAT.",
    });
    const zipBase64 = await createSampleCdrZipBase64(cdrXml, "R-10445533811-01-F001-00000001.xml");
    const soapResponseXml = createSendBillSoapResponse(zipBase64);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => soapResponseXml,
    });

    const request: EmitCpeRequest = {
      companyId,
      cpeType: "01",
      series: "F001",
      client: {
        docType: "6",
        docNumber: "20123456789",
        name: "CORPORACION INDUSTRIAL S.A.C.",
        address: "Av. Las Camelias 456, San Isidro",
      },
      paymentMethod: "CONTADO",
      items: [
        {
          code: "SERV-001",
          description: "Desarrollo y Parametrización de Motor Tributario",
          quantity: "1",
          unitPrice: "2360.00",
          priceIncludesIgv: true,
          affectationType: "10",
        },
      ],
    };

    const result = await orchestrator.emitDocument(request, {
      customFetchFn: mockFetch as any,
    });

    // Validaciones del resultado
    expect(result.cpeId).toBeDefined();
    expect(result.fullNumber).toBe("F001-00000001");
    expect(result.status).toBe("ACEPTADO");
    expect(result.calculation.totals.operacionesGravadas).toBe("2000.00");
    expect(result.calculation.totals.montoIgv).toBe("360.00");
    expect(result.calculation.totals.totalPagar).toBe("2360.00");
    expect(result.calculation.totals.totalEnLetras).toContain("DOS MIL TRESCIENTOS SESENTA CON 00/100 SOLES");

    // XML firmado y Hash CPE
    expect(result.xmlSigned).toContain("<Signature");
    expect(result.xmlSigned).toContain("<DigestValue>");
    expect(result.hashCpe).toBeTruthy();

    // Empaquetado ZIP
    expect(result.zipFileName).toBe("10445533811-01-F001-00000001.zip");
    expect(Buffer.isBuffer(result.zipBuffer)).toBe(true);
    expect(result.zipBuffer.length).toBeGreaterThan(500);

    // Respuesta SUNAT
    expect(result.sunatResponse).toBeDefined();
    expect(result.sunatResponse?.status).toBe("ACCEPTED");
    expect(result.sunatResponse?.cdrResponseCode).toBe("0");

    // Representación impresa: PDF y Ticket
    expect(Buffer.isBuffer(result.pdfA4)).toBe(true);
    expect(result.pdfA4?.subarray(0, 4).toString()).toBe("%PDF");
    expect(Buffer.isBuffer(result.ticket80mm)).toBe(true);
    expect(result.ticket80mm?.subarray(0, 4).toString()).toBe("%PDF");

    // QR Tributario oficial SUNAT
    // Formato: RUC|TIPO|SERIE|NUMERO|IGV|TOTAL|FECHA|TIPO_DOC_CLIENTE|NUM_DOC_CLIENTE|HASH
    expect(result.qrPayload).toContain("10445533811|01|F001|00000001|360.00|2360.00|");
    expect(result.qrPayload).toContain(result.hashCpe);

    // Persistencia en base de datos
    const dbCpe = await cpeRepo.findById(result.cpeId);
    expect(dbCpe).not.toBeNull();
    expect(dbCpe?.document.status).toBe("ACEPTADO");
    expect(dbCpe?.document.sunatResponseCode).toBe("0");
    expect(dbCpe?.items.length).toBe(1);

    // Auditoría
    const logs = auditLogger.getLogsByCompany(companyId);
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("EMISION_CPE");
    expect(logs[0].details.fullNumber).toBe("F001-00000001");
  });

  it("2. emite una Boleta de Venta (03) con cliente DNI", async () => {
    const cdrXml = createSampleCdrXml({
      referenceId: "B001-00000001",
      responseCode: "0",
      description: "La Boleta B001-00000001 ha sido aceptada.",
    });
    const zipBase64 = await createSampleCdrZipBase64(cdrXml, "R-10445533811-03-B001-00000001.xml");
    const soapResponseXml = createSendBillSoapResponse(zipBase64);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => soapResponseXml,
    });

    const result = await orchestrator.emitBoleta(
      {
        companyId,
        series: "B001",
        client: {
          docType: "1",
          docNumber: "45678912",
          name: "JUAN PEREZ GONZALES",
        },
        paymentMethod: "CONTADO",
        items: [
          {
            description: "Mouse Ergonómico USB",
            quantity: "2",
            unitPrice: "59.00",
            priceIncludesIgv: true,
            affectationType: "10",
          },
        ],
      },
      { customFetchFn: mockFetch as any },
    );

    expect(result.fullNumber).toBe("B001-00000001");
    expect(result.status).toBe("ACEPTADO");
    expect(result.calculation.totals.totalPagar).toBe("118.00");
    expect(result.qrPayload).toContain("10445533811|03|B001|00000001|");
  });

  it("3. emite una Nota de Crédito (07) que modifica una Factura previa", async () => {
    const cdrXml = createSampleCdrXml({
      referenceId: "FC01-00000001",
      responseCode: "0",
      description: "La Nota de Credito FC01-00000001 ha sido aceptada.",
    });
    const zipBase64 = await createSampleCdrZipBase64(cdrXml, "R-10445533811-07-FC01-00000001.xml");
    const soapResponseXml = createSendBillSoapResponse(zipBase64);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => soapResponseXml,
    });

    const result = await orchestrator.emitCreditNote(
      {
        companyId,
        series: "FC01",
        client: {
          docType: "6",
          docNumber: "20123456789",
          name: "CORPORACION INDUSTRIAL S.A.C.",
        },
        paymentMethod: "CONTADO",
        items: [
          {
            description: "Descuento total por anulación de la operación",
            quantity: "1",
            unitPrice: "1000.00",
            priceIncludesIgv: true,
            affectationType: "10",
          },
        ],
        creditNoteInfo: {
          modifiedDocType: "01",
          modifiedDocSeries: "F001",
          modifiedDocCorrelative: 1,
          discrepancyCode: "01",
          discrepancyReason: "Anulación de la operación",
        },
      },
      { customFetchFn: mockFetch as any },
    );

    expect(result.fullNumber).toBe("FC01-00000001");
    expect(result.status).toBe("ACEPTADO");
    expect(result.xmlSigned).toContain("<cac:BillingReference>");
    expect(result.xmlSigned).toContain("<cbc:DocumentTypeCode");
    expect(result.xmlSigned).toContain("F001-00000001");
  });

  it("4. detecta y registra observaciones de SUNAT (ACEPTADO_CON_OBSERVACIONES)", async () => {
    const cdrXml = createSampleCdrXml({
      referenceId: "F001-00000002",
      responseCode: "0",
      description: "La Factura fue aceptada con observaciones.",
      notes: ["Obs 4000: El RUC del receptor no se encuentra en estado habido"],
    });
    const zipBase64 = await createSampleCdrZipBase64(cdrXml, "R-10445533811-01-F001-00000002.xml");
    const soapResponseXml = createSendBillSoapResponse(zipBase64);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => soapResponseXml,
    });

    const result = await orchestrator.emitInvoice(
      {
        companyId,
        series: "F001",
        client: {
          docType: "6",
          docNumber: "20123456789",
          name: "EMPRESA NO HABIDA S.A.C.",
        },
        paymentMethod: "CONTADO",
        items: [
          {
            description: "Servicio general",
            quantity: "1",
            unitPrice: "118.00",
            priceIncludesIgv: true,
            affectationType: "10",
          },
        ],
      },
      { customFetchFn: mockFetch as any },
    );

    expect(result.status).toBe("ACEPTADO_CON_OBSERVACIONES");
    expect(result.sunatResponse?.notes?.length).toBe(1);
    expect(result.sunatResponse?.notes?.[0]).toContain("Obs 4000");

    const saved = await cpeRepo.findById(result.cpeId);
    expect(saved?.document.status).toBe("ACEPTADO_CON_OBSERVACIONES");
  });

  it("5. registra rechazo por error tributario de SUNAT (status RECHAZADO)", async () => {
    const cdrXml = createSampleCdrXml({
      referenceId: "F001-00000003",
      responseCode: "2011",
      description: "El RUC del emisor se encuentra en estado NO HABIDO.",
    });
    const zipBase64 = await createSampleCdrZipBase64(cdrXml, "R-10445533811-01-F001-00000003.xml");
    const soapResponseXml = createSendBillSoapResponse(zipBase64);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => soapResponseXml,
    });

    const result = await orchestrator.emitInvoice(
      {
        companyId,
        series: "F001",
        client: {
          docType: "6",
          docNumber: "20123456789",
          name: "CLIENTE S.A.C.",
        },
        paymentMethod: "CONTADO",
        items: [
          {
            description: "Venta de prueba",
            quantity: "1",
            unitPrice: "100.00",
            priceIncludesIgv: true,
            affectationType: "10",
          },
        ],
      },
      { customFetchFn: mockFetch as any },
    );

    expect(result.status).toBe("RECHAZADO");
    expect(result.sunatResponse?.cdrResponseCode).toBe("2011");

    const saved = await cpeRepo.findById(result.cpeId);
    expect(saved?.document.status).toBe("RECHAZADO");
  });

  it("6. permite emisión offline / sin envío inmediato a SUNAT (sendToSunat: false)", async () => {
    const result = await orchestrator.emitInvoice(
      {
        companyId,
        series: "F001",
        client: {
          docType: "6",
          docNumber: "20123456789",
          name: "CLIENTE LOCAL S.A.C.",
        },
        paymentMethod: "CONTADO",
        items: [
          {
            description: "Servicio emitido offline para contingencia",
            quantity: "1",
            unitPrice: "500.00",
            priceIncludesIgv: true,
            affectationType: "10",
          },
        ],
      },
      { sendToSunat: false },
    );

    expect(result.status).toBe("FIRMADO");
    expect(result.sunatResponse).toBeUndefined();
    expect(result.xmlSigned).toBeTruthy();
    expect(result.zipBuffer).toBeTruthy();
    expect(result.pdfA4).toBeTruthy();
    expect(result.qrPayload).toBeTruthy();
  });

  it("7. respeta la secuencia estricta de correlativos incrementales", async () => {
    const emitOpts = { sendToSunat: false };
    const reqBase = {
      companyId,
      series: "F001",
      client: { docType: "6" as const, docNumber: "20123456789", name: "CLIENTE SECUENCIA" },
      paymentMethod: "CONTADO" as const,
      items: [{ description: "Item 1", quantity: "1", unitPrice: "10.00", priceIncludesIgv: true, affectationType: "10" as const }],
    };

    const doc1 = await orchestrator.emitInvoice(reqBase, emitOpts);
    const doc2 = await orchestrator.emitInvoice(reqBase, emitOpts);

    expect(doc1.fullNumber).toBe("F001-00000001");
    expect(doc2.fullNumber).toBe("F001-00000002");
  });

  it("8. rechaza la emisión de Facturas si el régimen tributario es NRUS", async () => {
    const nrusCompany = await companyRepo.create({
      ruc: "10987654321",
      legalName: "Bodega Don Pepe",
      taxRegime: "NRUS",
      ubigeo: "150101",
      department: "Lima",
      province: "Lima",
      district: "Lima",
      addressLine: "Jr. Comercio 123",
    });
// En NRUS no se crean series de factura

    await expect(
      orchestrator.emitInvoice({
        companyId: nrusCompany.id,
        series: "F001",
        client: { docType: "6", docNumber: "20123456789", name: "CLIENTE SAC" },
        paymentMethod: "CONTADO",
        items: [{ description: "Producto", quantity: "1", unitPrice: "10.00", priceIncludesIgv: true, affectationType: "10" }],
      }),
    ).rejects.toThrow(/no permite emitir comprobantes tipo 01/);
  });
});
