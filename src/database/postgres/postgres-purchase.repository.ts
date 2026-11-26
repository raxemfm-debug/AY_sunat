import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { Decimal } from 'decimal.js';
import type { IdentityDocTypeCode } from '../../core/tax-engine/types.js';
import type {
  DetractionData,
  PurchaseCalculatedItem,
  PurchaseDocumentRecord,
  SupplierProfile,
} from '../../modules/purchases/types.js';
import {
  DuplicatePurchaseError,
  IPurchaseRepository,
  PurchaseSireStatus,
} from '../repositories/purchase.repository.js';
import { isoTimestamp, isUniqueViolation, optional, Queryable, withTransaction } from './pg-utils.js';

interface SupplierRow extends QueryResultRow {
  doc_type: IdentityDocTypeCode;
  doc_number: string;
  name: string;
  trade_name: string | null;
  is_habido: boolean;
  is_active: boolean;
  address: string | null;
  email: string | null;
}

interface PurchaseRow extends SupplierRow {
  id: string;
  company_ruc: string;
  car: string;
  accounting_period: string;
  purchase_doc_type: PurchaseDocumentRecord['docType'];
  series: string;
  correlative: string;
  full_number: string;
  issue_date: string;
  due_date: string | null;
  currency: PurchaseDocumentRecord['currency'];
  exchange_rate: string | null;
  payment_method: PurchaseDocumentRecord['paymentMethod'];
  is_bancarizado: boolean;
  detraction: DetractionData | null;
  can_use_fiscal_credit: boolean;
  fiscal_credit_restriction_reason: string | null;
  base_gravada_exclusiva: string;
  igv_gravado_exclusivo: string;
  base_gravada_comun: string;
  igv_gravado_comun: string;
  base_gravada_sin_credito: string;
  igv_gravado_sin_credito: string;
  adquisiciones_no_gravadas: string;
  isc: string;
  icbper: string;
  otros_cargos: string;
  total_adquisicion: string;
  total_credito_fiscal: string;
  sire_status: PurchaseSireStatus;
  created_at: string;
}

interface PurchaseItemRow extends QueryResultRow {
  purchase_id: string;
  line_number: number;
  item_ref: string | null;
  description: string;
  quantity: string;
  unit_value: string;
  net_base: string;
  igv_amount: string;
  total_amount: string;
  tax_destination: PurchaseCalculatedItem['taxDestination'];
  classification: PurchaseCalculatedItem['classification'];
  has_fiscal_credit: boolean;
}

const money = (value: string) => new Decimal(value).toFixed(2);

const PURCHASE_SELECT = `SELECT d.id, d.company_ruc, d.car, d.accounting_period, d.doc_type AS purchase_doc_type,
    d.series, d.correlative, d.full_number, d.issue_date::text AS issue_date, d.due_date::text AS due_date,
    d.currency, d.exchange_rate::text AS exchange_rate, d.payment_method, d.is_bancarizado, d.detraction,
    d.can_use_fiscal_credit, d.fiscal_credit_restriction_reason,
    d.base_gravada_exclusiva::text AS base_gravada_exclusiva, d.igv_gravado_exclusivo::text AS igv_gravado_exclusivo,
    d.base_gravada_comun::text AS base_gravada_comun, d.igv_gravado_comun::text AS igv_gravado_comun,
    d.base_gravada_sin_credito::text AS base_gravada_sin_credito,
    d.igv_gravado_sin_credito::text AS igv_gravado_sin_credito,
    d.adquisiciones_no_gravadas::text AS adquisiciones_no_gravadas, d.isc::text AS isc, d.icbper::text AS icbper,
    d.otros_cargos::text AS otros_cargos, d.total_adquisicion::text AS total_adquisicion,
    d.total_credito_fiscal::text AS total_credito_fiscal, d.sire_status,
    ${isoTimestamp('d.created_at')} AS created_at,
    s.doc_type, s.doc_number, s.name, s.trade_name, s.is_habido, s.is_active, s.address, s.email
  FROM private.purchase_documents d
  JOIN private.purchase_suppliers s
    ON s.company_ruc = d.company_ruc AND s.doc_number = d.supplier_doc_number`;

const ITEM_SELECT = `SELECT purchase_id, line_number, item_ref, description, quantity::text AS quantity,
    unit_value::text AS unit_value, net_base::text AS net_base, igv_amount::text AS igv_amount,
    total_amount::text AS total_amount, tax_destination, classification, has_fiscal_credit
  FROM private.purchase_items`;

function mapSupplier(row: SupplierRow): SupplierProfile {
  return {
    id: `prov-${row.doc_number}`,
    docType: row.doc_type,
    docNumber: row.doc_number,
    name: row.name,
    tradeName: optional(row.trade_name),
    isHabido: row.is_habido,
    isActive: row.is_active,
    address: optional(row.address),
    email: optional(row.email),
  };
}

function mapItem(row: PurchaseItemRow): PurchaseCalculatedItem {
  return {
    id: row.item_ref ?? `item-${row.line_number}`,
    description: row.description,
    quantity: new Decimal(row.quantity).toFixed(4),
    unitValue: money(row.unit_value),
    netBase: row.net_base,
    igvAmount: row.igv_amount,
    totalAmount: row.total_amount,
    taxDestination: row.tax_destination,
    classification: row.classification,
    hasFiscalCredit: row.has_fiscal_credit,
  };
}

function mapPurchase(row: PurchaseRow, items: PurchaseCalculatedItem[]): PurchaseDocumentRecord {
  return {
    id: row.id,
    car: row.car,
    companyRuc: row.company_ruc,
    accountingPeriod: row.accounting_period,
    supplier: mapSupplier(row),
    docType: row.purchase_doc_type,
    series: row.series,
    correlative: row.correlative,
    fullNumber: row.full_number,
    issueDate: row.issue_date,
    dueDate: optional(row.due_date),
    currency: row.currency,
    exchangeRate: row.exchange_rate ? new Decimal(row.exchange_rate).toFixed(4) : undefined,
    paymentMethod: row.payment_method,
    isBancarizado: row.is_bancarizado,
    detraction: optional(row.detraction),
    canUseFiscalCredit: row.can_use_fiscal_credit,
    fiscalCreditRestrictionReason: optional(row.fiscal_credit_restriction_reason),
    totals: {
      baseGravadaExclusiva: row.base_gravada_exclusiva,
      igvGravadoExclusivo: row.igv_gravado_exclusivo,
      baseGravadaComun: row.base_gravada_comun,
      igvGravadoComun: row.igv_gravado_comun,
      baseGravadaSinCredito: row.base_gravada_sin_credito,
      igvGravadoSinCredito: row.igv_gravado_sin_credito,
      adquisicionesNoGravadas: row.adquisiciones_no_gravadas,
      isc: row.isc,
      icbper: row.icbper,
      otrosCargos: row.otros_cargos,
      totalAdquisicion: row.total_adquisicion,
      totalCreditoFiscal: row.total_credito_fiscal,
    },
    items,
    sireStatus: row.sire_status,
    createdAt: row.created_at,
  };
}

/** Registro de compras (RCE) persistido en el esquema private de PostgreSQL. */
export class PostgresPurchaseRepository implements IPurchaseRepository {
  constructor(private readonly pool: Pool) {}

  async upsertSupplier(companyRuc: string, supplier: SupplierProfile): Promise<SupplierProfile> {
    return this.upsertSupplierWith(this.pool, companyRuc, supplier);
  }

  async getSupplier(companyRuc: string, docNumber: string): Promise<SupplierProfile | null> {
    const result = await this.pool.query<SupplierRow>(
      `SELECT doc_type, doc_number, name, trade_name, is_habido, is_active, address, email
         FROM private.purchase_suppliers WHERE company_ruc = $1 AND doc_number = $2`,
      [companyRuc, docNumber],
    );
    return result.rows[0] ? mapSupplier(result.rows[0]) : null;
  }

  async save(record: PurchaseDocumentRecord): Promise<PurchaseDocumentRecord> {
    // El id en memoria usa Date.now(); en base de datos se usa un UUID para evitar colisiones.
    const id = `purch-${randomUUID()}`;
    try {
      await withTransaction(this.pool, async (client) => {
        await this.upsertSupplierWith(client, record.companyRuc, record.supplier);
        const t = record.totals;
        await client.query(
          `INSERT INTO private.purchase_documents (id, company_ruc, car, accounting_period, supplier_doc_type,
              supplier_doc_number, supplier_name, doc_type, series, correlative, full_number, issue_date,
              due_date, currency, exchange_rate, payment_method, is_bancarizado, detraction,
              can_use_fiscal_credit, fiscal_credit_restriction_reason, base_gravada_exclusiva,
              igv_gravado_exclusivo, base_gravada_comun, igv_gravado_comun, base_gravada_sin_credito,
              igv_gravado_sin_credito, adquisiciones_no_gravadas, isc, icbper, otros_cargos,
              total_adquisicion, total_credito_fiscal, sire_status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
              $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)`,
          [
            id,
            record.companyRuc,
            record.car,
            record.accountingPeriod,
            record.supplier.docType,
            record.supplier.docNumber,
            record.supplier.name,
            record.docType,
            record.series,
            record.correlative,
            record.fullNumber,
            record.issueDate,
            record.dueDate ?? null,
            record.currency,
            record.exchangeRate ?? null,
            record.paymentMethod,
            record.isBancarizado,
            record.detraction ? JSON.stringify(record.detraction) : null,
            record.canUseFiscalCredit,
            record.fiscalCreditRestrictionReason ?? null,
            t.baseGravadaExclusiva,
            t.igvGravadoExclusivo,
            t.baseGravadaComun,
            t.igvGravadoComun,
            t.baseGravadaSinCredito,
            t.igvGravadoSinCredito,
            t.adquisicionesNoGravadas,
            t.isc,
            t.icbper,
            t.otrosCargos,
            t.totalAdquisicion,
            t.totalCreditoFiscal,
            record.sireStatus,
            record.createdAt,
          ],
        );
        for (const [index, item] of record.items.entries()) {
          await client.query(
            `INSERT INTO private.purchase_items (purchase_id, line_number, item_ref, description, quantity,
                unit_value, net_base, igv_amount, total_amount, tax_destination, classification, has_fiscal_credit)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              id,
              index + 1,
              item.id ?? null,
              item.description,
              item.quantity,
              item.unitValue,
              item.netBase,
              item.igvAmount,
              item.totalAmount,
              item.taxDestination,
              item.classification,
              item.hasFiscalCredit,
            ],
          );
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_purchase_company_car')) {
        throw new DuplicatePurchaseError(record.car, record.fullNumber, record.supplier.docNumber);
      }
      throw error;
    }
    const saved = await this.findByCar(record.companyRuc, record.car);
    if (!saved) throw new Error(`No se pudo leer la compra ${record.car} después de guardarla.`);
    return saved;
  }

  async findByCar(companyRuc: string, car: string): Promise<PurchaseDocumentRecord | null> {
    const result = await this.pool.query<PurchaseRow>(`${PURCHASE_SELECT} WHERE d.company_ruc = $1 AND d.car = $2`, [
      companyRuc,
      car,
    ]);
    const [record] = await this.attachItems(result.rows);
    return record ?? null;
  }

  async listByPeriod(companyRuc: string, period: string): Promise<PurchaseDocumentRecord[]> {
    const result = await this.pool.query<PurchaseRow>(
      `${PURCHASE_SELECT} WHERE d.company_ruc = $1 AND d.accounting_period = $2 ORDER BY d.issue_date, d.car`,
      [companyRuc, period],
    );
    return this.attachItems(result.rows);
  }

  async updateSireStatus(companyRuc: string, car: string, status: PurchaseSireStatus): Promise<PurchaseDocumentRecord> {
    const result = await this.pool.query(
      `UPDATE private.purchase_documents SET sire_status = $3, updated_at = NOW()
        WHERE company_ruc = $1 AND car = $2`,
      [companyRuc, car, status],
    );
    if (!result.rowCount) {
      throw new Error(`Comprobante de compra con CAR ${car} no encontrado.`);
    }
    const updated = await this.findByCar(companyRuc, car);
    if (!updated) throw new Error(`Comprobante de compra con CAR ${car} no encontrado.`);
    return updated;
  }

  private async upsertSupplierWith(db: Queryable, companyRuc: string, supplier: SupplierProfile): Promise<SupplierProfile> {
    const result = await db.query<SupplierRow>(
      `INSERT INTO private.purchase_suppliers (company_ruc, doc_type, doc_number, name, trade_name, is_habido,
          is_active, address, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_ruc, doc_number) DO UPDATE SET
          doc_type = EXCLUDED.doc_type, name = EXCLUDED.name, trade_name = EXCLUDED.trade_name,
          is_habido = EXCLUDED.is_habido, is_active = EXCLUDED.is_active, address = EXCLUDED.address,
          email = EXCLUDED.email, updated_at = NOW()
       RETURNING doc_type, doc_number, name, trade_name, is_habido, is_active, address, email`,
      [
        companyRuc,
        supplier.docType,
        supplier.docNumber,
        supplier.name,
        supplier.tradeName ?? null,
        supplier.isHabido ?? true,
        supplier.isActive ?? true,
        supplier.address ?? null,
        supplier.email ?? null,
      ],
    );
    return mapSupplier(result.rows[0]);
  }

  private async attachItems(rows: PurchaseRow[]): Promise<PurchaseDocumentRecord[]> {
    if (rows.length === 0) return [];
    const itemResult = await this.pool.query<PurchaseItemRow>(
      `${ITEM_SELECT} WHERE purchase_id = ANY($1::varchar[]) ORDER BY purchase_id, line_number`,
      [rows.map((row) => row.id)],
    );
    const itemsByPurchase = new Map<string, PurchaseCalculatedItem[]>();
    for (const itemRow of itemResult.rows) {
      const list = itemsByPurchase.get(itemRow.purchase_id) ?? [];
      list.push(mapItem(itemRow));
      itemsByPurchase.set(itemRow.purchase_id, list);
    }
    return rows.map((row) => mapPurchase(row, itemsByPurchase.get(row.id) ?? []));
  }
}
