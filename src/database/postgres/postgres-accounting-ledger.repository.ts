import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  AccountingPeriodRecord,
  AccountingPeriodStatus,
  JournalEntry,
  JournalEntryLine,
  OriginDocumentReference,
  TrialBalance,
} from '../../modules/accounting/types.js';
import {
  AccountingLedgerSnapshot,
  closedPeriodMessage,
  closedYearMessage,
  ConcurrentPeriodChangeError,
  IAccountingLedgerRepository,
  resolveEntryId,
} from '../repositories/accounting-ledger.repository.js';
import { isoTimestamp, isUniqueViolation, optional, Queryable, withTransaction } from './pg-utils.js';

interface EntryRow extends QueryResultRow {
  id: string;
  company_id: string;
  accounting_period: string;
  entry_number: number;
  entry_date: string;
  glosa: string;
  currency: 'PEN' | 'USD';
  exchange_rate: string | null;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
  status: 'POSTED' | 'PENDING' | 'DRAFT';
  is_opening: boolean;
  is_closing: boolean;
  origin_document: OriginDocumentReference | null;
  created_at: string;
}

interface LineRow extends QueryResultRow {
  entry_id: string;
  line_number: number;
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
  glosa: string;
  cost_center: string | null;
  reference_doc: string | null;
}

interface PeriodRow extends QueryResultRow {
  company_id: string;
  period: string;
  status: AccountingPeriodStatus;
  total_entries: number;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
  closed_at: string | null;
  closed_by: string | null;
  closing_notes: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
  trial_balance_snapshot: TrialBalance | null;
}

const ENTRY_COLUMNS = `id, company_id, accounting_period, entry_number, entry_date::text AS entry_date, glosa,
  currency, exchange_rate::text AS exchange_rate, total_debit::text AS total_debit,
  total_credit::text AS total_credit, is_balanced, status, is_opening, is_closing, origin_document,
  ${isoTimestamp('created_at')} AS created_at`;

const LINE_COLUMNS = `l.entry_id, l.line_number, l.account_code, l.account_name, l.debit::text AS debit,
  l.credit::text AS credit, l.glosa, l.cost_center, l.reference_doc`;

const PERIOD_COLUMNS = `company_id, period, status, total_entries, total_debit::text AS total_debit,
  total_credit::text AS total_credit, is_balanced, ${isoTimestamp('closed_at')} AS closed_at, closed_by,
  closing_notes, ${isoTimestamp('reopened_at')} AS reopened_at, reopened_by, reopen_reason, trial_balance_snapshot`;

function mapLine(row: LineRow): JournalEntryLine {
  return {
    lineNumber: row.line_number,
    accountCode: row.account_code,
    accountName: row.account_name,
    debit: row.debit,
    credit: row.credit,
    glosa: row.glosa,
    costCenter: optional(row.cost_center),
    referenceDoc: optional(row.reference_doc),
  };
}

function mapEntry(row: EntryRow, lines: JournalEntryLine[]): JournalEntry {
  return {
    id: row.id,
    companyId: row.company_id,
    accountingPeriod: row.accounting_period,
    entryNumber: row.entry_number,
    entryDate: row.entry_date,
    glosa: row.glosa,
    currency: row.currency,
    exchangeRate: optional(row.exchange_rate),
    originDocument: optional(row.origin_document),
    lines,
    totalDebit: row.total_debit,
    totalCredit: row.total_credit,
    isBalanced: row.is_balanced,
    status: row.status,
    isOpening: row.is_opening,
    isClosing: row.is_closing,
    createdAt: row.created_at,
  };
}

function mapPeriod(row: PeriodRow): AccountingPeriodRecord {
  return {
    companyId: row.company_id,
    period: row.period,
    status: row.status,
    totalEntries: row.total_entries,
    totalDebit: row.total_debit,
    totalCredit: row.total_credit,
    isBalanced: row.is_balanced,
    closedAt: optional(row.closed_at),
    closedBy: optional(row.closed_by),
    closingNotes: optional(row.closing_notes),
    reopenedAt: optional(row.reopened_at),
    reopenedBy: optional(row.reopened_by),
    reopenReason: optional(row.reopen_reason),
    trialBalanceSnapshot: optional(row.trial_balance_snapshot),
  };
}

/**
 * Libro Diario y períodos mensuales sobre las tablas private.accounting_* .
 * Escrituras de un mismo período se serializan con un advisory lock transaccional.
 */
export class PostgresAccountingLedgerRepository implements IAccountingLedgerRepository {
  constructor(private readonly pool: Pool) {}

  async loadLedger(companyId: string, fiscalYear?: string): Promise<AccountingLedgerSnapshot> {
    const client = await this.pool.connect();
    try {
      // Lectura consistente: asientos, líneas y períodos describen el mismo instante.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const scope = fiscalYear ? ' AND left(accounting_period, 4) = $2' : '';
      const params = fiscalYear ? [companyId, fiscalYear] : [companyId];
      const entryResult = await client.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM private.accounting_journal_entries
          WHERE company_id = $1${scope} ORDER BY accounting_period, entry_number`,
        params,
      );
      const entries = await this.attachLines(client, entryResult.rows);
      const periodResult = await client.query<PeriodRow>(
        `SELECT ${PERIOD_COLUMNS} FROM private.accounting_periods
          WHERE company_id = $1${fiscalYear ? ' AND left(period, 4) = $2' : ''} ORDER BY period`,
        params,
      );
      await client.query('COMMIT');
      return { entries, periods: periodResult.rows.map(mapPeriod) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findEntry(companyId: string, entryId: string): Promise<JournalEntry | null> {
    const result = await this.pool.query<EntryRow>(
      `SELECT ${ENTRY_COLUMNS} FROM private.accounting_journal_entries WHERE company_id = $1 AND id = $2`,
      [companyId, entryId],
    );
    const [entry] = await this.attachLines(this.pool, result.rows);
    return entry ?? null;
  }

  async appendEntry(entry: JournalEntry): Promise<JournalEntry> {
    try {
      return await withTransaction(this.pool, async (client) => {
        await this.lockPeriod(client, entry.companyId, entry.accountingPeriod);
        const fiscalYear = entry.accountingPeriod.slice(0, 4);
        if (!entry.isClosing) {
          if (await this.isFiscalYearClosedWith(client, entry.companyId, fiscalYear)) {
            throw new Error(closedYearMessage(entry.companyId, fiscalYear));
          }
          if ((await this.currentPeriodStatus(client, entry.companyId, entry.accountingPeriod)) === 'CLOSED') {
            throw new Error(closedPeriodMessage(entry.companyId, entry.accountingPeriod));
          }
        }

        const numberResult = await client.query<{ next_number: number }>(
          `SELECT COALESCE(MAX(entry_number), 0) + 1 AS next_number
             FROM private.accounting_journal_entries WHERE company_id = $1 AND accounting_period = $2`,
          [entry.companyId, entry.accountingPeriod],
        );
        const entryNumber = numberResult.rows[0].next_number;
        const id = resolveEntryId(entry, entryNumber);

        const inserted = await client.query<EntryRow>(
          `INSERT INTO private.accounting_journal_entries (id, company_id, accounting_period, entry_number,
              entry_date, glosa, currency, exchange_rate, total_debit, total_credit, is_balanced, status,
              is_opening, is_closing, origin_document, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING ${ENTRY_COLUMNS}`,
          [
            id,
            entry.companyId,
            entry.accountingPeriod,
            entryNumber,
            entry.entryDate,
            entry.glosa,
            entry.currency,
            entry.exchangeRate ?? null,
            entry.totalDebit,
            entry.totalCredit,
            entry.isBalanced,
            entry.status ?? 'POSTED',
            Boolean(entry.isOpening),
            Boolean(entry.isClosing),
            entry.originDocument ? JSON.stringify(entry.originDocument) : null,
            entry.createdAt,
          ],
        );
        for (const line of entry.lines) {
          await client.query(
            `INSERT INTO private.accounting_journal_entry_lines (entry_id, line_number, account_code,
                account_name, debit, credit, glosa, cost_center, reference_doc)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id,
              line.lineNumber,
              line.accountCode,
              line.accountName,
              line.debit,
              line.credit,
              line.glosa ?? entry.glosa,
              line.costCenter ?? null,
              line.referenceDoc ?? null,
            ],
          );
        }
        const [saved] = await this.attachLines(client, inserted.rows);
        return saved;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'accounting_journal_entries_pkey')) {
        throw new Error(`Ya existe un asiento contable con id ${entry.id}`);
      }
      throw error;
    }
  }

  async markEntryPosted(companyId: string, entryId: string): Promise<JournalEntry> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<EntryRow>(
        `SELECT ${ENTRY_COLUMNS} FROM private.accounting_journal_entries WHERE company_id = $1 AND id = $2`,
        [companyId, entryId],
      );
      const row = found.rows[0];
      if (!row) throw new Error(`Asiento contable con id ${entryId} no encontrado`);

      await this.lockPeriod(client, companyId, row.accounting_period);
      const fiscalYear = row.accounting_period.slice(0, 4);
      if (await this.isFiscalYearClosedWith(client, companyId, fiscalYear)) {
        throw new Error(`No se puede contabilizar el asiento: el ejercicio fiscal ${fiscalYear} ya se encuentra cerrado`);
      }
      if ((await this.currentPeriodStatus(client, companyId, row.accounting_period)) === 'CLOSED') {
        throw new Error(`No se puede contabilizar el asiento: el período ${row.accounting_period} ya se encuentra cerrado`);
      }
      const updated = await client.query<EntryRow>(
        `UPDATE private.accounting_journal_entries SET status = 'POSTED'
          WHERE company_id = $1 AND id = $2 RETURNING ${ENTRY_COLUMNS}`,
        [companyId, entryId],
      );
      const [entry] = await this.attachLines(client, updated.rows);
      return entry;
    });
  }

  async savePeriod(record: AccountingPeriodRecord, expectedStatus: AccountingPeriodStatus): Promise<AccountingPeriodRecord> {
    return withTransaction(this.pool, async (client) => {
      await this.lockPeriod(client, record.companyId, record.period);
      const current = await this.currentPeriodStatus(client, record.companyId, record.period);
      if (current !== expectedStatus) {
        throw new ConcurrentPeriodChangeError(
          `El período ${record.period} cambió de estado (${current}) mientras se procesaba la operación. Vuelve a intentarlo.`,
        );
      }
      if (record.status === 'CLOSED') {
        const count = await client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total FROM private.accounting_journal_entries
            WHERE company_id = $1 AND accounting_period = $2`,
          [record.companyId, record.period],
        );
        if (count.rows[0].total !== record.totalEntries) {
          throw new ConcurrentPeriodChangeError(
            `Se registraron asientos en ${record.period} mientras se validaba el cierre. Vuelve a ejecutar el cierre.`,
          );
        }
      }

      const result = await client.query<PeriodRow>(
        `INSERT INTO private.accounting_periods (company_id, period, status, total_entries, total_debit,
            total_credit, is_balanced, closed_at, closed_by, closing_notes, reopened_at, reopened_by,
            reopen_reason, trial_balance_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (company_id, period) DO UPDATE SET
            status = EXCLUDED.status, total_entries = EXCLUDED.total_entries,
            total_debit = EXCLUDED.total_debit, total_credit = EXCLUDED.total_credit,
            is_balanced = EXCLUDED.is_balanced, closed_at = EXCLUDED.closed_at,
            closed_by = EXCLUDED.closed_by, closing_notes = EXCLUDED.closing_notes,
            reopened_at = EXCLUDED.reopened_at, reopened_by = EXCLUDED.reopened_by,
            reopen_reason = EXCLUDED.reopen_reason, trial_balance_snapshot = EXCLUDED.trial_balance_snapshot
         RETURNING ${PERIOD_COLUMNS}`,
        [
          record.companyId,
          record.period,
          record.status,
          record.totalEntries,
          record.totalDebit,
          record.totalCredit,
          record.isBalanced,
          record.closedAt ?? null,
          record.closedBy ?? null,
          record.closingNotes ?? null,
          record.reopenedAt ?? null,
          record.reopenedBy ?? null,
          record.reopenReason ?? null,
          record.trialBalanceSnapshot ? JSON.stringify(record.trialBalanceSnapshot) : null,
        ],
      );
      return mapPeriod(result.rows[0]);
    });
  }

  async isFiscalYearClosed(companyId: string, fiscalYear: string): Promise<boolean> {
    return this.isFiscalYearClosedWith(this.pool, companyId, fiscalYear);
  }

  private async lockPeriod(client: PoolClient, companyId: string, period: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`accounting:${companyId}:${period}`]);
  }

  private async currentPeriodStatus(db: Queryable, companyId: string, period: string): Promise<AccountingPeriodStatus> {
    const result = await db.query<{ status: AccountingPeriodStatus }>(
      'SELECT status FROM private.accounting_periods WHERE company_id = $1 AND period = $2',
      [companyId, period],
    );
    return result.rows[0]?.status ?? 'OPEN';
  }

  private async isFiscalYearClosedWith(db: Queryable, companyId: string, fiscalYear: string): Promise<boolean> {
    const result = await db.query<{ status: string }>(
      `SELECT annual_close_status AS status FROM private.accounting_fiscal_years
        WHERE company_id = $1 AND fiscal_year = $2`,
      [companyId, fiscalYear],
    );
    return result.rows[0]?.status === 'CLOSED';
  }

  private async attachLines(db: Queryable, rows: EntryRow[]): Promise<JournalEntry[]> {
    if (rows.length === 0) return [];
    const lineResult = await db.query<LineRow>(
      `SELECT ${LINE_COLUMNS} FROM private.accounting_journal_entry_lines l
        WHERE l.entry_id = ANY($1::varchar[]) ORDER BY l.entry_id, l.line_number`,
      [rows.map((row) => row.id)],
    );
    const linesByEntry = new Map<string, JournalEntryLine[]>();
    for (const line of lineResult.rows) {
      const list = linesByEntry.get(line.entry_id) ?? [];
      list.push(mapLine(line));
      linesByEntry.set(line.entry_id, list);
    }
    return rows.map((row) => mapEntry(row, linesByEntry.get(row.id) ?? []));
  }
}
