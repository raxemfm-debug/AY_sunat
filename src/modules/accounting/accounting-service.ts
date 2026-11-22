import { Decimal } from "decimal.js";
import {
  AccountingPeriodRecord,
  CloseAccountingPeriodInput,
  CreateJournalEntryInput,
  GeneralLedger,
  GeneralLedgerAccount,
  GeneralLedgerMovement,
  JournalEntry,
  JournalEntryLine,
  PeriodValidationResult,
  ReopenAccountingPeriodInput,
  TrialBalance,
  TrialBalanceRow,
} from "./types.js";
import { resolveAccountName } from "./pcge-catalog.js";
import { validateJournalEntryBalance } from "./entry-builder.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

const round2 = (val: Decimal | number | string): string => {
  return new Decimal(val).toFixed(2);
};

export class AccountingService {
  private entries: JournalEntry[] = [];
  private entrySequenceByPeriod: Map<string, number> = new Map();
  private periods: Map<string, AccountingPeriodRecord> = new Map();

  constructor(
    initialEntries?: JournalEntry[],
    initialPeriods?: AccountingPeriodRecord[]
  ) {
    if (initialPeriods && initialPeriods.length > 0) {
      for (const p of initialPeriods) {
        this.periods.set(`${p.companyId}_${p.period}`, { ...p });
      }
    }
    if (initialEntries && initialEntries.length > 0) {
      // Los asientos iniciales representan registros persistidos existentes; se conservan
      // incluso si están dañados para que la validación de cierre pueda detectarlos.
      for (const e of initialEntries) {
        this.entries.push({ ...e, lines: e.lines.map((line) => ({ ...line })) });
        const key = `${e.companyId}_${e.accountingPeriod}`;
        this.entrySequenceByPeriod.set(
          key,
          Math.max(this.entrySequenceByPeriod.get(key) || 0, e.entryNumber || 0)
        );
      }
    }
  }

  /**
   * Consulta si un período contable está cerrado y bloqueado para modificaciones
   */
  public isPeriodClosed(companyId: string, period: string): boolean {
    const key = `${companyId}_${period}`;
    const rec = this.periods.get(key);
    return rec?.status === "CLOSED";
  }

  /**
   * Obtiene el registro de estado de un período contable
   */
  public getPeriodRecord(companyId: string, period: string): AccountingPeriodRecord {
    const key = `${companyId}_${period}`;
    const existing = this.periods.get(key);
    if (existing) {
      return { ...existing };
    }

    const entries = this.getJournalEntries(companyId, period);
    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);
    for (const e of entries) {
      sumDebit = sumDebit.plus(new Decimal(e.totalDebit));
      sumCredit = sumCredit.plus(new Decimal(e.totalCredit));
    }

    return {
      companyId,
      period,
      status: "OPEN",
      totalEntries: entries.length,
      totalDebit: round2(sumDebit),
      totalCredit: round2(sumCredit),
      isBalanced: sumDebit.equals(sumCredit),
    };
  }

  /**
   * Lista todos los períodos registrados o con movimientos para una empresa
   */
  public listPeriods(companyId: string): AccountingPeriodRecord[] {
    const result: AccountingPeriodRecord[] = [];
    const knownPeriods = new Set<string>();

    for (const p of this.periods.values()) {
      if (p.companyId === companyId) {
        result.push({ ...p });
        knownPeriods.add(p.period);
      }
    }

    for (const e of this.entries) {
      if (e.companyId === companyId && !knownPeriods.has(e.accountingPeriod)) {
        result.push(this.getPeriodRecord(companyId, e.accountingPeriod));
        knownPeriods.add(e.accountingPeriod);
      }
    }

    return result.sort((a, b) => a.period.localeCompare(b.period));
  }

  /**
   * Registra un nuevo asiento contable en el Libro Diario validando su balance y bloqueo de período
   */
  public registerEntry(input: CreateJournalEntryInput | JournalEntry): JournalEntry {
    if (this.isPeriodClosed(input.companyId, input.accountingPeriod)) {
      throw new Error(
        `Período contable bloqueado: El período ${input.accountingPeriod} se encuentra cerrado para la empresa ${input.companyId}. No se pueden registrar nuevos asientos contables.`
      );
    }

    if (!input.lines || input.lines.length === 0) {
      throw new Error("No se puede registrar un asiento contable sin líneas");
    }

    // Normalizar líneas asignando número de línea y resolviendo nombre de cuenta
    const processedLines: JournalEntryLine[] = input.lines.map((l, index) => {
      const debitStr = round2(l.debit ?? 0);
      const creditStr = round2(l.credit ?? 0);
      return {
        lineNumber: index + 1,
        accountCode: l.accountCode.trim(),
        accountName: resolveAccountName(l.accountCode, l.accountName),
        debit: debitStr,
        credit: creditStr,
        glosa: l.glosa,
        costCenter: l.costCenter,
        referenceDoc: l.referenceDoc,
      };
    });

    // Validar partida doble innegociable
    const balance = validateJournalEntryBalance(processedLines);
    if (!balance.isBalanced) {
      throw new Error(
        `Asiento contable desbalanceado: Total Debe (${balance.totalDebit}) no es igual a Total Haber (${balance.totalCredit}). Diferencia: ${balance.difference}`
      );
    }

    const periodKey = `${input.companyId}_${input.accountingPeriod}`;
    const nextSeq = (this.entrySequenceByPeriod.get(periodKey) || 0) + 1;
    this.entrySequenceByPeriod.set(periodKey, nextSeq);

    const entryId =
      "id" in input && input.id ? input.id : `entry_${input.companyId}_${input.accountingPeriod}_${nextSeq}`;

    const journalEntry: JournalEntry = {
      id: entryId,
      companyId: input.companyId,
      accountingPeriod: input.accountingPeriod,
      entryNumber: "entryNumber" in input && input.entryNumber ? input.entryNumber : nextSeq,
      entryDate: input.entryDate,
      glosa: input.glosa,
      currency: input.currency || "PEN",
      exchangeRate: input.exchangeRate,
      originDocument: input.originDocument,
      lines: processedLines,
      totalDebit: balance.totalDebit,
      totalCredit: balance.totalCredit,
      isBalanced: true,
      createdAt: "createdAt" in input && input.createdAt ? input.createdAt : new Date().toISOString(),
    };

    this.entries.push(journalEntry);
    return journalEntry;
  }

  /**
   * Obtiene todos los asientos del Libro Diario para una empresa y periodo opcional
   */
  public getJournalEntries(companyId: string, period?: string): JournalEntry[] {
    return this.entries.filter((e) => {
      if (e.companyId !== companyId) return false;
      if (period && e.accountingPeriod !== period) return false;
      return true;
    });
  }

  /**
   * Busca un asiento por su documento de origen
   */
  public getEntryByOriginDocument(
    companyId: string,
    documentId: string
  ): JournalEntry | undefined {
    return this.entries.find(
      (e) => e.companyId === companyId && e.originDocument?.documentId === documentId
    );
  }

  /**
   * Genera el Libro Mayor (General Ledger) agrupando movimientos por cuenta contable
   */
  public generateGeneralLedger(companyId: string, period: string): GeneralLedger {
    const periodEntries = this.getJournalEntries(companyId, period).sort(
      (a, b) => a.entryNumber - b.entryNumber
    );

    const accountMap = new Map<
      string,
      {
        accountCode: string;
        accountName: string;
        movements: GeneralLedgerMovement[];
        totalDebit: Decimal;
        totalCredit: Decimal;
      }
    >();

    let totalPeriodDebit = new Decimal(0);
    let totalPeriodCredit = new Decimal(0);

    for (const entry of periodEntries) {
      for (const line of entry.lines) {
        let accData = accountMap.get(line.accountCode);
        if (!accData) {
          accData = {
            accountCode: line.accountCode,
            accountName: line.accountName,
            movements: [],
            totalDebit: new Decimal(0),
            totalCredit: new Decimal(0),
          };
          accountMap.set(line.accountCode, accData);
        }

        const debitDec = new Decimal(line.debit);
        const creditDec = new Decimal(line.credit);

        accData.totalDebit = accData.totalDebit.plus(debitDec);
        accData.totalCredit = accData.totalCredit.plus(creditDec);

        totalPeriodDebit = totalPeriodDebit.plus(debitDec);
        totalPeriodCredit = totalPeriodCredit.plus(creditDec);

        const currentNetBalance = accData.totalDebit.minus(accData.totalCredit);

        accData.movements.push({
          entryNumber: entry.entryNumber,
          entryDate: entry.entryDate,
          glosa: line.glosa || entry.glosa,
          debit: line.debit,
          credit: line.credit,
          runningBalance: round2(currentNetBalance),
        });
      }
    }

    // Convertir a lista ordenada por código de cuenta
    const accounts: GeneralLedgerAccount[] = Array.from(accountMap.values())
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
      .map((acc) => {
        const net = acc.totalDebit.minus(acc.totalCredit);
        const isDebtor = net.greaterThan(0);
        const isCreditor = net.lessThan(0);

        return {
          accountCode: acc.accountCode,
          accountName: acc.accountName,
          totalDebit: round2(acc.totalDebit),
          totalCredit: round2(acc.totalCredit),
          debtorBalance: isDebtor ? round2(net) : "0.00",
          creditorBalance: isCreditor ? round2(net.abs()) : "0.00",
          movements: acc.movements,
        };
      });

    return {
      companyId,
      accountingPeriod: period,
      generatedAt: new Date().toISOString(),
      totalDebit: round2(totalPeriodDebit),
      totalCredit: round2(totalPeriodCredit),
      accounts,
    };
  }

  /**
   * Genera el Balance de Comprobación (Sumas y Saldos)
   */
  public generateTrialBalance(companyId: string, period: string): TrialBalance {
    const ledger = this.generateGeneralLedger(companyId, period);

    let totalDebitSum = new Decimal(0);
    let totalCreditSum = new Decimal(0);
    let totalDebtorBalance = new Decimal(0);
    let totalCreditorBalance = new Decimal(0);

    const rows: TrialBalanceRow[] = ledger.accounts.map((acc) => {
      const dSum = new Decimal(acc.totalDebit);
      const cSum = new Decimal(acc.totalCredit);
      const dBal = new Decimal(acc.debtorBalance);
      const cBal = new Decimal(acc.creditorBalance);

      totalDebitSum = totalDebitSum.plus(dSum);
      totalCreditSum = totalCreditSum.plus(cSum);
      totalDebtorBalance = totalDebtorBalance.plus(dBal);
      totalCreditorBalance = totalCreditorBalance.plus(cBal);

      return {
        accountCode: acc.accountCode,
        accountName: acc.accountName,
        debitSum: acc.totalDebit,
        creditSum: acc.totalCredit,
        debtorBalance: acc.debtorBalance,
        creditorBalance: acc.creditorBalance,
      };
    });

    const sumDiff = totalDebitSum.minus(totalCreditSum).abs();
    const balanceDiff = totalDebtorBalance.minus(totalCreditorBalance).abs();
    const isBalanced = sumDiff.lessThan(0.005) && balanceDiff.lessThan(0.005);

    return {
      companyId,
      accountingPeriod: period,
      generatedAt: new Date().toISOString(),
      rows,
      totalDebitSum: round2(totalDebitSum),
      totalCreditSum: round2(totalCreditSum),
      totalDebtorBalance: round2(totalDebtorBalance),
      totalCreditorBalance: round2(totalCreditorBalance),
      isBalanced,
    };
  }

  /**
   * Valida exhaustivamente si un período contable cumple todas las condiciones para el cierre mensual
   */
  public validatePeriodForClosing(
    companyId: string,
    period: string,
    allowEmptyPeriod: boolean = false
  ): PeriodValidationResult {
    const entries = this.getJournalEntries(companyId, period);
    const errors: string[] = [];
    const unbalancedEntries: PeriodValidationResult["unbalancedEntries"] = [];

    if (!allowEmptyPeriod && entries.length === 0) {
      errors.push(`El período ${period} no contiene asientos contables registrados para cerrar`);
    }

    let sumDebit = new Decimal(0);
    let sumCredit = new Decimal(0);

    for (const entry of entries) {
      const d = new Decimal(entry.totalDebit || 0);
      const c = new Decimal(entry.totalCredit || 0);
      sumDebit = sumDebit.plus(d);
      sumCredit = sumCredit.plus(c);

      const diff = d.minus(c).abs();
      if (!entry.isBalanced || diff.greaterThanOrEqualTo(0.005)) {
        unbalancedEntries.push({
          entryId: entry.id,
          entryNumber: entry.entryNumber,
          difference: round2(diff),
          totalDebit: entry.totalDebit,
          totalCredit: entry.totalCredit,
        });
        errors.push(
          `Asiento #${entry.entryNumber} (${entry.id}) desbalanceado: Total Debe ${entry.totalDebit} != Total Haber ${entry.totalCredit} (Dif: ${round2(diff)})`
        );
      }
    }

    // Validar cuadre en Balance de Comprobación
    const trialBalance = this.generateTrialBalance(companyId, period);
    if (!trialBalance.isBalanced) {
      errors.push(
        `El Balance de Comprobación del período ${period} no cuadra: Total Debe (${trialBalance.totalDebitSum}) != Total Haber (${trialBalance.totalCreditSum}) o Saldos Deudor (${trialBalance.totalDebtorBalance}) != Acreedor (${trialBalance.totalCreditorBalance})`
      );
    }

    const isDoubleEntryBalanced =
      unbalancedEntries.length === 0 &&
      sumDebit.equals(sumCredit) &&
      trialBalance.isBalanced;

    return {
      isValid: errors.length === 0 && isDoubleEntryBalanced,
      period,
      companyId,
      totalEntries: entries.length,
      totalDebit: round2(sumDebit),
      totalCredit: round2(sumCredit),
      isDoubleEntryBalanced,
      unbalancedEntries,
      errors,
    };
  }

  /**
   * Ejecuta el cierre contable mensual: valida balance, genera snapshot y bloquea el período
   */
  public closePeriod(input: CloseAccountingPeriodInput): AccountingPeriodRecord {
    const { companyId, period, closedBy = "USUARIO_CONTABLE", notes, allowEmptyPeriod = false } = input;

    if (this.isPeriodClosed(companyId, period)) {
      throw new Error(
        `El período contable ${period} ya se encuentra cerrado para la empresa ${companyId}`
      );
    }

    const validation = this.validatePeriodForClosing(companyId, period, allowEmptyPeriod);
    if (!validation.isValid) {
      throw new Error(
        `No se puede cerrar el período contable ${period}: ${validation.errors.join("; ")}`
      );
    }

    const trialBalanceSnapshot = this.generateTrialBalance(companyId, period);
    const key = `${companyId}_${period}`;

    const closedRecord: AccountingPeriodRecord = {
      companyId,
      period,
      status: "CLOSED",
      totalEntries: validation.totalEntries,
      totalDebit: validation.totalDebit,
      totalCredit: validation.totalCredit,
      isBalanced: true,
      closedAt: new Date().toISOString(),
      closedBy,
      closingNotes: notes,
      trialBalanceSnapshot,
    };

    this.periods.set(key, closedRecord);
    return closedRecord;
  }

  /**
   * Reabre un período contable cerrado con auditoría y justificación obligatoria
   */
  public reopenPeriod(input: ReopenAccountingPeriodInput): AccountingPeriodRecord {
    const { companyId, period, reopenedBy, reason } = input;

    if (!reopenedBy || !reopenedBy.trim()) {
      throw new Error("Se requiere identificar al usuario responsable que autoriza la reapertura del período");
    }
    if (!reason || reason.trim().length < 5) {
      throw new Error(
        "Se requiere un motivo o justificación válida (mínimo 5 caracteres) para reabrir el período contable"
      );
    }

    const key = `${companyId}_${period}`;
    const existing = this.periods.get(key);

    if (!existing || existing.status !== "CLOSED") {
      throw new Error(`El período contable ${period} no se encuentra cerrado para la empresa ${companyId}`);
    }

    const reopenedRecord: AccountingPeriodRecord = {
      ...existing,
      status: "OPEN",
      reopenedAt: new Date().toISOString(),
      reopenedBy: reopenedBy.trim(),
      reopenReason: reason.trim(),
    };

    this.periods.set(key, reopenedRecord);
    return reopenedRecord;
  }
}
