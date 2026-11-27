import type { Pool, QueryResultRow } from 'pg';
import type { CpeAggregate, ICpeRepository } from '../repositories/cpe.repository.js';
import type {
  CpeDatabaseStatus,
  CpeDocumentEntity,
  CpeItemEntity,
  CpeQueryFilter,
  CpeStatusUpdateDto,
  CreateCpeDocumentDto,
  CreateCpeItemDto,
} from '../repositories/types.js';
import { isForeignKeyViolation, isoTimestamp, isUniqueViolation, isUuid, optional, withTransaction } from './pg-utils.js';
import type { Queryable } from './pg-utils.js';

interface CpeDocumentRow extends QueryResultRow {
  id: string;
  company_id: string;
  cpe_type: string;
  series: string;
  correlative: number;
  full_number: string;
  issue_date: string;
  issue_time: string;
  currency: 'PEN' | 'USD';
  exchange_rate: string | null;
  payment_method: 'CONTADO' | 'CREDITO';
  client_doc_type: string;
  client_doc_number: string;
  client_name: string;
  client_address: string | null;
  client_email: string | null;
  operaciones_gravadas: string;
  operaciones_exoneradas: string;
  operaciones_inafectas: string;
  operaciones_gratuitas: string;
  total_descuentos: string;
  monto_igv: string;
  subtotal: string;
  total_pagar: string;
  total_letras: string;
  status: CpeDatabaseStatus;
  sunat_response_code: string | null;
  sunat_description: string | null;
  xml_hash: string | null;
  cdr_received_at: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface CpeItemRow extends QueryResultRow {
  id: string;
  cpe_id: string;
  line_number: number;
  item_code: string | null;
  description: string;
  unit_code: string;
  quantity: string;
  unit_value: string;
  unit_price: string;
  affectation_type: string;
  discount_amount: string;
  igv_amount: string;
  total_amount: string;
}

// Fechas, horas y NUMERIC se leen como texto para no perder precisión ni zona horaria.
const DOCUMENT_COLUMNS = `id::text AS id, company_id::text AS company_id, cpe_type, series, correlative,
  full_number, issue_date::text AS issue_date, issue_time::text AS issue_time, currency,
  exchange_rate::text AS exchange_rate, payment_method, client_doc_type, client_doc_number, client_name,
  client_address, client_email, operaciones_gravadas::text AS operaciones_gravadas,
  operaciones_exoneradas::text AS operaciones_exoneradas, operaciones_inafectas::text AS operaciones_inafectas,
  operaciones_gratuitas::text AS operaciones_gratuitas, total_descuentos::text AS total_descuentos,
  monto_igv::text AS monto_igv, subtotal::text AS subtotal, total_pagar::text AS total_pagar, total_letras,
  status, sunat_response_code, sunat_description, xml_hash,
  ${isoTimestamp('cdr_received_at')} AS cdr_received_at, raw_payload,
  ${isoTimestamp('created_at')} AS created_at, ${isoTimestamp('updated_at')} AS updated_at`;

const ITEM_COLUMNS = `id::text AS id, cpe_id::text AS cpe_id, line_number, item_code, description, unit_code,
  quantity::text AS quantity, unit_value::text AS unit_value, unit_price::text AS unit_price, affectation_type,
  discount_amount::text AS discount_amount, igv_amount::text AS igv_amount, total_amount::text AS total_amount`;

function mapDocument(row: CpeDocumentRow): CpeDocumentEntity {
  return {
    id: row.id,
    companyId: row.company_id,
    cpeType: row.cpe_type,
    series: row.series,
    correlative: row.correlative,
    fullNumber: row.full_number,
    issueDate: row.issue_date,
    issueTime: row.issue_time,
    currency: row.currency,
    exchangeRate: optional(row.exchange_rate),
    paymentMethod: row.payment_method,
    clientDocType: row.client_doc_type,
    clientDocNumber: row.client_doc_number,
    clientName: row.client_name,
    clientAddress: optional(row.client_address),
    clientEmail: optional(row.client_email),
    operacionesGravadas: row.operaciones_gravadas,
    operacionesExoneradas: row.operaciones_exoneradas,
    operacionesInafectas: row.operaciones_inafectas,
    operacionesGratuitas: row.operaciones_gratuitas,
    totalDescuentos: row.total_descuentos,
    montoIgv: row.monto_igv,
    subtotal: row.subtotal,
    totalPagar: row.total_pagar,
    totalLetras: row.total_letras,
    status: row.status,
    sunatResponseCode: optional(row.sunat_response_code),
    sunatDescription: optional(row.sunat_description),
    xmlHash: optional(row.xml_hash),
    cdrReceivedAt: optional(row.cdr_received_at),
    rawPayload: row.raw_payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapItem(row: CpeItemRow): CpeItemEntity {
  return {
    id: row.id,
    cpeId: row.cpe_id,
    lineNumber: row.line_number,
    itemCode: optional(row.item_code),
    description: row.description,
    unitCode: row.unit_code,
    quantity: row.quantity,
    unitValue: row.unit_value,
    unitPrice: row.unit_price,
    affectationType: row.affectation_type,
    discountAmount: row.discount_amount,
    igvAmount: row.igv_amount,
    totalAmount: row.total_amount,
  };
}

export function statusFromCdrCode(code: string): CpeDatabaseStatus {
  if (code === '0') return 'ACEPTADO';
  if (code.startsWith('4')) return 'ACEPTADO_CON_OBSERVACIONES';
  return 'RECHAZADO';
}

/** Repositorio de comprobantes emitidos sobre PostgreSQL (cpe_documents y cpe_items). */
export class PostgresCpeRepository implements ICpeRepository {
  constructor(private readonly pool: Pool) {}

  async create(documentDto: CreateCpeDocumentDto, itemsDto: CreateCpeItemDto[]): Promise<CpeAggregate> {
    if (!itemsDto || itemsDto.length === 0) {
      throw new Error('Un comprobante de pago electrónico debe tener al menos un ítem');
    }
    if (!isUuid(documentDto.companyId)) {
      throw new Error(`Empresa con ID ${documentDto.companyId} no existe`);
    }

    try {
      return await withTransaction(this.pool, async (client) => {
        const documentResult = await client.query<CpeDocumentRow>(
          `INSERT INTO cpe_documents (company_id, cpe_type, series, correlative, full_number, issue_date,
              issue_time, currency, exchange_rate, payment_method, client_doc_type, client_doc_number,
              client_name, client_address, client_email, operaciones_gravadas, operaciones_exoneradas,
              operaciones_inafectas, operaciones_gratuitas, total_descuentos, monto_igv, subtotal,
              total_pagar, total_letras, status, xml_hash, raw_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
              $19, $20, $21, $22, $23, $24, $25, $26, $27)
           RETURNING ${DOCUMENT_COLUMNS}`,
          [
            documentDto.companyId,
            documentDto.cpeType,
            documentDto.series.toUpperCase(),
            documentDto.correlative,
            documentDto.fullNumber.toUpperCase(),
            documentDto.issueDate,
            documentDto.issueTime || new Date().toTimeString().split(' ')[0],
            documentDto.currency,
            documentDto.exchangeRate ?? null,
            documentDto.paymentMethod,
            documentDto.clientDocType,
            documentDto.clientDocNumber,
            documentDto.clientName.trim(),
            documentDto.clientAddress?.trim() ?? null,
            documentDto.clientEmail?.trim() ?? null,
            documentDto.operacionesGravadas,
            documentDto.operacionesExoneradas || '0.00',
            documentDto.operacionesInafectas || '0.00',
            documentDto.operacionesGratuitas || '0.00',
            documentDto.totalDescuentos || '0.00',
            documentDto.montoIgv,
            documentDto.subtotal,
            documentDto.totalPagar,
            documentDto.totalLetras,
            documentDto.status || 'CALCULADO',
            documentDto.xmlHash ?? null,
            JSON.stringify(documentDto.rawPayload ?? {}),
          ],
        );
        const document = mapDocument(documentResult.rows[0]);
        const items: CpeItemEntity[] = [];
        for (const item of itemsDto) {
          const itemResult = await client.query<CpeItemRow>(
            `INSERT INTO cpe_items (cpe_id, line_number, item_code, description, unit_code, quantity,
                unit_value, unit_price, affectation_type, discount_amount, igv_amount, total_amount)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING ${ITEM_COLUMNS}`,
            [
              document.id,
              item.lineNumber,
              item.itemCode ?? null,
              item.description.trim(),
              item.unitCode || 'NIU',
              item.quantity,
              item.unitValue,
              item.unitPrice,
              item.affectationType,
              item.discountAmount || '0.00',
              item.igvAmount,
              item.totalAmount,
            ],
          );
          items.push(mapItem(itemResult.rows[0]));
        }
        return { document, items };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'uq_company_full_number')) {
        throw new Error(`El comprobante ${documentDto.fullNumber} ya se encuentra registrado para esta empresa`);
      }
      if (isForeignKeyViolation(error)) {
        throw new Error(`Empresa con ID ${documentDto.companyId} no existe`);
      }
      throw error;
    }
  }

  async findById(id: string): Promise<CpeAggregate | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query<CpeDocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM cpe_documents WHERE id = $1`, [id]);
    return result.rows[0] ? this.withItems(result.rows[0]) : null;
  }

  async findByFullNumber(companyId: string, fullNumber: string): Promise<CpeAggregate | null> {
    if (!isUuid(companyId)) return null;
    const result = await this.pool.query<CpeDocumentRow>(
      `SELECT ${DOCUMENT_COLUMNS} FROM cpe_documents WHERE company_id = $1 AND full_number = $2`,
      [companyId, fullNumber.toUpperCase()],
    );
    return result.rows[0] ? this.withItems(result.rows[0]) : null;
  }

  async updateStatus(id: string, update: CpeStatusUpdateDto): Promise<CpeDocumentEntity> {
    const result = isUuid(id)
      ? await this.pool.query<CpeDocumentRow>(
        `UPDATE cpe_documents
            SET status = $2,
                sunat_response_code = COALESCE($3, sunat_response_code),
                sunat_description = COALESCE($4, sunat_description),
                xml_hash = COALESCE($5, xml_hash),
                cdr_received_at = COALESCE($6::timestamptz, cdr_received_at),
                updated_at = NOW()
          WHERE id = $1
          RETURNING ${DOCUMENT_COLUMNS}`,
        [
          id,
          update.status,
          update.sunatResponseCode ?? null,
          update.sunatDescription ?? null,
          update.xmlHash ?? null,
          update.cdrReceivedAt ?? null,
        ],
      )
      : { rows: [] as CpeDocumentRow[] };
    if (!result.rows[0]) {
      throw new Error(`Comprobante ${id} no encontrado`);
    }
    return mapDocument(result.rows[0]);
  }

  async attachCdr(
    id: string,
    cdrData: { cdrReceivedAt: string; sunatResponseCode: string; sunatDescription: string; xmlHash?: string },
  ): Promise<CpeDocumentEntity> {
    return this.updateStatus(id, {
      status: statusFromCdrCode(cdrData.sunatResponseCode),
      cdrReceivedAt: cdrData.cdrReceivedAt,
      sunatResponseCode: cdrData.sunatResponseCode,
      sunatDescription: cdrData.sunatDescription,
      xmlHash: cdrData.xmlHash,
    });
  }

  async listByCompany(companyId: string, filter?: CpeQueryFilter): Promise<CpeDocumentEntity[]> {
    if (!isUuid(companyId)) return [];
    const conditions = ['company_id = $1'];
    const params: unknown[] = [companyId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (filter?.cpeType) add('cpe_type = ?', filter.cpeType);
    if (filter?.series) add('series = ?', filter.series.toUpperCase());
    if (filter?.status) add('status = ?', filter.status);
    if (filter?.clientDocNumber) add('client_doc_number = ?', filter.clientDocNumber);
    if (filter?.startDate) add('issue_date >= ?::date', filter.startDate);
    if (filter?.endDate) add('issue_date <= ?::date', filter.endDate);

    let sql = `SELECT ${DOCUMENT_COLUMNS} FROM cpe_documents WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, id DESC`;
    if (filter?.limit) {
      params.push(Math.max(1, Math.floor(filter.limit)));
      sql += ` LIMIT $${params.length}`;
    }
    if (filter?.offset) {
      params.push(Math.max(0, Math.floor(filter.offset)));
      sql += ` OFFSET $${params.length}`;
    }
    const result = await this.pool.query<CpeDocumentRow>(sql, params);
    return result.rows.map(mapDocument);
  }

  async getItems(cpeId: string): Promise<CpeItemEntity[]> {
    if (!isUuid(cpeId)) return [];
    return this.loadItems(this.pool, cpeId);
  }

  private async withItems(row: CpeDocumentRow): Promise<CpeAggregate> {
    return { document: mapDocument(row), items: await this.loadItems(this.pool, row.id) };
  }

  private async loadItems(db: Queryable, cpeId: string): Promise<CpeItemEntity[]> {
    const result = await db.query<CpeItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM cpe_items WHERE cpe_id = $1 ORDER BY line_number`,
      [cpeId],
    );
    return result.rows.map(mapItem);
  }
}
