import {
  CpeDocumentEntity,
  CpeItemEntity,
  CreateCpeDocumentDto,
  CreateCpeItemDto,
  CpeStatusUpdateDto,
  CpeQueryFilter,
} from './types.js';

export interface CpeAggregate {
  document: CpeDocumentEntity;
  items: CpeItemEntity[];
}

export interface ICpeRepository {
  create(documentDto: CreateCpeDocumentDto, itemsDto: CreateCpeItemDto[]): Promise<CpeAggregate>;
  findById(id: string): Promise<CpeAggregate | null>;
  findByFullNumber(companyId: string, fullNumber: string): Promise<CpeAggregate | null>;
  updateStatus(id: string, update: CpeStatusUpdateDto): Promise<CpeDocumentEntity>;
  attachCdr(
    id: string,
    cdrData: {
      cdrReceivedAt: string;
      sunatResponseCode: string;
      sunatDescription: string;
      xmlHash?: string;
    },
  ): Promise<CpeDocumentEntity>;
  listByCompany(companyId: string, filter?: CpeQueryFilter): Promise<CpeDocumentEntity[]>;
  getItems(cpeId: string): Promise<CpeItemEntity[]>;
}

export class CpeRepository implements ICpeRepository {
  private documents: Map<string, CpeDocumentEntity> = new Map();
  private itemsByCpeId: Map<string, CpeItemEntity[]> = new Map();

  public async create(documentDto: CreateCpeDocumentDto, itemsDto: CreateCpeItemDto[]): Promise<CpeAggregate> {
    const existing = await this.findByFullNumber(documentDto.companyId, documentDto.fullNumber);
    if (existing) {
      throw new Error(`El comprobante ${documentDto.fullNumber} ya se encuentra registrado para esta empresa`);
    }

    if (!itemsDto || itemsDto.length === 0) {
      throw new Error('Un comprobante de pago electrónico debe tener al menos un ítem');
    }

    const now = new Date().toISOString();
    const cpeId = `cpe_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const document: CpeDocumentEntity = {
      id: cpeId,
      companyId: documentDto.companyId,
      cpeType: documentDto.cpeType,
      series: documentDto.series.toUpperCase(),
      correlative: documentDto.correlative,
      fullNumber: documentDto.fullNumber.toUpperCase(),
      issueDate: documentDto.issueDate,
      issueTime: documentDto.issueTime || new Date().toTimeString().split(' ')[0],
      currency: documentDto.currency,
      exchangeRate: documentDto.exchangeRate,
      paymentMethod: documentDto.paymentMethod,
      clientDocType: documentDto.clientDocType,
      clientDocNumber: documentDto.clientDocNumber,
      clientName: documentDto.clientName.trim(),
      clientAddress: documentDto.clientAddress?.trim(),
      clientEmail: documentDto.clientEmail?.trim(),
      operacionesGravadas: documentDto.operacionesGravadas,
      operacionesExoneradas: documentDto.operacionesExoneradas || '0.00',
      operacionesInafectas: documentDto.operacionesInafectas || '0.00',
      operacionesGratuitas: documentDto.operacionesGratuitas || '0.00',
      totalDescuentos: documentDto.totalDescuentos || '0.00',
      montoIgv: documentDto.montoIgv,
      subtotal: documentDto.subtotal,
      totalPagar: documentDto.totalPagar,
      totalLetras: documentDto.totalLetras,
      status: documentDto.status || 'CALCULADO',
      xmlHash: documentDto.xmlHash,
      rawPayload: documentDto.rawPayload,
      createdAt: now,
      updatedAt: now,
    };

    const items: CpeItemEntity[] = itemsDto.map((item, index) => ({
      id: `cpe_item_${cpeId}_${index + 1}`,
      cpeId,
      lineNumber: item.lineNumber,
      itemCode: item.itemCode,
      description: item.description.trim(),
      unitCode: item.unitCode || 'NIU',
      quantity: item.quantity,
      unitValue: item.unitValue,
      unitPrice: item.unitPrice,
      affectationType: item.affectationType,
      discountAmount: item.discountAmount || '0.00',
      igvAmount: item.igvAmount,
      totalAmount: item.totalAmount,
    }));

    this.documents.set(cpeId, document);
    this.itemsByCpeId.set(cpeId, items);

    return { document, items };
  }

  public async findById(id: string): Promise<CpeAggregate | null> {
    const document = this.documents.get(id);
    if (!document) return null;
    const items = this.itemsByCpeId.get(id) || [];
    return { document, items };
  }

  public async findByFullNumber(companyId: string, fullNumber: string): Promise<CpeAggregate | null> {
    const target = fullNumber.toUpperCase();
    for (const doc of this.documents.values()) {
      if (doc.companyId === companyId && doc.fullNumber === target) {
        const items = this.itemsByCpeId.get(doc.id) || [];
        return { document: doc, items };
      }
    }
    return null;
  }

  public async updateStatus(id: string, update: CpeStatusUpdateDto): Promise<CpeDocumentEntity> {
    const doc = this.documents.get(id);
    if (!doc) {
      throw new Error(`Comprobante ${id} no encontrado`);
    }

    const updated: CpeDocumentEntity = {
      ...doc,
      status: update.status,
      sunatResponseCode: update.sunatResponseCode ?? doc.sunatResponseCode,
      sunatDescription: update.sunatDescription ?? doc.sunatDescription,
      xmlHash: update.xmlHash ?? doc.xmlHash,
      cdrReceivedAt: update.cdrReceivedAt ?? doc.cdrReceivedAt,
      updatedAt: new Date().toISOString(),
    };

    this.documents.set(id, updated);
    return updated;
  }

  public async attachCdr(
    id: string,
    cdrData: {
      cdrReceivedAt: string;
      sunatResponseCode: string;
      sunatDescription: string;
      xmlHash?: string;
    },
  ): Promise<CpeDocumentEntity> {
    const status = cdrData.sunatResponseCode === '0'
      ? 'ACEPTADO'
      : cdrData.sunatResponseCode.startsWith('4')
        ? 'ACEPTADO_CON_OBSERVACIONES'
        : 'RECHAZADO';

    return this.updateStatus(id, {
      status,
      cdrReceivedAt: cdrData.cdrReceivedAt,
      sunatResponseCode: cdrData.sunatResponseCode,
      sunatDescription: cdrData.sunatDescription,
      xmlHash: cdrData.xmlHash,
    });
  }

  public async listByCompany(companyId: string, filter?: CpeQueryFilter): Promise<CpeDocumentEntity[]> {
    let list: CpeDocumentEntity[] = [];

    for (const doc of this.documents.values()) {
      if (doc.companyId !== companyId) continue;
      if (filter?.cpeType && doc.cpeType !== filter.cpeType) continue;
      if (filter?.series && doc.series !== filter.series.toUpperCase()) continue;
      if (filter?.status && doc.status !== filter.status) continue;
      if (filter?.clientDocNumber && doc.clientDocNumber !== filter.clientDocNumber) continue;
      if (filter?.startDate && doc.issueDate < filter.startDate) continue;
      if (filter?.endDate && doc.issueDate > filter.endDate) continue;

      list.push(doc);
    }

    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (filter?.offset) {
      list = list.slice(filter.offset);
    }
    if (filter?.limit) {
      list = list.slice(0, filter.limit);
    }

    return list;
  }

  public async getItems(cpeId: string): Promise<CpeItemEntity[]> {
    return this.itemsByCpeId.get(cpeId) || [];
  }
}
