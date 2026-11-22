#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();

const files = {
  'src/database/repositories/types.ts': `import { TaxRegimeCode } from '../../core/tax-engine/types.js';

export interface CompanyEntity {
  id: string;
  ruc: string;
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  addressLine: string;
  isActive: boolean;
  isHabido: boolean;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSeriesEntity {
  id: string;
  companyId: string;
  cpeType: '01' | '03' | '07' | '08' | '09';
  series: string;
  currentCorrelative: number;
  isActive: boolean;
  description?: string;
  createdAt: string;
}

export type CpeDatabaseStatus =
  | 'BORRADOR'
  | 'CALCULADO'
  | 'FIRMADO_XML'
  | 'ENVIADO_SUNAT'
  | 'ACEPTADO'
  | 'ACEPTADO_CON_OBSERVACIONES'
  | 'RECHAZADO'
  | 'DE_BAJA';

export interface CpeDocumentEntity {
  id: string;
  companyId: string;
  cpeType: string;
  series: string;
  correlative: number;
  fullNumber: string; // ej: F001-00000001
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  currency: 'PEN' | 'USD';
  exchangeRate?: string;
  paymentMethod: 'CONTADO' | 'CREDITO';

  // Datos del cliente / receptor
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  clientAddress?: string;
  clientEmail?: string;

  // Totales
  operacionesGravadas: string;
  operacionesExoneradas: string;
  operacionesInafectas: string;
  operacionesGratuitas: string;
  totalDescuentos: string;
  montoIgv: string;
  subtotal: string;
  totalPagar: string;
  totalLetras: string;

  // Estado SUNAT y trazabilidad
  status: CpeDatabaseStatus;
  sunatResponseCode?: string;
  sunatDescription?: string;
  xmlHash?: string;
  cdrReceivedAt?: string;

  rawPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CpeItemEntity {
  id: string;
  cpeId: string;
  lineNumber: number;
  itemCode?: string;
  description: string;
  unitCode: string;
  quantity: string;
  unitValue: string;
  unitPrice: string;
  affectationType: string;
  discountAmount: string;
  igvAmount: string;
  totalAmount: string;
}

export interface CreateCompanyDto {
  ruc: string;
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  addressLine: string;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
}

export interface UpdateCompanyDto {
  legalName?: string;
  tradeName?: string;
  taxRegime?: TaxRegimeCode;
  ubigeo?: string;
  department?: string;
  province?: string;
  district?: string;
  addressLine?: string;
  isActive?: boolean;
  isHabido?: boolean;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
}

export interface CreateSeriesDto {
  companyId: string;
  cpeType: '01' | '03' | '07' | '08' | '09';
  series: string;
  initialCorrelative?: number;
  description?: string;
}

export interface CreateCpeDocumentDto {
  companyId: string;
  cpeType: string;
  series: string;
  correlative: number;
  fullNumber: string;
  issueDate: string;
  issueTime?: string;
  currency: 'PEN' | 'USD';
  exchangeRate?: string;
  paymentMethod: 'CONTADO' | 'CREDITO';
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  clientAddress?: string;
  clientEmail?: string;
  operacionesGravadas: string;
  operacionesExoneradas?: string;
  operacionesInafectas?: string;
  operacionesGratuitas?: string;
  totalDescuentos?: string;
  montoIgv: string;
  subtotal: string;
  totalPagar: string;
  totalLetras: string;
  status?: CpeDatabaseStatus;
  xmlHash?: string;
  rawPayload: Record<string, unknown>;
}

export interface CreateCpeItemDto {
  lineNumber: number;
  itemCode?: string;
  description: string;
  unitCode?: string;
  quantity: string;
  unitValue: string;
  unitPrice: string;
  affectationType: string;
  discountAmount?: string;
  igvAmount: string;
  totalAmount: string;
}

export interface CpeStatusUpdateDto {
  status: CpeDatabaseStatus;
  sunatResponseCode?: string;
  sunatDescription?: string;
  xmlHash?: string;
  cdrReceivedAt?: string;
}

export interface CpeQueryFilter {
  cpeType?: string;
  series?: string;
  status?: CpeDatabaseStatus;
  startDate?: string;
  endDate?: string;
  clientDocNumber?: string;
  limit?: number;
  offset?: number;
}
`,

  'src/database/repositories/company.repository.ts': `import { validateRuc } from '../../core/tax-engine/validators.js';
import { getTaxRegimeConfig } from '../../core/tax-engine/tax-config.js';
import {
  CompanyEntity,
  DocumentSeriesEntity,
  CreateCompanyDto,
  UpdateCompanyDto,
  CreateSeriesDto,
} from './types.js';

export interface ICompanyRepository {
  create(dto: CreateCompanyDto): Promise<CompanyEntity>;
  findById(id: string): Promise<CompanyEntity | null>;
  findByRuc(ruc: string): Promise<CompanyEntity | null>;
  update(id: string, updates: UpdateCompanyDto): Promise<CompanyEntity>;
  listAll(filter?: { isActive?: boolean }): Promise<CompanyEntity[]>;
  createSeries(dto: CreateSeriesDto): Promise<DocumentSeriesEntity>;
  getSeries(companyId: string, cpeType: string, series: string): Promise<DocumentSeriesEntity | null>;
  listSeriesByCompany(companyId: string): Promise<DocumentSeriesEntity[]>;
  incrementCorrelative(companyId: string, cpeType: string, series: string): Promise<number>;
  getNextFullNumber(companyId: string, cpeType: string, series: string): Promise<{ correlative: number; fullNumber: string }>;
}

export class CompanyRepository implements ICompanyRepository {
  private companies: Map<string, CompanyEntity> = new Map();
  private seriesStore: Map<string, DocumentSeriesEntity> = new Map();

  public async create(dto: CreateCompanyDto): Promise<CompanyEntity> {
    const rucErrors = validateRuc(dto.ruc);
    if (rucErrors.length > 0) {
      throw new Error(\`RUC inválido: \${rucErrors.join(', ')}\`);
    }

    getTaxRegimeConfig(dto.taxRegime);

    const existing = await this.findByRuc(dto.ruc);
    if (existing) {
      throw new Error(\`Ya existe una empresa registrada con el RUC \${dto.ruc}\`);
    }

    const now = new Date().toISOString();
    const id = \`comp_\${Date.now()}_\${Math.random().toString(36).substring(2, 8)}\`;

    const entity: CompanyEntity = {
      id,
      ruc: dto.ruc,
      legalName: dto.legalName.trim(),
      tradeName: dto.tradeName?.trim(),
      taxRegime: dto.taxRegime,
      ubigeo: dto.ubigeo.trim(),
      department: dto.department.trim(),
      province: dto.province.trim(),
      district: dto.district.trim(),
      addressLine: dto.addressLine.trim(),
      isActive: true,
      isHabido: true,
      solUserEncrypted: dto.solUserEncrypted,
      solPassEncrypted: dto.solPassEncrypted,
      certAlias: dto.certAlias,
      createdAt: now,
      updatedAt: now,
    };

    this.companies.set(entity.id, entity);
    await this.initializeDefaultSeries(entity.id, entity.taxRegime);
    return entity;
  }

  public async findById(id: string): Promise<CompanyEntity | null> {
    return this.companies.get(id) || null;
  }

  public async findByRuc(ruc: string): Promise<CompanyEntity | null> {
    for (const company of this.companies.values()) {
      if (company.ruc === ruc) return company;
    }
    return null;
  }

  public async update(id: string, updates: UpdateCompanyDto): Promise<CompanyEntity> {
    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(\`Empresa con ID \${id} no encontrada\`);
    }

    if (updates.taxRegime) {
      getTaxRegimeConfig(updates.taxRegime);
    }

    const updated: CompanyEntity = {
      ...existing,
      ...updates,
      legalName: updates.legalName ? updates.legalName.trim() : existing.legalName,
      tradeName: updates.tradeName !== undefined ? updates.tradeName?.trim() : existing.tradeName,
      updatedAt: new Date().toISOString(),
    };

    this.companies.set(id, updated);
    return updated;
  }

  public async listAll(filter?: { isActive?: boolean }): Promise<CompanyEntity[]> {
    let list = Array.from(this.companies.values());
    if (filter?.isActive !== undefined) {
      list = list.filter((c) => c.isActive === filter.isActive);
    }
    return list;
  }

  public async createSeries(dto: CreateSeriesDto): Promise<DocumentSeriesEntity> {
    const company = await this.findById(dto.companyId);
    if (!company) {
      throw new Error(\`Empresa con ID \${dto.companyId} no existe\`);
    }

    const key = \`\${dto.companyId}:\${dto.cpeType}:\${dto.series.toUpperCase()}\`;
    if (this.seriesStore.has(key)) {
      throw new Error(\`La serie \${dto.series} para el tipo \${dto.cpeType} ya existe en esta empresa\`);
    }

    const now = new Date().toISOString();
    const seriesEntity: DocumentSeriesEntity = {
      id: \`ser_\${Date.now()}_\${Math.random().toString(36).substring(2, 8)}\`,
      companyId: dto.companyId,
      cpeType: dto.cpeType,
      series: dto.series.toUpperCase(),
      currentCorrelative: dto.initialCorrelative ?? 0,
      isActive: true,
      description: dto.description,
      createdAt: now,
    };

    this.seriesStore.set(key, seriesEntity);
    return seriesEntity;
  }

  public async getSeries(companyId: string, cpeType: string, series: string): Promise<DocumentSeriesEntity | null> {
    const key = \`\${companyId}:\${cpeType}:\${series.toUpperCase()}\`;
    return this.seriesStore.get(key) || null;
  }

  public async listSeriesByCompany(companyId: string): Promise<DocumentSeriesEntity[]> {
    const result: DocumentSeriesEntity[] = [];
    for (const series of this.seriesStore.values()) {
      if (series.companyId === companyId) {
        result.push(series);
      }
    }
    return result;
  }

  public async incrementCorrelative(companyId: string, cpeType: string, series: string): Promise<number> {
    const key = \`\${companyId}:\${cpeType}:\${series.toUpperCase()}\`;
    const seriesEntity = this.seriesStore.get(key);
    if (!seriesEntity) {
      throw new Error(\`Serie \${series} para el tipo \${cpeType} no configurada\`);
    }
    if (!seriesEntity.isActive) {
      throw new Error(\`La serie \${series} está inactiva\`);
    }

    seriesEntity.currentCorrelative += 1;
    return seriesEntity.currentCorrelative;
  }

  public async getNextFullNumber(
    companyId: string,
    cpeType: string,
    series: string,
  ): Promise<{ correlative: number; fullNumber: string }> {
    const nextCorrelative = await this.incrementCorrelative(companyId, cpeType, series);
    const padded = String(nextCorrelative).padStart(8, '0');
    const fullNumber = \`\${series.toUpperCase()}-\${padded}\`;
    return { correlative: nextCorrelative, fullNumber };
  }

  private async initializeDefaultSeries(companyId: string, regime: string): Promise<void> {
    if (regime === 'NRUS') {
      await this.createSeries({ companyId, cpeType: '03', series: 'B001', description: 'Boletas de Venta NRUS' });
    } else {
      await this.createSeries({ companyId, cpeType: '01', series: 'F001', description: 'Facturas Electrónicas' });
      await this.createSeries({ companyId, cpeType: '03', series: 'B001', description: 'Boletas de Venta' });
      await this.createSeries({ companyId, cpeType: '07', series: 'FC01', description: 'Notas de Crédito Facturas' });
      await this.createSeries({ companyId, cpeType: '07', series: 'BC01', description: 'Notas de Crédito Boletas' });
    }
  }
}
`,

  'src/database/repositories/cpe.repository.ts': `import {
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
      throw new Error(\`El comprobante \${documentDto.fullNumber} ya se encuentra registrado para esta empresa\`);
    }

    if (!itemsDto || itemsDto.length === 0) {
      throw new Error('Un comprobante de pago electrónico debe tener al menos un ítem');
    }

    const now = new Date().toISOString();
    const cpeId = \`cpe_\${Date.now()}_\${Math.random().toString(36).substring(2, 8)}\`;

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
      id: \`cpe_item_\${cpeId}_\${index + 1}\`,
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
      throw new Error(\`Comprobante \${id} no encontrado\`);
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
`,

  'src/database/repositories/index.ts': `export * from './types.js';
export * from './company.repository.js';
export * from './cpe.repository.js';
`,

  'src/database/index.ts': `export * from './repositories/index.js';
`,

  'src/database/__tests__/repositories.test.ts': `import { describe, expect, it, beforeEach } from 'vitest';
import { CompanyRepository } from '../repositories/company.repository.js';
import { CpeRepository } from '../repositories/cpe.repository.js';
import { CreateCompanyDto, CreateCpeDocumentDto, CreateCpeItemDto } from '../repositories/types.js';

describe('Capa de Persistencia: CompanyRepository', () => {
  let companyRepo: CompanyRepository;

  beforeEach(() => {
    companyRepo = new CompanyRepository();
  });

  const validCompanyDto: CreateCompanyDto = {
    ruc: '10445533811',
    legalName: 'Jose Barrientos Negocios',
    taxRegime: 'RMT',
    ubigeo: '150101',
    department: 'LIMA',
    province: 'LIMA',
    district: 'LIMA',
    addressLine: 'Av. Las Begonias 456',
  };

  it('registra una empresa y crea sus series predeterminadas', async () => {
    const company = await companyRepo.create(validCompanyDto);

    expect(company.id).toBeDefined();
    expect(company.ruc).toBe('10445533811');
    expect(company.isActive).toBe(true);

    const series = await companyRepo.listSeriesByCompany(company.id);
    expect(series.length).toBe(4);
    const seriesCodes = series.map((s) => s.series);
    expect(seriesCodes).toContain('F001');
    expect(seriesCodes).toContain('B001');
    expect(seriesCodes).toContain('FC01');
    expect(seriesCodes).toContain('BC01');
  });

  it('rechaza una empresa con RUC inválido', async () => {
    await expect(
      companyRepo.create({
        ...validCompanyDto,
        ruc: '10445533819',
      }),
    ).rejects.toThrow(/RUC inválido/);
  });

  it('evita registrar dos veces el mismo RUC', async () => {
    await companyRepo.create(validCompanyDto);
    await expect(companyRepo.create(validCompanyDto)).rejects.toThrow(/Ya existe una empresa/);
  });

  it('incrementa el correlativo y formatea el número completo (fullNumber)', async () => {
    const company = await companyRepo.create(validCompanyDto);

    const first = await companyRepo.getNextFullNumber(company.id, '01', 'F001');
    expect(first.correlative).toBe(1);
    expect(first.fullNumber).toBe('F001-00000001');

    const second = await companyRepo.getNextFullNumber(company.id, '01', 'F001');
    expect(second.correlative).toBe(2);
    expect(second.fullNumber).toBe('F001-00000002');
  });

  it('busca una empresa por RUC', async () => {
    const created = await companyRepo.create(validCompanyDto);
    const found = await companyRepo.findByRuc('10445533811');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
  });
});

describe('Capa de Persistencia: CpeRepository', () => {
  let cpeRepo: CpeRepository;
  const companyId = 'comp_test_123';

  beforeEach(() => {
    cpeRepo = new CpeRepository();
  });

  const sampleDocDto: CreateCpeDocumentDto = {
    companyId,
    cpeType: '01',
    series: 'F001',
    correlative: 1,
    fullNumber: 'F001-00000001',
    issueDate: '2026-11-21',
    currency: 'PEN',
    paymentMethod: 'CONTADO',
    clientDocType: '6',
    clientDocNumber: '20600000001',
    clientName: 'EMPRESA CLIENTE SAC',
    operacionesGravadas: '100.00',
    montoIgv: '18.00',
    subtotal: '100.00',
    totalPagar: '118.00',
    totalLetras: 'SON CIENTO DIECIOCHO CON 00/100 SOLES',
    rawPayload: { simulated: true },
  };

  const sampleItemsDto: CreateCpeItemDto[] = [
    {
      lineNumber: 1,
      itemCode: 'SERV-01',
      description: 'Consultoría contable y tributaria',
      unitCode: 'ZZ',
      quantity: '1.0000',
      unitValue: '100.00',
      unitPrice: '118.00',
      affectationType: '10',
      igvAmount: '18.00',
      totalAmount: '118.00',
    },
  ];

  it('crea un comprobante con sus ítems en estado CALCULADO', async () => {
    const aggregate = await cpeRepo.create(sampleDocDto, sampleItemsDto);

    expect(aggregate.document.id).toBeDefined();
    expect(aggregate.document.fullNumber).toBe('F001-00000001');
    expect(aggregate.document.status).toBe('CALCULADO');
    expect(aggregate.items.length).toBe(1);
    expect(aggregate.items[0].description).toBe('Consultoría contable y tributaria');
  });

  it('impide registrar un comprobante duplicado con el mismo fullNumber', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    await expect(cpeRepo.create(sampleDocDto, sampleItemsDto)).rejects.toThrow(/ya se encuentra registrado/);
  });

  it('busca un comprobante por su número completo', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    const found = await cpeRepo.findByFullNumber(companyId, 'f001-00000001');
    expect(found).not.toBeNull();
    expect(found?.document.totalPagar).toBe('118.00');
    expect(found?.items[0].totalAmount).toBe('118.00');
  });

  it('actualiza el ciclo de vida y adjunta la CDR aceptada por SUNAT', async () => {
    const { document } = await cpeRepo.create(sampleDocDto, sampleItemsDto);

    await cpeRepo.updateStatus(document.id, {
      status: 'FIRMADO_XML',
      xmlHash: 'abc123hash==',
    });

    const accepted = await cpeRepo.attachCdr(document.id, {
      cdrReceivedAt: new Date().toISOString(),
      sunatResponseCode: '0',
      sunatDescription: 'La Factura F001-00000001 ha sido aceptada.',
      xmlHash: 'abc123hash==',
    });

    expect(accepted.status).toBe('ACEPTADO');
    expect(accepted.sunatResponseCode).toBe('0');
    expect(accepted.xmlHash).toBe('abc123hash==');
  });

  it('permite filtrar comprobantes por rango de fechas y tipo', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    await cpeRepo.create(
      {
        ...sampleDocDto,
        cpeType: '03',
        series: 'B001',
        correlative: 1,
        fullNumber: 'B001-00000001',
      },
      sampleItemsDto,
    );

    const facturas = await cpeRepo.listByCompany(companyId, { cpeType: '01' });
    expect(facturas.length).toBe(1);
    expect(facturas[0].fullNumber).toBe('F001-00000001');

    const boletas = await cpeRepo.listByCompany(companyId, { cpeType: '03' });
    expect(boletas.length).toBe(1);
    expect(boletas[0].fullNumber).toBe('B001-00000001');
  });
});
`
};

for (const [relPath, content] of Object.entries(files)) {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim() + '\n', 'utf8');
  console.log(`[OK] ${relPath}`);
}

console.log('\nRepositorios de persistencia creados exitosamente.');
console.log('Verifica ejecutando:');
console.log('  npm run typecheck');
console.log('  npm test');
