import { calculateCpe } from "../../core/tax-engine/cpe-calculator.js";
import { getTaxRegimeConfig } from "../../core/tax-engine/tax-config.js";
import {
  CpeDocumentCalculationResult,
  CpeDocumentInput,
  CurrencyCode,
} from "../../core/tax-engine/types.js";
import { CompanyRepository, ICompanyRepository } from "../../database/repositories/company.repository.js";
import { CpeRepository, ICpeRepository } from "../../database/repositories/cpe.repository.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { CompanyService } from "../company/company.service.js";
import { createCpeZip } from "../packaging/zip-packager.js";
import { CpePrintService } from "../printing/pdf-renderer.js";
import { buildSunatQrPayload } from "../printing/sunat-qr.js";
import { CompanyBranding, PrintableCpe } from "../printing/types.js";
import { CertificateData } from "../signing/types.js";
import { generateSelfSignedCertificate } from "../signing/certificate.service.js";
import { signUblXml } from "../signing/xml-signer.js";
import { SunatSoapClient } from "../sunat-soap/sunat-soap-client.js";
import { SendBillResult, SendBillStatus } from "../sunat-soap/types.js";
import { generateUblXml } from "../ubl/ubl-builder.js";
import { validateUblXmlAgainstXsd } from "../ubl/xsd-validator.js";
import {
  CpeLifecycleStatus,
  EmitCpeOptions,
  EmitCpeRequest,
  EmitCpeResult,
} from "./types.js";

export function mapCalculationToPrintableCpe(params: {
  input: CpeDocumentInput;
  calculation: CpeDocumentCalculationResult;
  hashCpe: string;
  qrPayload?: string;
  branding?: CompanyBranding;
}): PrintableCpe {
  const { input, calculation, hashCpe, qrPayload, branding } = params;

  return {
    type: input.cpeType,
    series: input.series,
    number: String(input.correlative).padStart(8, "0"),
    issueDate: input.issueDate,
    issueTime: input.issueTime,
    paymentMethod: input.paymentMethod,
    issuer: {
      ruc: input.company.ruc,
      legalName: input.company.legalName,
      tradeName: input.company.tradeName,
      address: input.company.address.addressLine,
    },
    customer: {
      documentType: input.client.docType,
      documentNumber: input.client.docNumber,
      name: input.client.name,
      address: input.client.address,
    },
    lines: calculation.items.map((item) => ({
      quantity: Number(item.quantity),
      unitCode: item.unitCode,
      description: item.description,
      unitValue: Number(item.unitValue),
      unitPrice: Number(item.unitPrice),
      lineExtensionAmount: Number(item.baseAmount),
      igvAmount: Number(item.igvAmount),
      totalAmount: Number(item.totalAmount),
    })),
    totals: {
      taxable: Number(calculation.totals.operacionesGravadas),
      exempt: Number(calculation.totals.operacionesExoneradas),
      unaffected: Number(calculation.totals.operacionesInafectas),
      free: Number(calculation.totals.operacionesGratuitas),
      igv: Number(calculation.totals.montoIgv),
      total: Number(calculation.totals.totalPagar),
      currency: input.currency,
      amountInWords: calculation.totals.totalEnLetras,
    },
    hashCpe,
    qrPayload,
    modifiedDocument: input.creditNoteInfo
      ? {
          documentType: input.creditNoteInfo.modifiedDocType,
          series: input.creditNoteInfo.modifiedDocSeries,
          number: String(input.creditNoteInfo.modifiedDocCorrelative).padStart(8, "0"),
          reasonCode: input.creditNoteInfo.discrepancyCode,
          reasonDescription: input.creditNoteInfo.discrepancyReason,
        }
      : undefined,
    branding,
  };
}

export interface CpeEmissionOrchestratorConfig {
  companyRepo?: ICompanyRepository;
  companyService?: CompanyService;
  cpeRepo?: ICpeRepository;
  auditLogger?: AuditLogger;
  printService?: CpePrintService;
  defaultCertData?: CertificateData;
  defaultEnvironment?: "beta" | "production";
}

/** Fecha (YYYY-MM-DD) y hora (HH:mm:ss) en America/Lima. */
export function limaDateTime(instant: Date): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Lima",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

export class CpeEmissionOrchestrator {
  private companyRepo: ICompanyRepository;
  private companyService?: CompanyService;
  private cpeRepo: ICpeRepository;
  private auditLogger: AuditLogger;
  private printService: CpePrintService;
  private defaultCertData?: CertificateData;
  private defaultEnvironment: "beta" | "production";

  constructor(config: CpeEmissionOrchestratorConfig = {}) {
    this.companyRepo = config.companyRepo || new CompanyRepository();
    this.companyService = config.companyService;
    this.cpeRepo = config.cpeRepo || new CpeRepository();
    this.auditLogger = config.auditLogger || new AuditLogger();
    this.printService = config.printService || new CpePrintService();
    this.defaultCertData = config.defaultCertData;
    this.defaultEnvironment = config.defaultEnvironment || "beta";
  }

  /**
   * Ejecuta el ciclo integral de emisión de comprobantes electrónicos:
   * 1. Validación de empresa y reglas tributarias SUNAT.
   * 2. Asignación secuencial de serie y correlativo.
   * 3. Determinación de importes, base imponible e IGV (motor de cálculo decimal).
   * 4. Registro inicial en capa de persistencia (Base de Datos).
   * 5. Construcción de XML UBL 2.1 oficial (y validación XSD opcional).
   * 6. Firma digital XMLDSig y extracción del Hash CPE (DigestValue).
   * 7. Empaquetado oficial en archivo ZIP {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}.zip.
   * 8. Envío a SUNAT vía SOAP sendBill y procesamiento del CDR de respuesta.
   * 9. Generación de representación impresa (PDF A4 y Ticket 80mm con QR y Hash).
   * 10. Bitácora inmutable de auditoría.
   */
  public async emitDocument(
    request: EmitCpeRequest,
    options: EmitCpeOptions = {},
  ): Promise<EmitCpeResult> {
    // 1. Resolver y validar datos de la empresa emisora
    const companyData = await this.resolveCompany(request.companyId);

    // Validación temprana de régimen tributario y tipo de CPE permitido
    const regimeConfig = getTaxRegimeConfig(companyData.taxRegime);
    if (!regimeConfig.allowedCpeTypes.includes(request.cpeType)) {
      throw new Error(`El régimen ${regimeConfig.name} no permite emitir comprobantes tipo ${request.cpeType}.`);
    }

    // 2. Obtener correlativo secuencial garantizado
    const { correlative, fullNumber } = await this.resolveCorrelative(
      companyData.id,
      request.cpeType,
      request.series,
    );

    // Fecha y hora oficiales de Perú (UTC-5), independientes de la zona horaria del servidor.
    const limaNow = limaDateTime(new Date());
    const issueDate = request.issueDate || limaNow.date;
    const issueTime = request.issueTime || limaNow.time;

    // 3. Preparar payload normativo para el motor de cálculo
    const cpeInput: CpeDocumentInput = {
      company: {
        ruc: companyData.ruc,
        legalName: companyData.legalName,
        tradeName: companyData.tradeName,
        taxRegime: companyData.taxRegime,
        address: companyData.address,
      },
      client: request.client,
      cpeType: request.cpeType,
      series: request.series,
      correlative,
      issueDate,
      issueTime,
      currency: request.currency || "PEN",
      exchangeRate: request.exchangeRate,
      paymentMethod: request.paymentMethod,
      globalDiscountAmount: request.globalDiscountAmount,
      items: request.items,
      creditNoteInfo: request.creditNoteInfo,
    };

    // 4. Ejecución del cálculo tributario determinista con validaciones
    const calculation = calculateCpe(cpeInput);

    // 5. Persistencia inicial en Base de Datos (Estado: CALCULADO)
    const aggregate = await this.cpeRepo.create(
      {
        companyId: companyData.id,
        cpeType: request.cpeType,
        series: request.series,
        correlative,
        fullNumber,
        issueDate,
        issueTime,
        currency: cpeInput.currency,
        exchangeRate: cpeInput.exchangeRate ? String(cpeInput.exchangeRate) : undefined,
        paymentMethod: request.paymentMethod,
        clientDocType: request.client.docType,
        clientDocNumber: request.client.docNumber,
        clientName: request.client.name,
        clientAddress: request.client.address,
        clientEmail: request.client.email,
        operacionesGravadas: calculation.totals.operacionesGravadas,
        operacionesExoneradas: calculation.totals.operacionesExoneradas,
        operacionesInafectas: calculation.totals.operacionesInafectas,
        operacionesGratuitas: calculation.totals.operacionesGratuitas,
        totalDescuentos: calculation.totals.totalDescuentos,
        montoIgv: calculation.totals.montoIgv,
        subtotal: calculation.totals.subTotal,
        totalPagar: calculation.totals.totalPagar,
        totalLetras: calculation.totals.totalEnLetras,
        status: "CALCULADO",
        rawPayload: calculation.sunatXmlReadyPayload,
      },
      calculation.items.map((it, idx) => ({
        lineNumber: idx + 1,
        itemCode: it.code,
        description: it.description,
        unitCode: it.unitCode,
        quantity: it.quantity,
        unitValue: it.unitValue,
        unitPrice: it.unitPrice,
        affectationType: it.affectationType,
        discountAmount: it.discountAmount,
        igvAmount: it.igvAmount,
        totalAmount: it.totalAmount,
      })),
    );
    const cpeId = aggregate.document.id;

    // 6. Generación de XML UBL 2.1
    const rawXml = generateUblXml(calculation, cpeInput);

    // Validación opcional contra esquemas XSD oficiales
    if (options.validateXsd) {
      const xsdResult = await validateUblXmlAgainstXsd(rawXml, request.cpeType);
      if (!xsdResult.valid) {
        throw new Error(
          `Error de validación contra esquema XSD de SUNAT:\n- ${xsdResult.errors.join("\n- ")}`,
        );
      }
    }

    // 7. Firma digital XMLDSig
    const certData = this.resolveCertificate(options.certificateData);
    const signResult = signUblXml(rawXml, certData);
    const signedXml = signResult.signedXml;
    const hashCpe = (signResult as any).hashCpe || (signResult as any).digestValue;

    await this.cpeRepo.updateStatus(cpeId, {
      status: "FIRMADO_XML",
      xmlHash: hashCpe,
    });

    // 8. Empaquetado ZIP oficial {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}.zip
    const zipResult = await createCpeZip(
      {
        ruc: companyData.ruc,
        cpeType: request.cpeType,
        series: request.series,
        correlative,
      },
      signedXml,
    );
    const zipBuffer = zipResult.zipBuffer;
    const zipFileName = zipResult.zipFileName;

    // 9. Envío a SUNAT y procesamiento de CDR (si sendToSunat no fue desactivado)
    let currentStatus: CpeLifecycleStatus = "FIRMADO";
    let sunatResponseSummary: EmitCpeResult["sunatResponse"] = undefined;

    if (options.sendToSunat !== false) {
      const solUser =
        options.solCredentials?.usuarioSol ||
        companyData.solUser ||
        "MODDATOS";
      const solPass =
        options.solCredentials?.claveSol ||
        companyData.solPass ||
        "moddatos";

      const sunatClient = new SunatSoapClient({
        credentials: {
          ruc: companyData.ruc,
          username: solUser,
          password: solPass,
        },
        environment: options.sunatEnvironment || this.defaultEnvironment,
        fetchFn: options.customFetchFn,
      });

      const sendResult: SendBillResult = await sunatClient.sendBillZip(zipFileName, zipBuffer);


      sunatResponseSummary = {
        status: sendResult.status,
        httpStatusCode: sendResult.httpStatusCode,
        cdrResponseCode: sendResult.cdr?.responseCode,
        cdrDescription: sendResult.cdr?.description,
        notes: sendResult.cdr?.notes,
        cdrRawXml: sendResult.cdr?.xmlContent,
        faultMessage: sendResult.fault?.faultString,
      };

      if (sendResult.status === "ACCEPTED") {
        currentStatus = "ACEPTADO";
        await this.cpeRepo.attachCdr(cpeId, {
          cdrReceivedAt: new Date().toISOString(),
          sunatResponseCode: sendResult.cdr?.responseCode || "0",
          sunatDescription: sendResult.cdr?.description || "Comprobante aceptado por SUNAT.",
          xmlHash: hashCpe,
        });
      } else if (sendResult.status === "ACCEPTED_WITH_OBSERVATIONS") {
        currentStatus = "ACEPTADO_CON_OBSERVACIONES";
        await this.cpeRepo.attachCdr(cpeId, {
          cdrReceivedAt: new Date().toISOString(),
          sunatResponseCode: sendResult.cdr?.responseCode || "0",
          sunatDescription: sendResult.cdr?.description || "Aceptado con observaciones.",
          xmlHash: hashCpe,
        });
        await this.cpeRepo.updateStatus(cpeId, {
          status: "ACEPTADO_CON_OBSERVACIONES",
        });
      } else if (sendResult.status === "REJECTED" || sendResult.status === "SOAP_FAULT") {
        currentStatus = "RECHAZADO";
        await this.cpeRepo.updateStatus(cpeId, {
          status: "RECHAZADO",
          sunatResponseCode: sendResult.cdr?.responseCode || sendResult.fault?.faultCode,
          sunatDescription: sendResult.cdr?.description || sendResult.fault?.faultString,
        });
      } else {
        currentStatus = "ERROR_COMUNICACION";
        await this.cpeRepo.updateStatus(cpeId, {
          status: "ENVIADO_SUNAT",
          sunatDescription: sendResult.message,
        });
      }
    }

    // 10. Representación Impresa (PDF A4 y Ticket 80mm) con QR y Hash CPE
    const printableCpe = mapCalculationToPrintableCpe({
      input: cpeInput,
      calculation,
      hashCpe,
      branding: options.branding,
    });
    const qrPayload = buildSunatQrPayload(printableCpe);

    let pdfA4: Buffer | undefined;
    let ticket80mm: Buffer | undefined;

    if (options.generatePdf !== false) {
      pdfA4 = await this.printService.render(printableCpe, "a4", { branding: options.branding });
    }
    if (options.generateTicket !== false) {
      ticket80mm = await this.printService.render(printableCpe, "ticket-80mm", {
        branding: options.branding,
      });
    }

    // 11. Registro inmutable en la bitácora de auditoría
    this.auditLogger.log({
      companyId: companyData.id,
      action: "EMISION_CPE",
      entityType: "CPE",
      entityId: cpeId,
      payloadHash: hashCpe,
      details: {
        fullNumber,
        cpeType: request.cpeType,
        totalPagar: calculation.totals.totalPagar,
        clientRucOrDni: request.client.docNumber,
        status: currentStatus,
        sunatResponseCode: sunatResponseSummary?.cdrResponseCode,
      },
    });

    return {
      cpeId,
      fullNumber,
      status: currentStatus,
      xmlSigned: signedXml,
      hashCpe,
      zipBuffer,
      zipFileName,
      calculation,
      sunatResponse: sunatResponseSummary,
      pdfA4,
      ticket80mm,
      qrPayload,
    };
  }

  // Atajos de conveniencia
  public async emitInvoice(
    request: Omit<EmitCpeRequest, "cpeType">,
    options?: EmitCpeOptions,
  ): Promise<EmitCpeResult> {
    return this.emitDocument({ ...request, cpeType: "01" }, options);
  }

  public async emitBoleta(
    request: Omit<EmitCpeRequest, "cpeType">,
    options?: EmitCpeOptions,
  ): Promise<EmitCpeResult> {
    return this.emitDocument({ ...request, cpeType: "03" }, options);
  }

  public async emitCreditNote(
    request: Omit<EmitCpeRequest, "cpeType">,
    options?: EmitCpeOptions,
  ): Promise<EmitCpeResult> {
    return this.emitDocument({ ...request, cpeType: "07" }, options);
  }

  private async resolveCompany(companyId: string) {
    if (this.companyService) {
      try {
        const comp = this.companyService.getCompany(companyId);
        return {
          id: comp.id,
          ruc: comp.ruc,
          legalName: comp.legalName,
          tradeName: comp.tradeName,
          taxRegime: comp.taxRegime,
          address: comp.address,
          solUser: comp.solCredentials?.usuarioSol,
          solPass: comp.solCredentials?.claveSol,
        };
      } catch {
        // Fallback al repositorio si no está en CompanyService
      }
    }

    const entity = await this.companyRepo.findById(companyId);
    if (!entity) {
      throw new Error(`Empresa con ID ${companyId} no encontrada.`);
    }
    if (!entity.isActive) {
      throw new Error(`La empresa ${entity.legalName} no está activa para emitir comprobantes.`);
    }

    return {
      id: entity.id,
      ruc: entity.ruc,
      legalName: entity.legalName,
      tradeName: entity.tradeName,
      taxRegime: entity.taxRegime,
      address: {
        ubigeo: entity.ubigeo,
        department: entity.department,
        province: entity.province,
        district: entity.district,
        addressLine: entity.addressLine,
      },
      solUser: entity.solUserEncrypted,
      solPass: entity.solPassEncrypted,
    };
  }

  private async resolveCorrelative(companyId: string, cpeType: string, series: string) {
    if (this.companyService) {
      try {
        const correlative = this.companyService.getNextCorrelative(
          companyId,
          cpeType as any,
          series,
        );
        const fullNumber = `${series}-${String(correlative).padStart(8, "0")}`;
        return { correlative, fullNumber };
      } catch {
        // Si no está configurada la serie en CompanyService, usar el repositorio
      }
    }

    const correlative = await this.companyRepo.incrementCorrelative(companyId, cpeType, series);
    const fullNumber = `${series}-${String(correlative).padStart(8, "0")}`;
    return { correlative, fullNumber };
  }

  private resolveCertificate(overrideCert?: CertificateData): CertificateData {
    if (overrideCert) return overrideCert;
    if (this.defaultCertData) return this.defaultCertData;
    // En desarrollo/pruebas genera automáticamente certificado válido
    const generated = generateSelfSignedCertificate("AYSUNAT MOTOR TRIBUTARIO PERU");
    this.defaultCertData = generated.certData;
    return this.defaultCertData;
  }
}
