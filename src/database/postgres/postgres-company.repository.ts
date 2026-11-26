import type { Pool, QueryResultRow } from 'pg';
import { validateRuc } from '../../core/tax-engine/validators.js';
import { getTaxRegimeConfig } from '../../core/tax-engine/tax-config.js';
import type { TaxRegimeCode } from '../../core/tax-engine/types.js';
import type { ICompanyRepository } from '../repositories/company.repository.js';
import type {
  CompanyEntity,
  CreateCompanyDto,
  CreateSeriesDto,
  DocumentSeriesEntity,
  UpdateCompanyDto,
} from '../repositories/types.js';
import { isoTimestamp, isUniqueViolation, isUuid, optional, Queryable, withTransaction } from './pg-utils.js';

interface CompanyRow extends QueryResultRow {
  id: string;
  ruc: string;
  legal_name: string;
  trade_name: string | null;
  tax_regime: TaxRegimeCode;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  address_line: string;
  is_active: boolean;
  is_habido: boolean;
  sol_user_encrypted: string | null;
  sol_pass_encrypted: string | null;
  cert_alias: string | null;
  created_at: string;
  updated_at: string;
}

interface SeriesRow extends QueryResultRow {
  id: string;
  company_id: string;
  cpe_type: DocumentSeriesEntity['cpeType'];
  series: string;
  current_correlative: number;
  is_active: boolean;
  description: string | null;
  created_at: string;
}

const COMPANY_COLUMNS = `id::text AS id, ruc, legal_name, trade_name, tax_regime, ubigeo, department,
  province, district, address_line, is_active, is_habido, sol_user_encrypted, sol_pass_encrypted,
  cert_alias, ${isoTimestamp('created_at')} AS created_at, ${isoTimestamp('updated_at')} AS updated_at`;

const SERIES_COLUMNS = `id::text AS id, company_id::text AS company_id, cpe_type, series,
  current_correlative, is_active, description, ${isoTimestamp('created_at')} AS created_at`;

/** Campos actualizables: propiedad del DTO -> columna. Nada fuera de esta lista llega al SQL. */
const UPDATABLE_COLUMNS: Record<keyof UpdateCompanyDto, string> = {
  legalName: 'legal_name',
  tradeName: 'trade_name',
  taxRegime: 'tax_regime',
  ubigeo: 'ubigeo',
  department: 'department',
  province: 'province',
  district: 'district',
  addressLine: 'address_line',
  isActive: 'is_active',
  isHabido: 'is_habido',
  solUserEncrypted: 'sol_user_encrypted',
  solPassEncrypted: 'sol_pass_encrypted',
  certAlias: 'cert_alias',
};

function mapCompany(row: CompanyRow): CompanyEntity {
  return {
    id: row.id,
    ruc: row.ruc,
    legalName: row.legal_name,
    tradeName: optional(row.trade_name),
    taxRegime: row.tax_regime,
    ubigeo: row.ubigeo,
    department: row.department,
    province: row.province,
    district: row.district,
    addressLine: row.address_line,
    isActive: row.is_active,
    isHabido: row.is_habido,
    solUserEncrypted: optional(row.sol_user_encrypted),
    solPassEncrypted: optional(row.sol_pass_encrypted),
    certAlias: optional(row.cert_alias),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSeries(row: SeriesRow): DocumentSeriesEntity {
  return {
    id: row.id,
    companyId: row.company_id,
    cpeType: row.cpe_type,
    series: row.series,
    currentCorrelative: row.current_correlative,
    isActive: row.is_active,
    description: optional(row.description),
    createdAt: row.created_at,
  };
}

export function defaultSeriesFor(regime: TaxRegimeCode): Array<Omit<CreateSeriesDto, 'companyId'>> {
  if (regime === 'NRUS') {
    return [{ cpeType: '03', series: 'B001', description: 'Boletas de Venta NRUS' }];
  }
  return [
    { cpeType: '01', series: 'F001', description: 'Facturas Electrónicas' },
    { cpeType: '03', series: 'B001', description: 'Boletas de Venta' },
    { cpeType: '07', series: 'FC01', description: 'Notas de Crédito Facturas' },
    { cpeType: '07', series: 'BC01', description: 'Notas de Crédito Boletas' },
  ];
}

/** Repositorio de empresas y series sobre PostgreSQL (tablas companies y document_series). */
export class PostgresCompanyRepository implements ICompanyRepository {
  constructor(private readonly pool: Pool) {}

  async create(dto: CreateCompanyDto): Promise<CompanyEntity> {
    const rucErrors = validateRuc(dto.ruc);
    if (rucErrors.length > 0) {
      throw new Error(`RUC inválido: ${rucErrors.join(', ')}`);
    }
    getTaxRegimeConfig(dto.taxRegime);

    try {
      return await withTransaction(this.pool, async (client) => {
        const result = await client.query<CompanyRow>(
          `INSERT INTO companies (ruc, legal_name, trade_name, tax_regime, ubigeo, department, province,
              district, address_line, sol_user_encrypted, sol_pass_encrypted, cert_alias)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${COMPANY_COLUMNS}`,
          [
            dto.ruc,
            dto.legalName.trim(),
            dto.tradeName?.trim() ?? null,
            dto.taxRegime,
            dto.ubigeo.trim(),
            dto.department.trim(),
            dto.province.trim(),
            dto.district.trim(),
            dto.addressLine.trim(),
            dto.solUserEncrypted ?? null,
            dto.solPassEncrypted ?? null,
            dto.certAlias ?? null,
          ],
        );
        const company = mapCompany(result.rows[0]);
        for (const series of defaultSeriesFor(company.taxRegime)) {
          await this.insertSeries(client, { ...series, companyId: company.id });
        }
        return company;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'companies_ruc_key')) {
        throw new Error(`Ya existe una empresa registrada con el RUC ${dto.ruc}`);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<CompanyEntity | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1`, [id]);
    return result.rows[0] ? mapCompany(result.rows[0]) : null;
  }

  async findByRuc(ruc: string): Promise<CompanyEntity | null> {
    const result = await this.pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE ruc = $1`, [ruc]);
    return result.rows[0] ? mapCompany(result.rows[0]) : null;
  }

  async update(id: string, updates: UpdateCompanyDto): Promise<CompanyEntity> {
    if (updates.taxRegime) {
      getTaxRegimeConfig(updates.taxRegime);
    }
    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(UPDATABLE_COLUMNS) as Array<[keyof UpdateCompanyDto, string]>) {
      if (!(key in updates) || updates[key] === undefined) continue;
      const raw = updates[key];
      params.push(typeof raw === 'string' ? raw.trim() : raw);
      assignments.push(`${column} = $${params.length}`);
    }

    const existing = await this.findById(id);
    if (!existing) {
      throw new Error(`Empresa con ID ${id} no encontrada`);
    }
    if (assignments.length === 0) return existing;

    params.push(id);
    const result = await this.pool.query<CompanyRow>(
      `UPDATE companies SET ${assignments.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING ${COMPANY_COLUMNS}`,
      params,
    );
    if (!result.rows[0]) {
      throw new Error(`Empresa con ID ${id} no encontrada`);
    }
    return mapCompany(result.rows[0]);
  }

  async listAll(filter?: { isActive?: boolean }): Promise<CompanyEntity[]> {
    const result = filter?.isActive === undefined
      ? await this.pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies ORDER BY created_at`)
      : await this.pool.query<CompanyRow>(
        `SELECT ${COMPANY_COLUMNS} FROM companies WHERE is_active = $1 ORDER BY created_at`,
        [filter.isActive],
      );
    return result.rows.map(mapCompany);
  }

  async createSeries(dto: CreateSeriesDto): Promise<DocumentSeriesEntity> {
    const company = await this.findById(dto.companyId);
    if (!company) {
      throw new Error(`Empresa con ID ${dto.companyId} no existe`);
    }
    try {
      return await this.insertSeries(this.pool, dto);
    } catch (error) {
      if (isUniqueViolation(error, 'uq_company_cpe_series')) {
        throw new Error(`La serie ${dto.series} para el tipo ${dto.cpeType} ya existe en esta empresa`);
      }
      throw error;
    }
  }

  async getSeries(companyId: string, cpeType: string, series: string): Promise<DocumentSeriesEntity | null> {
    if (!isUuid(companyId)) return null;
    const result = await this.pool.query<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} FROM document_series
        WHERE company_id = $1 AND cpe_type = $2 AND series = $3`,
      [companyId, cpeType, series.toUpperCase()],
    );
    return result.rows[0] ? mapSeries(result.rows[0]) : null;
  }

  async listSeriesByCompany(companyId: string): Promise<DocumentSeriesEntity[]> {
    if (!isUuid(companyId)) return [];
    const result = await this.pool.query<SeriesRow>(
      `SELECT ${SERIES_COLUMNS} FROM document_series WHERE company_id = $1 ORDER BY cpe_type, series`,
      [companyId],
    );
    return result.rows.map(mapSeries);
  }

  /**
   * Incremento atómico: UPDATE ... RETURNING bloquea la fila de la serie, por lo que
   * dos emisiones simultáneas nunca reciben el mismo correlativo.
   */
  async incrementCorrelative(companyId: string, cpeType: string, series: string): Promise<number> {
    const normalizedSeries = series.toUpperCase();
    if (isUuid(companyId)) {
      const result = await this.pool.query<{ current_correlative: number }>(
        `UPDATE document_series SET current_correlative = current_correlative + 1
          WHERE company_id = $1 AND cpe_type = $2 AND series = $3 AND is_active
          RETURNING current_correlative`,
        [companyId, cpeType, normalizedSeries],
      );
      if (result.rows[0]) return result.rows[0].current_correlative;
    }

    const existing = await this.getSeries(companyId, cpeType, normalizedSeries);
    if (existing && !existing.isActive) {
      throw new Error(`La serie ${series} está inactiva`);
    }
    throw new Error(`Serie ${series} para el tipo ${cpeType} no configurada`);
  }

  async getNextFullNumber(
    companyId: string,
    cpeType: string,
    series: string,
  ): Promise<{ correlative: number; fullNumber: string }> {
    const correlative = await this.incrementCorrelative(companyId, cpeType, series);
    return { correlative, fullNumber: `${series.toUpperCase()}-${String(correlative).padStart(8, '0')}` };
  }

  private async insertSeries(db: Queryable, dto: CreateSeriesDto): Promise<DocumentSeriesEntity> {
    const result = await db.query<SeriesRow>(
      `INSERT INTO document_series (company_id, cpe_type, series, current_correlative, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SERIES_COLUMNS}`,
      [dto.companyId, dto.cpeType, dto.series.toUpperCase(), dto.initialCorrelative ?? 0, dto.description ?? null],
    );
    return mapSeries(result.rows[0]);
  }
}
