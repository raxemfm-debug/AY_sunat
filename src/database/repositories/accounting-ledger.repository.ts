import type { AccountingPeriodRecord, AccountingPeriodStatus, JournalEntry } from '../../modules/accounting/types.js';

export interface AccountingLedgerSnapshot {
  entries: JournalEntry[];
  periods: AccountingPeriodRecord[];
}

/** Otro proceso cambió el período (nuevo asiento, cierre o reapertura) entre la lectura y la escritura. */
export class ConcurrentPeriodChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentPeriodChangeError';
  }
}

export interface IAccountingLedgerRepository {
  /** Asientos (con líneas) y períodos de la empresa; opcionalmente solo de un ejercicio "YYYY". */
  loadLedger(companyId: string, fiscalYear?: string): Promise<AccountingLedgerSnapshot>;
  findEntry(companyId: string, entryId: string): Promise<JournalEntry | null>;
  /**
   * Guarda un asiento validado. El número de asiento se asigna de forma atómica por período;
   * rechaza el asiento si el período o el ejercicio están cerrados (salvo asientos de cierre).
   */
  appendEntry(entry: JournalEntry): Promise<JournalEntry>;
  /** Cambia un asiento PENDING/DRAFT a POSTED verificando que su período siga abierto. */
  markEntryPosted(companyId: string, entryId: string): Promise<JournalEntry>;
  /**
   * Guarda el estado de un período (cierre o reapertura). `expectedStatus` es el estado
   * que el llamador leyó; si cambió entretanto, lanza ConcurrentPeriodChangeError.
   */
  savePeriod(record: AccountingPeriodRecord, expectedStatus: AccountingPeriodStatus): Promise<AccountingPeriodRecord>;
  isFiscalYearClosed(companyId: string, fiscalYear: string): Promise<boolean>;
}

const DEFAULT_ENTRY_ID = /^entry_.+_\d+$/;

/** El id por defecto incluye el número de asiento; se rehace con el número definitivo. */
export function resolveEntryId(entry: JournalEntry, entryNumber: number): string {
  return DEFAULT_ENTRY_ID.test(entry.id)
    ? `entry_${entry.companyId}_${entry.accountingPeriod}_${entryNumber}`
    : entry.id;
}

export function closedPeriodMessage(companyId: string, period: string): string {
  return `Período contable bloqueado: El período ${period} se encuentra cerrado para la empresa ${companyId}. No se pueden registrar nuevos asientos contables.`;
}

export function closedYearMessage(companyId: string, fiscalYear: string): string {
  return `Ejercicio contable bloqueado: ${fiscalYear} se encuentra cerrado para la empresa ${companyId}`;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Implementación en memoria con las mismas reglas que la de PostgreSQL. */
export class MemoryAccountingLedgerRepository implements IAccountingLedgerRepository {
  private readonly entries: JournalEntry[] = [];
  private readonly periods = new Map<string, AccountingPeriodRecord>();
  private readonly closedYears = new Set<string>();

  /** Solo para pruebas y desarrollo: marca un ejercicio como cerrado. */
  markFiscalYearClosed(companyId: string, fiscalYear: string): void {
    this.closedYears.add(`${companyId}_${fiscalYear}`);
  }

  async loadLedger(companyId: string, fiscalYear?: string): Promise<AccountingLedgerSnapshot> {
    const inScope = (period: string) => !fiscalYear || period.startsWith(`${fiscalYear}-`);
    return {
      entries: this.entries
        .filter((e) => e.companyId === companyId && inScope(e.accountingPeriod))
        .sort((a, b) => a.accountingPeriod.localeCompare(b.accountingPeriod) || a.entryNumber - b.entryNumber)
        .map(clone),
      periods: Array.from(this.periods.values())
        .filter((p) => p.companyId === companyId && inScope(p.period))
        .sort((a, b) => a.period.localeCompare(b.period))
        .map(clone),
    };
  }

  async findEntry(companyId: string, entryId: string): Promise<JournalEntry | null> {
    const entry = this.entries.find((e) => e.companyId === companyId && e.id === entryId);
    return entry ? clone(entry) : null;
  }

  async appendEntry(entry: JournalEntry): Promise<JournalEntry> {
    const fiscalYear = entry.accountingPeriod.slice(0, 4);
    if (!entry.isClosing && (await this.isFiscalYearClosed(entry.companyId, fiscalYear))) {
      throw new Error(closedYearMessage(entry.companyId, fiscalYear));
    }
    if (!entry.isClosing && this.periods.get(`${entry.companyId}_${entry.accountingPeriod}`)?.status === 'CLOSED') {
      throw new Error(closedPeriodMessage(entry.companyId, entry.accountingPeriod));
    }
    const entryNumber = 1 + Math.max(
      0,
      ...this.entries
        .filter((e) => e.companyId === entry.companyId && e.accountingPeriod === entry.accountingPeriod)
        .map((e) => e.entryNumber),
    );
    const saved: JournalEntry = { ...clone(entry), id: resolveEntryId(entry, entryNumber), entryNumber };
    if (this.entries.some((e) => e.id === saved.id)) {
      throw new Error(`Ya existe un asiento contable con id ${saved.id}`);
    }
    this.entries.push(saved);
    return clone(saved);
  }

  async markEntryPosted(companyId: string, entryId: string): Promise<JournalEntry> {
    const entry = this.entries.find((e) => e.companyId === companyId && e.id === entryId);
    if (!entry) throw new Error(`Asiento contable con id ${entryId} no encontrado`);
    if (this.periods.get(`${companyId}_${entry.accountingPeriod}`)?.status === 'CLOSED') {
      throw new Error(`No se puede contabilizar el asiento: el período ${entry.accountingPeriod} ya se encuentra cerrado`);
    }
    entry.status = 'POSTED';
    return clone(entry);
  }

  async savePeriod(record: AccountingPeriodRecord, expectedStatus: AccountingPeriodStatus): Promise<AccountingPeriodRecord> {
    const key = `${record.companyId}_${record.period}`;
    const current = this.periods.get(key)?.status ?? 'OPEN';
    if (current !== expectedStatus) {
      throw new ConcurrentPeriodChangeError(
        `El período ${record.period} cambió de estado (${current}) mientras se procesaba la operación. Vuelve a intentarlo.`,
      );
    }
    if (record.status === 'CLOSED') {
      const count = this.entries.filter((e) => e.companyId === record.companyId && e.accountingPeriod === record.period).length;
      if (count !== record.totalEntries) {
        throw new ConcurrentPeriodChangeError(
          `Se registraron asientos en ${record.period} mientras se validaba el cierre. Vuelve a ejecutar el cierre.`,
        );
      }
    }
    this.periods.set(key, clone(record));
    return clone(record);
  }

  async isFiscalYearClosed(companyId: string, fiscalYear: string): Promise<boolean> {
    return this.closedYears.has(`${companyId}_${fiscalYear}`);
  }
}
