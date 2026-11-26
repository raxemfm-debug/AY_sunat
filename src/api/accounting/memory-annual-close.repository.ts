import type {
  AccountingPeriodRecord,
  AnnualCloseRecord,
  JournalEntry,
} from "../../modules/accounting/types.js";
import {
  AnnualCloseRepository,
  AnnualCloseSnapshot,
  CommitAnnualCloseInput,
  ConcurrentAnnualCloseError,
} from "./annual-close.repository.js";

function cloneEntry(entry: JournalEntry): JournalEntry {
  return { ...entry, lines: entry.lines.map((line) => ({ ...line })) };
}

function cloneRecord(record: AnnualCloseRecord): AnnualCloseRecord {
  return {
    ...record,
    closingEntryIds: [...record.closingEntryIds],
    closingEntries: record.closingEntries.map(cloneEntry),
    preClosingTrialBalance: {
      ...record.preClosingTrialBalance,
      rows: record.preClosingTrialBalance.rows.map((row) => ({ ...row })),
    },
    postClosingTrialBalance: {
      ...record.postClosingTrialBalance,
      rows: record.postClosingTrialBalance.rows.map((row) => ({ ...row })),
    },
    nextYearOpeningEntry: record.nextYearOpeningEntry
      ? cloneEntry(record.nextYearOpeningEntry)
      : undefined,
  };
}

/** Development adapter only. It intentionally loses all data when the process exits. */
export class MemoryAnnualCloseRepository implements AnnualCloseRepository {
  private readonly snapshots = new Map<string, AnnualCloseSnapshot>();

  private key(companyId: string, fiscalYear: string): string {
    return `${companyId}:${fiscalYear}`;
  }

  async loadSnapshot(companyId: string, fiscalYear: string): Promise<AnnualCloseSnapshot> {
    const snapshot = this.snapshots.get(this.key(companyId, fiscalYear));
    if (!snapshot) return { revision: 0, fiscalYearStatus: "OPEN", entries: [], periods: [] };
    return {
      revision: snapshot.revision,
      fiscalYearStatus: snapshot.closeRecord?.status === "CLOSED" ? "CLOSED" : "OPEN",
      entries: snapshot.entries.map(cloneEntry),
      periods: snapshot.periods.map((period) => ({ ...period })),
      closeRecord: snapshot.closeRecord ? cloneRecord(snapshot.closeRecord) : undefined,
    };
  }

  /** Seeds an in-memory ledger for local wiring and manual development. */
  seed(input: {
    companyId: string;
    fiscalYear: string;
    entries: JournalEntry[];
    periods?: AccountingPeriodRecord[];
  }): void {
    this.snapshots.set(this.key(input.companyId, input.fiscalYear), {
      revision: 1,
      fiscalYearStatus: "OPEN",
      entries: input.entries.map(cloneEntry),
      periods: (input.periods ?? []).map((period) => ({ ...period })),
    });
  }

  async commitAnnualClose(input: CommitAnnualCloseInput): Promise<void> {
    const key = this.key(input.companyId, input.fiscalYear);
    const current = this.snapshots.get(key) ?? { revision: 0, fiscalYearStatus: "OPEN" as const, entries: [], periods: [] };
    if (current.revision !== input.expectedRevision) throw new ConcurrentAnnualCloseError();
    if (current.closeRecord?.status === "CLOSED") {
      throw new ConcurrentAnnualCloseError("El ejercicio ya fue cerrado; actualiza la pantalla.");
    }

    const insertedEntries = [
      ...input.record.closingEntries,
      ...(input.record.nextYearOpeningEntry ? [input.record.nextYearOpeningEntry] : []),
    ];
    const existingIds = new Set(current.entries.map((entry) => entry.id));
    if (insertedEntries.some((entry) => existingIds.has(entry.id))) {
      throw new ConcurrentAnnualCloseError("Uno o más asientos del cierre ya existen; actualiza la pantalla.");
    }

    const opening = input.record.nextYearOpeningEntry;
    const nextYearKey = this.key(input.companyId, String(Number(input.fiscalYear) + 1));
    const nextYear = opening
      ? this.snapshots.get(nextYearKey) ?? { revision: 0, fiscalYearStatus: "OPEN" as const, entries: [], periods: [] }
      : undefined;
    if (opening && nextYear?.entries.some((entry) => entry.id === opening.id)) {
      throw new ConcurrentAnnualCloseError("El asiento de apertura ya existe en el siguiente ejercicio.");
    }

    // No await between validation and replacement: this adapter's commit is atomic
    // within the single Node process. A database adapter must use a DB transaction.
    this.snapshots.set(key, {
      revision: current.revision + 1,
      fiscalYearStatus: "CLOSED",
      entries: [...current.entries.map(cloneEntry), ...insertedEntries.map(cloneEntry)],
      periods: current.periods.map((period) => ({ ...period })),
      closeRecord: cloneRecord(input.record),
    });
    if (opening && nextYear) {
      this.snapshots.set(nextYearKey, {
        revision: nextYear.revision + 1,
        fiscalYearStatus: nextYear.fiscalYearStatus,
        entries: [...nextYear.entries.map(cloneEntry), cloneEntry(opening)],
        periods: nextYear.periods.map((period) => ({ ...period })),
        closeRecord: nextYear.closeRecord ? cloneRecord(nextYear.closeRecord) : undefined,
      });
    }
  }
}
