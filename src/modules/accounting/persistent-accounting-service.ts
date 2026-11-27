import type { IAccountingLedgerRepository } from '../../database/repositories/accounting-ledger.repository.js';
import { closedYearMessage } from '../../database/repositories/accounting-ledger.repository.js';
import { AccountingService } from './accounting-service.js';
import type {
  AccountingPeriodRecord,
  CloseAccountingPeriodInput,
  CreateJournalEntryInput,
  GeneralLedger,
  JournalEntry,
  ReopenAccountingPeriodInput,
  TrialBalance,
} from './types.js';

/**
 * Contabilidad con persistencia. Cada operación carga el ejercicio desde el repositorio,
 * aplica las reglas del AccountingService (partida doble, bloqueos, validaciones de cierre)
 * y guarda el resultado. El repositorio vuelve a verificar los bloqueos dentro de la transacción.
 */
export class PersistentAccountingService {
  constructor(private readonly repository: IAccountingLedgerRepository) {}

  /** AccountingService hidratado con los asientos y períodos guardados del ejercicio. */
  async loadService(companyId: string, fiscalYear?: string): Promise<AccountingService> {
    const { entries, periods } = await this.repository.loadLedger(companyId, fiscalYear);
    return new AccountingService(entries, periods);
  }

  async registerEntry(input: CreateJournalEntryInput): Promise<JournalEntry> {
    const service = await this.loadForPeriod(input.companyId, input.accountingPeriod);
    return this.repository.appendEntry(service.registerEntry(input));
  }

  async registerDraftEntry(input: CreateJournalEntryInput): Promise<JournalEntry> {
    const service = await this.loadForPeriod(input.companyId, input.accountingPeriod);
    return this.repository.appendEntry(service.registerDraftEntry(input));
  }

  async postEntry(companyId: string, entryId: string): Promise<JournalEntry> {
    const entry = await this.repository.findEntry(companyId, entryId);
    if (!entry) throw new Error(`Asiento contable con id ${entryId} no encontrado`);
    const service = await this.loadService(companyId, entry.accountingPeriod.slice(0, 4));
    service.postEntry(entryId);
    return this.repository.markEntryPosted(companyId, entryId);
  }

  async closePeriod(input: CloseAccountingPeriodInput): Promise<AccountingPeriodRecord> {
    const service = await this.loadService(input.companyId, input.period.slice(0, 4));
    const record = service.closePeriod(input);
    return this.repository.savePeriod(record, 'OPEN');
  }

  async reopenPeriod(input: ReopenAccountingPeriodInput): Promise<AccountingPeriodRecord> {
    const service = await this.loadService(input.companyId, input.period.slice(0, 4));
    const record = service.reopenPeriod(input);
    return this.repository.savePeriod(record, 'CLOSED');
  }

  async getJournalEntries(companyId: string, period?: string): Promise<JournalEntry[]> {
    const service = await this.loadService(companyId, period?.slice(0, 4));
    return service.getJournalEntries(companyId, period);
  }

  async getPeriodRecord(companyId: string, period: string): Promise<AccountingPeriodRecord> {
    return (await this.loadService(companyId, period.slice(0, 4))).getPeriodRecord(companyId, period);
  }

  async generateTrialBalance(companyId: string, period: string): Promise<TrialBalance> {
    return (await this.loadService(companyId, period.slice(0, 4))).generateTrialBalance(companyId, period);
  }

  async generateGeneralLedger(companyId: string, period: string): Promise<GeneralLedger> {
    return (await this.loadService(companyId, period.slice(0, 4))).generateGeneralLedger(companyId, period);
  }

  private async loadForPeriod(companyId: string, period: string): Promise<AccountingService> {
    const fiscalYear = period.slice(0, 4);
    if (await this.repository.isFiscalYearClosed(companyId, fiscalYear)) {
      throw new Error(closedYearMessage(companyId, fiscalYear));
    }
    return this.loadService(companyId, fiscalYear);
  }
}
