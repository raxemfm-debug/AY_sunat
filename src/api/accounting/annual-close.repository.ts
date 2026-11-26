import type {
  AccountingPeriodRecord,
  AnnualCloseRecord,
  JournalEntry,
} from "../../modules/accounting/types.js";

export interface AnnualCloseSnapshot {
  /** Monotonic version used to reject previews made against stale ledger data. */
  revision: number;
  fiscalYearStatus: "OPEN" | "CLOSED";
  entries: JournalEntry[];
  periods: AccountingPeriodRecord[];
  closeRecord?: AnnualCloseRecord;
}

export interface CommitAnnualCloseInput {
  companyId: string;
  fiscalYear: string;
  expectedRevision: number;
  record: AnnualCloseRecord;
}

/**
 * Persistence port for annual closing.
 * Implementations must make commitAnnualClose atomic, enforce expectedRevision,
 * and persist the closing entries and close record in one database transaction.
 */
export interface AnnualCloseRepository {
  loadSnapshot(companyId: string, fiscalYear: string): Promise<AnnualCloseSnapshot>;
  commitAnnualClose(input: CommitAnnualCloseInput): Promise<void>;
}

export class ConcurrentAnnualCloseError extends Error {
  constructor(message = "El libro cambió desde la vista previa; vuelve a generarla antes de confirmar.") {
    super(message);
    this.name = "ConcurrentAnnualCloseError";
  }
}
