import { Pool } from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  AccountingPeriodRecord,
  AnnualCloseRecord,
  JournalEntry,
  JournalEntryLine,
  OriginDocumentReference,
  TrialBalance,
} from "../../modules/accounting/types.js";
import {
  AnnualCloseRepository,
  AnnualCloseSnapshot,
  CommitAnnualCloseInput,
  ConcurrentAnnualCloseError,
} from "./annual-close.repository.js";

interface FiscalYearRow extends QueryResultRow {
  revision: string;
  annual_close_status: "OPEN" | "CLOSED";
}

interface EntryRow extends QueryResultRow {
  id: string;
  company_id: string;
  accounting_period: string;
  entry_number: number;
  entry_date: string;
  glosa: string;
  currency: "PEN" | "USD";
  exchange_rate: string | null;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
  status: "POSTED" | "PENDING" | "DRAFT";
  is_opening: boolean;
  is_closing: boolean;
  origin_document: OriginDocumentReference | null;
  created_at: string;
}

interface EntryLineRow extends QueryResultRow {
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
  status: "OPEN" | "CLOSED";
  total_entries: number;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
  closed_at: string | null;
  closed_by: string | null;
  closing_notes: string | null;
  trial_balance_snapshot: TrialBalance | null;
}

function toSafeRevision(value: string): number {
  const revision = BigInt(value);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("La revisión del ejercicio excede el rango seguro de JavaScript.");
  }
  return Number(revision);
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
    exchangeRate: row.exchange_rate ?? undefined,
    originDocument: row.origin_document ?? undefined,
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
    closedAt: row.closed_at ?? undefined,
    closedBy: row.closed_by ?? undefined,
    closingNotes: row.closing_notes ?? undefined,
    trialBalanceSnapshot: row.trial_balance_snapshot ?? undefined,
  };
}

/** PostgreSQL adapter. The Pool must use a server-only connection string. */
export class PostgresAnnualCloseRepository implements AnnualCloseRepository {
  constructor(private readonly pool: Pool) {}

  async loadSnapshot(companyId: string, fiscalYear: string): Promise<AnnualCloseSnapshot> {
    const client = await this.pool.connect();
    try {
      // A consistent read ensures the returned revision and ledger describe the
      // same database snapshot. The final commit checks revision again under lock.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const fiscalYearResult = await client.query<FiscalYearRow>(
        `SELECT revision::text, annual_close_status
           FROM private.accounting_fiscal_years
          WHERE company_id = $1 AND fiscal_year = $2`,
        [companyId, fiscalYear],
      );
      const yearState = fiscalYearResult.rows[0];
      const revision = yearState ? toSafeRevision(yearState.revision) : 0;
      const followingJanuary = `${Number(fiscalYear) + 1}-01`;
      const entriesResult = await client.query<EntryRow>(
        `SELECT id, company_id, accounting_period, entry_number,
                entry_date::text AS entry_date, glosa, currency,
                exchange_rate::text AS exchange_rate,
                total_debit::text AS total_debit, total_credit::text AS total_credit,
                is_balanced, status, is_opening, is_closing,
                origin_document, created_at::text AS created_at
           FROM private.accounting_journal_entries
          WHERE company_id = $1
            AND accounting_period >= $2
            AND accounting_period <= $3
          ORDER BY accounting_period, entry_number`,
        [companyId, `${fiscalYear}-01`, followingJanuary],
      );
      const linesResult = await client.query<EntryLineRow>(
        `SELECT l.entry_id, l.line_number, l.account_code, l.account_name,
                l.debit::text AS debit, l.credit::text AS credit, l.glosa,
                l.cost_center, l.reference_doc
           FROM private.accounting_journal_entry_lines l
           JOIN private.accounting_journal_entries e ON e.id = l.entry_id
          WHERE e.company_id = $1
            AND e.accounting_period >= $2
            AND e.accounting_period <= $3
          ORDER BY e.accounting_period, e.entry_number, l.line_number`,
        [companyId, `${fiscalYear}-01`, followingJanuary],
      );
      const linesByEntry = new Map<string, JournalEntryLine[]>();
      for (const row of linesResult.rows) {
        const lines = linesByEntry.get(row.entry_id) ?? [];
        lines.push({
          lineNumber: row.line_number,
          accountCode: row.account_code,
          accountName: row.account_name,
          debit: row.debit,
          credit: row.credit,
          glosa: row.glosa,
          costCenter: row.cost_center ?? undefined,
          referenceDoc: row.reference_doc ?? undefined,
        });
        linesByEntry.set(row.entry_id, lines);
      }
      const entries = entriesResult.rows.map((row) => mapEntry(row, linesByEntry.get(row.id) ?? []));

      const periodsResult = await client.query<PeriodRow>(
        `SELECT company_id, period, status, total_entries,
                total_debit::text AS total_debit, total_credit::text AS total_credit,
                is_balanced, closed_at::text AS closed_at, closed_by, closing_notes,
                trial_balance_snapshot
           FROM private.accounting_periods
          WHERE company_id = $1
            AND period >= $2
            AND period <= $3
          ORDER BY period`,
        [companyId, `${fiscalYear}-01`, followingJanuary],
      );

      const closeResult = await client.query<QueryResultRow & { close_record: AnnualCloseRecord }>(
        `SELECT close_record
           FROM private.accounting_annual_closes
          WHERE company_id = $1 AND fiscal_year = $2`,
        [companyId, fiscalYear],
      );
      await client.query("COMMIT");
      return {
        revision,
        fiscalYearStatus: yearState?.annual_close_status ?? "OPEN",
        entries,
        periods: periodsResult.rows.map(mapPeriod),
        closeRecord: closeResult.rows[0]?.close_record,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async commitAnnualClose(input: CommitAnnualCloseInput): Promise<void> {
    const client = await this.pool.connect();
    const opening = input.record.nextYearOpeningEntry;
    const nextYear = String(Number(input.fiscalYear) + 1);
    try {
      await client.query("BEGIN");
      const yearsToLock = [input.fiscalYear, ...(opening ? [nextYear] : [])].sort();
      for (const year of yearsToLock) {
        await client.query(
          `INSERT INTO private.accounting_fiscal_years (company_id, fiscal_year)
           VALUES ($1, $2)
           ON CONFLICT (company_id, fiscal_year) DO NOTHING`,
          [input.companyId, year],
        );
      }

      const states = new Map<string, FiscalYearRow>();
      for (const year of yearsToLock) {
        const state = await client.query<FiscalYearRow>(
          `SELECT revision::text, annual_close_status
             FROM private.accounting_fiscal_years
            WHERE company_id = $1 AND fiscal_year = $2
            FOR UPDATE`,
          [input.companyId, year],
        );
        states.set(year, state.rows[0]);
      }

      const currentState = states.get(input.fiscalYear)!;
      if (toSafeRevision(currentState.revision) !== input.expectedRevision) {
        throw new ConcurrentAnnualCloseError();
      }
      if (currentState.annual_close_status === "CLOSED") {
        throw new ConcurrentAnnualCloseError("El ejercicio ya fue cerrado; actualiza la pantalla.");
      }
      if (opening && states.get(nextYear)?.annual_close_status === "CLOSED") {
        throw new ConcurrentAnnualCloseError("El ejercicio siguiente ya está cerrado; no se puede registrar su apertura.");
      }

      for (const entry of input.record.closingEntries) await this.insertEntry(client, entry);
      if (opening) await this.insertEntry(client, opening);

      await client.query(
        `INSERT INTO private.accounting_annual_closes
           (company_id, fiscal_year, status, closed_at, closed_by, closing_notes,
            net_income, net_expense, accounting_result, result_type, close_record)
         VALUES ($1, $2, 'CLOSED', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (company_id, fiscal_year) DO UPDATE SET
           status = EXCLUDED.status,
           closed_at = EXCLUDED.closed_at,
           closed_by = EXCLUDED.closed_by,
           closing_notes = EXCLUDED.closing_notes,
           net_income = EXCLUDED.net_income,
           net_expense = EXCLUDED.net_expense,
           accounting_result = EXCLUDED.accounting_result,
           result_type = EXCLUDED.result_type,
           close_record = EXCLUDED.close_record`,
        [
          input.companyId,
          input.fiscalYear,
          input.record.closedAt,
          input.record.closedBy,
          input.record.closingNotes ?? null,
          input.record.netIncome,
          input.record.netExpense,
          input.record.accountingResult,
          input.record.resultType,
          JSON.stringify(input.record),
        ],
      );
      await client.query(
        `UPDATE private.accounting_fiscal_years
            SET annual_close_status = 'CLOSED', revision = revision + 1, updated_at = NOW()
          WHERE company_id = $1 AND fiscal_year = $2`,
        [input.companyId, input.fiscalYear],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof ConcurrentAnnualCloseError) throw error;
      if (isUniqueViolation(error)) {
        throw new ConcurrentAnnualCloseError("Ya existe un asiento con ese identificador o correlativo; actualiza la pantalla.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertEntry(client: PoolClient, entry: JournalEntry): Promise<void> {
    await client.query(
      `INSERT INTO private.accounting_journal_entries
         (id, company_id, accounting_period, entry_number, entry_date, glosa,
          currency, exchange_rate, total_debit, total_credit, is_balanced,
          status, is_opening, is_closing, origin_document, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16)`,
      [
        entry.id,
        entry.companyId,
        entry.accountingPeriod,
        entry.entryNumber,
        entry.entryDate,
        entry.glosa,
        entry.currency,
        entry.exchangeRate ?? null,
        entry.totalDebit,
        entry.totalCredit,
        entry.isBalanced,
        entry.status ?? "POSTED",
        Boolean(entry.isOpening),
        Boolean(entry.isClosing),
        entry.originDocument ? JSON.stringify(entry.originDocument) : null,
        entry.createdAt,
      ],
    );

    for (const line of entry.lines) {
      await client.query(
        `INSERT INTO private.accounting_journal_entry_lines
           (entry_id, line_number, account_code, account_name, debit, credit, glosa, cost_center, reference_doc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.id,
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
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export function createPostgresPool(connectionString: string): Pool {
  if (!connectionString.trim()) throw new Error("DATABASE_URL es obligatoria para PostgreSQL.");
  const databaseHost = new URL(connectionString).hostname;
  const isLocalDatabase = ["localhost", "127.0.0.1", "::1"].includes(databaseHost);
  return new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Local Supabase uses a loopback Postgres endpoint; hosted PostgreSQL keeps
    // certificate verification enabled.
    ssl: isLocalDatabase ? false : { rejectUnauthorized: true },
  });
}
