import { CompanyService } from '../company/company.service.js';
import { AuditLogger } from '../audit/audit-logger.js';
import { calculateCpe } from '../../core/tax-engine/cpe-calculator.js';
import { CpeRecord, IssueCpeRequest } from './types.js';
import { CpeDocumentInput } from '../../core/tax-engine/types.js';

export class CpeService {
  private cpeStorage: Map<string, CpeRecord> = new Map();

  constructor(
    private companyService: CompanyService,
    private auditLogger: AuditLogger,
  ) {}

  public issueDocument(request: IssueCpeRequest): CpeRecord {
    const company = this.companyService.getCompany(request.companyId);
    if (!company.isActive) {
      throw new Error(`La empresa ${company.legalName} no está activa para emitir comprobantes.`);
    }

    // 1. Obtener correlativo secuencial garantizado por la serie
    const correlative = this.companyService.getNextCorrelative(
      company.id,
      request.cpeType,
      request.series,
    );

    const issueDate = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    // 2. Preparar el payload normativo para el motor de cálculo
    const cpeInput: CpeDocumentInput = {
      company: {
        ruc: company.ruc,
        legalName: company.legalName,
        tradeName: company.tradeName,
        taxRegime: company.taxRegime,
        address: company.address,
      },
      client: request.client,
      cpeType: request.cpeType,
      series: request.series,
      correlative,
      issueDate,
      currency: request.currency ?? 'PEN',
      exchangeRate: request.exchangeRate,
      paymentMethod: request.paymentMethod,
      globalDiscountAmount: request.globalDiscountAmount,
      items: request.items,
      creditNoteInfo: request.creditNoteInfo,
    };

    // 3. Ejecutar cálculo determinista con precisión decimal
    const calculation = calculateCpe(cpeInput);

    // 4. Crear registro inmutable del comprobante
    const record: CpeRecord = {
      id: `cpe_${Date.now()}_${calculation.header.fullNumber}`,
      companyId: company.id,
      fullNumber: calculation.header.fullNumber,
      cpeType: request.cpeType,
      series: request.series,
      correlative,
      issueDate,
      currency: request.currency ?? 'PEN',
      clientDocType: request.client.docType,
      clientDocNumber: request.client.docNumber,
      clientName: request.client.name,
      subTotal: calculation.totals.subTotal,
      montoIgv: calculation.totals.montoIgv,
      totalPagar: calculation.totals.totalPagar,
      status: 'CALCULADO', // Pasa a FIRMADO/ENVIADO según integración SUNAT
      calculationDetails: calculation,
      createdAt: now,
      updatedAt: now,
    };

    this.cpeStorage.set(record.id, record);

    // 5. Registro inmutable en el registro de auditoría
    this.auditLogger.log({
      companyId: company.id,
      action: 'EMISION_CPE',
      entityType: 'CPE',
      entityId: record.id,
      details: {
        fullNumber: record.fullNumber,
        cpeType: record.cpeType,
        totalPagar: record.totalPagar,
        clientRucOrDni: request.client.docNumber,
      },
    });

    return record;
  }

  public getCpeById(id: string): CpeRecord {
    const record = this.cpeStorage.get(id);
    if (!record) throw new Error(`Comprobante ${id} no encontrado.`);
    return record;
  }

  public getCpeByFullNumber(companyId: string, fullNumber: string): CpeRecord | undefined {
    return Array.from(this.cpeStorage.values()).find(
      (doc) => doc.companyId === companyId && doc.fullNumber === fullNumber,
    );
  }

  public listCpeByCompany(companyId: string): CpeRecord[] {
    return Array.from(this.cpeStorage.values()).filter((doc) => doc.companyId === companyId);
  }
}
