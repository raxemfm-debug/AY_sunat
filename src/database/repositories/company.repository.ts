import { validateRuc } from '../../core/tax-engine/validators.js';
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
      throw new Error(`RUC inválido: ${rucErrors.join(', ')}`);
    }

    getTaxRegimeConfig(dto.taxRegime);

    const existing = await this.findByRuc(dto.ruc);
    if (existing) {
      throw new Error(`Ya existe una empresa registrada con el RUC ${dto.ruc}`);
    }

    const now = new Date().toISOString();
    const id = `comp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

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
      throw new Error(`Empresa con ID ${id} no encontrada`);
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
      throw new Error(`Empresa con ID ${dto.companyId} no existe`);
    }

    const key = `${dto.companyId}:${dto.cpeType}:${dto.series.toUpperCase()}`;
    if (this.seriesStore.has(key)) {
      throw new Error(`La serie ${dto.series} para el tipo ${dto.cpeType} ya existe en esta empresa`);
    }

    const now = new Date().toISOString();
    const seriesEntity: DocumentSeriesEntity = {
      id: `ser_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
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
    const key = `${companyId}:${cpeType}:${series.toUpperCase()}`;
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
    const key = `${companyId}:${cpeType}:${series.toUpperCase()}`;
    const seriesEntity = this.seriesStore.get(key);
    if (!seriesEntity) {
      throw new Error(`Serie ${series} para el tipo ${cpeType} no configurada`);
    }
    if (!seriesEntity.isActive) {
      throw new Error(`La serie ${series} está inactiva`);
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
    const fullNumber = `${series.toUpperCase()}-${padded}`;
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
