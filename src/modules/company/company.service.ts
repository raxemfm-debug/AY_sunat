import { Company, DocumentSeries, CpeTypeSupported } from './types.js';
import { validateRuc } from '../../core/tax-engine/validators.js';
import { getTaxRegimeConfig } from '../../core/tax-engine/tax-config.js';

export class CompanyService {
  private companies: Map<string, Company> = new Map();
  private seriesStore: Map<string, DocumentSeries[]> = new Map();

  public registerCompany(input: Omit<Company, 'id' | 'createdAt' | 'updatedAt' | 'isActive' | 'isHabido'>): Company {
    const rucErrors = validateRuc(input.ruc);
    if (rucErrors.length > 0) {
      throw new Error(`RUC inválido: ${rucErrors.join(', ')}`);
    }

    if (!input.ruc.startsWith('10')) {
      throw new Error('Para Persona Natural con Negocio, el RUC debe iniciar con 10.');
    }

    // Valida que el régimen sea uno oficial
    getTaxRegimeConfig(input.taxRegime);

    if (Array.from(this.companies.values()).some((c) => c.ruc === input.ruc)) {
      throw new Error(`Ya existe una empresa registrada con el RUC ${input.ruc}`);
    }

    const now = new Date().toISOString();
    const company: Company = {
      ...input,
      id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      isActive: true,
      isHabido: true,
      createdAt: now,
      updatedAt: now,
    };

    this.companies.set(company.id, company);
    this.initializeDefaultSeries(company.id, company.taxRegime);
    return company;
  }

  public getCompany(id: string): Company {
    const company = this.companies.get(id);
    if (!company) throw new Error(`Empresa con ID ${id} no encontrada.`);
    return company;
  }

  public getCompanyByRuc(ruc: string): Company | undefined {
    return Array.from(this.companies.values()).find((c) => c.ruc === ruc);
  }

  private initializeDefaultSeries(companyId: string, regime: Company['taxRegime']): void {
    const seriesList: DocumentSeries[] = [];
    const now = new Date().toISOString();

    if (regime !== 'NRUS') {
      // Facturas y sus notas
      seriesList.push({
        id: `ser_${Date.now()}_1`,
        companyId,
        cpeType: '01',
        series: 'F001',
        currentCorrelative: 0,
        isActive: true,
        description: 'Serie principal de facturas electrónicas',
        createdAt: now,
      });
      seriesList.push({
        id: `ser_${Date.now()}_2`,
        companyId,
        cpeType: '07',
        series: 'FC01',
        currentCorrelative: 0,
        isActive: true,
        description: 'Serie de notas de crédito para facturas',
        createdAt: now,
      });
    }

    // Boletas y sus notas
    seriesList.push({
      id: `ser_${Date.now()}_3`,
      companyId,
      cpeType: '03',
      series: 'B001',
      currentCorrelative: 0,
      isActive: true,
      description: 'Serie principal de boletas de venta electrónicas',
      createdAt: now,
    });

    if (regime !== 'NRUS') {
      seriesList.push({
        id: `ser_${Date.now()}_4`,
        companyId,
        cpeType: '07',
        series: 'BC01',
        currentCorrelative: 0,
        isActive: true,
        description: 'Serie de notas de crédito para boletas',
        createdAt: now,
      });
    }

    this.seriesStore.set(companyId, seriesList);
  }

  public getSeries(companyId: string): DocumentSeries[] {
    return this.seriesStore.get(companyId) ?? [];
  }

  public getNextCorrelative(companyId: string, cpeType: CpeTypeSupported, seriesName: string): number {
    const list = this.getSeries(companyId);
    const target = list.find((s) => s.cpeType === cpeType && s.series === seriesName && s.isActive);
    if (!target) {
      throw new Error(`Serie '${seriesName}' no autorizada o inactiva para el comprobante tipo '${cpeType}'.`);
    }
    target.currentCorrelative += 1;
    return target.currentCorrelative;
  }
}
