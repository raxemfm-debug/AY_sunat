import { Decimal } from "decimal.js";
import {
  AccountingPeriodRecord,
  AnnualCloseRecord,
  AnnualClosingEntriesResult,
  AnnualClosingValidationOptions,
  AnnualClosingValidationResult,
  AccountingResultType,
  ExecuteAnnualCloseInput,
  PreviewAnnualCloseInput,
  AnnualClosingPreview,
  AnnualClosingPreviewEntry,
  AnnualClosingPreviewLine,
  AnnualClosingEntryType,
  ReopenFiscalYearInput,
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
  private annualClosures: Map<string, AnnualCloseRecord> = new Map();

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
  /**
   * Registra un asiento contable en borrador / pendiente de contabilizar
   */
  public registerDraftEntry(input: CreateJournalEntryInput): JournalEntry {
    return this.registerEntryInternal({ ...input, status: input.status || "PENDING" }, false);
  }

  /**
   * Contabiliza formalmente un asiento que estaba en estado PENDING o DRAFT
   */
  public postEntry(entryId: string): JournalEntry {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) {
      throw new Error(`Asiento contable con id ${entryId} no encontrado`);
    }
    const year = entry.accountingPeriod.slice(0, 4);
    if (this.isFiscalYearClosed(entry.companyId, year)) {
      throw new Error(`No se puede contabilizar el asiento: el ejercicio fiscal ${year} ya se encuentra cerrado`);
    }
    if (this.isPeriodClosed(entry.companyId, entry.accountingPeriod)) {
      throw new Error(`No se puede contabilizar el asiento: el período ${entry.accountingPeriod} ya se encuentra cerrado`);
    }
    entry.status = "POSTED";
    return { ...entry };
  }

  /**
   * Obtiene todos los asientos pendientes de contabilizar (DRAFT o PENDING)
   */
  public getPendingEntries(companyId: string, fiscalYearOrPeriod?: string): JournalEntry[] {
    return this.entries.filter((e) => {
      if (e.companyId !== companyId) return false;
      if (e.status === "POSTED") return false;
      if (fiscalYearOrPeriod) {
        if (fiscalYearOrPeriod.length === 4) {
          return e.accountingPeriod.startsWith(`${fiscalYearOrPeriod}-`);
        }
        return e.accountingPeriod === fiscalYearOrPeriod;
      }
      return true;
    });
  }

  public registerEntry(input: CreateJournalEntryInput | JournalEntry): JournalEntry {
    return this.registerEntryInternal(input, false);
  }

  /** Registra un asiento de cierre anual autorizado, aun si diciembre fue cerrado mensualmente. */
  private registerAnnualClosingEntry(input: CreateJournalEntryInput): JournalEntry {
    return this.registerEntryInternal(input, true);
  }

  private registerEntryInternal(
    input: CreateJournalEntryInput | JournalEntry,
    isAuthorizedAnnualClosing: boolean
  ): JournalEntry {
    const fiscalYear = input.accountingPeriod.slice(0, 4);
    if (!isAuthorizedAnnualClosing && this.isFiscalYearClosed(input.companyId, fiscalYear)) {
      throw new Error(`Ejercicio contable bloqueado: ${fiscalYear} se encuentra cerrado para la empresa ${input.companyId}`);
    }
    if (!isAuthorizedAnnualClosing && this.isPeriodClosed(input.companyId, input.accountingPeriod)) {
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
      status: ("status" in input && input.status) ? input.status : "POSTED",
      isClosing: isAuthorizedAnnualClosing || ("isClosing" in input ? Boolean(input.isClosing) : false),
      isOpening: "isOpening" in input ? Boolean(input.isOpening) : false,
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

  /** Indica si el ejercicio fiscal se encuentra cerrado. */
  public isFiscalYearClosed(companyId: string, fiscalYear: string | number): boolean {
    return this.annualClosures.get(`${companyId}_${String(fiscalYear)}`)?.status === "CLOSED";
  }

  /** Devuelve una copia del registro del cierre anual. */
  public getFiscalYearCloseRecord(companyId: string, fiscalYear: string | number): AnnualCloseRecord | undefined {
    const record = this.annualClosures.get(`${companyId}_${String(fiscalYear)}`);
    return record ? { ...record, closingEntries: record.closingEntries.map((entry) => ({ ...entry, lines: entry.lines.map((line) => ({ ...line })) })) } : undefined;
  }

  /**
   * Construye un balance de comprobación anual a partir de los asientos registrados del ejercicio.
   * La igualdad de sumas debe, por definición, conservarse para asientos válidos.
   */
  public generateAnnualTrialBalance(companyId: string, fiscalYear: string | number): TrialBalance {
    const year = String(fiscalYear);
    const entries = this.getJournalEntries(companyId).filter((entry) => entry.accountingPeriod.startsWith(`${year}-`));
    const accounts = new Map<string, { name: string; debit: Decimal; credit: Decimal }>();
    for (const entry of entries) {
      for (const line of entry.lines) {
        const item = accounts.get(line.accountCode) ?? { name: line.accountName, debit: new Decimal(0), credit: new Decimal(0) };
        item.debit = item.debit.plus(line.debit);
        item.credit = item.credit.plus(line.credit);
        accounts.set(line.accountCode, item);
      }
    }
    let totalDebitSum = new Decimal(0);
    let totalCreditSum = new Decimal(0);
    let totalDebtorBalance = new Decimal(0);
    let totalCreditorBalance = new Decimal(0);
    const rows = Array.from(accounts.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, item]) => {
      const net = item.debit.minus(item.credit);
      totalDebitSum = totalDebitSum.plus(item.debit);
      totalCreditSum = totalCreditSum.plus(item.credit);
      if (net.greaterThan(0)) totalDebtorBalance = totalDebtorBalance.plus(net);
      if (net.lessThan(0)) totalCreditorBalance = totalCreditorBalance.plus(net.abs());
      return {
        accountCode,
        accountName: item.name,
        debitSum: round2(item.debit),
        creditSum: round2(item.credit),
        debtorBalance: net.greaterThan(0) ? round2(net) : "0.00",
        creditorBalance: net.lessThan(0) ? round2(net.abs()) : "0.00",
      };
    });
    const balanced = totalDebitSum.minus(totalCreditSum).abs().lessThan(0.005)
      && totalDebtorBalance.minus(totalCreditorBalance).abs().lessThan(0.005);
    return {
      companyId, accountingPeriod: year, generatedAt: new Date().toISOString(), rows,
      totalDebitSum: round2(totalDebitSum), totalCreditSum: round2(totalCreditSum),
      totalDebtorBalance: round2(totalDebtorBalance), totalCreditorBalance: round2(totalCreditorBalance),
      isBalanced: balanced,
    };
  }

  /** Valida todos los asientos, saldos anuales, resultado y opcionalmente cierres mensuales. */
  public validateFiscalYearForClosing(
    companyId: string,
    fiscalYear: string | number,
    options: AnnualClosingValidationOptions = {}
  ): AnnualClosingValidationResult {
    const year = String(fiscalYear);
    const errors: string[] = [];
    const warnings: string[] = [];
    const unbalancedEntries: AnnualClosingValidationResult["unbalancedEntries"] = [];
    const entries = this.getJournalEntries(companyId).filter((entry) => entry.accountingPeriod.startsWith(`${year}-`));
    if (!/^\d{4}$/.test(year)) errors.push("El ejercicio fiscal debe tener formato YYYY");
    if (!options.allowEmptyYear && entries.length === 0) errors.push(`El ejercicio ${year} no contiene asientos contables registrados`);
    let totalDebit = new Decimal(0);
    let totalCredit = new Decimal(0);
    for (const entry of entries) {
      const d = new Decimal(entry.totalDebit || 0);
      const c = new Decimal(entry.totalCredit || 0);
      totalDebit = totalDebit.plus(d);
      totalCredit = totalCredit.plus(c);
      const difference = d.minus(c).abs();
      const lineTotals = entry.lines.reduce((acc, line) => ({
        debit: acc.debit.plus(line.debit), credit: acc.credit.plus(line.credit),
      }), { debit: new Decimal(0), credit: new Decimal(0) });
      const lineDifference = lineTotals.debit.minus(lineTotals.credit).abs();
      if (!entry.isBalanced || difference.greaterThanOrEqualTo(0.005) || lineDifference.greaterThanOrEqualTo(0.005)) {
        unbalancedEntries.push({ entryId: entry.id, entryNumber: entry.entryNumber, difference: round2(Decimal.max(difference, lineDifference)), totalDebit: entry.totalDebit, totalCredit: entry.totalCredit });
        errors.push(`Asiento #${entry.entryNumber} (${entry.id}) desbalanceado en el ejercicio ${year}`);
      }
    }
    const annualTrialBalance = this.generateAnnualTrialBalance(companyId, year);
    if (!annualTrialBalance.isBalanced) errors.push(`El balance de comprobación anual ${year} no está cuadrado`);

    // 1. Identificar períodos mensuales con movimientos o registrados en el ejercicio
    const periodsWithActivity = new Set<string>();
    for (const entry of entries) {
      periodsWithActivity.add(entry.accountingPeriod);
    }
    for (const p of this.periods.values()) {
      if (p.companyId === companyId && p.period.startsWith(`${year}-`)) {
        periodsWithActivity.add(p.period);
      }
    }
    if (options.requireAll12MonthsClosed) {
      for (let month = 1; month <= 12; month += 1) {
        periodsWithActivity.add(`${year}-${String(month).padStart(2, "0")}`);
      }
    }

    const unclosedPeriods: string[] = [];
    for (const period of Array.from(periodsWithActivity).sort()) {
      if (!this.isPeriodClosed(companyId, period)) {
        unclosedPeriods.push(period);
      }
    }

    // Por defecto, se bloquea el cierre anual si existen períodos abiertos (salvo allowOpenPeriods: true o requireMonthlyClosed: false)
    const blockForOpenPeriods = options.allowOpenPeriods
      ? false
      : (options.requireMonthlyClosed ?? true);

    if (blockForOpenPeriods && unclosedPeriods.length > 0) {
      errors.push(
        `No se puede cerrar el ejercicio fiscal ${year}: existen períodos mensuales con movimientos sin cerrar (${unclosedPeriods.join(", ")})`
      );
    } else if (unclosedPeriods.length > 0) {
      warnings.push(
        `Períodos mensuales con movimientos aún abiertos: ${unclosedPeriods.join(", ")}`
      );
    }

    // 2. Identificar asientos pendientes de contabilizar (PENDING / DRAFT)
    const allowPending = options.allowPendingEntries ?? false;
    const pendingJournalEntries = entries.filter((e) => e.status && e.status !== "POSTED");
    const externalPending = options.pendingEntries ?? [];

    const pendingEntriesList: AnnualClosingValidationResult["pendingEntries"] = [
      ...pendingJournalEntries.map((e) => ({
        entryId: e.id,
        period: e.accountingPeriod,
        entryNumber: e.entryNumber,
        glosa: e.glosa,
        amount: e.totalDebit,
        status: e.status,
      })),
      ...externalPending.map((p) => ({
        entryId: p.id,
        period: p.period,
        glosa: p.glosa,
        amount: p.amount,
        status: "PENDING",
      })),
    ];

    if (!allowPending && pendingEntriesList.length > 0) {
      const summary = pendingEntriesList
        .slice(0, 3)
        .map((p) => `#${p.entryNumber ?? p.entryId} (${p.period}: ${p.glosa})`)
        .join("; ");
      const extra = pendingEntriesList.length > 3 ? ` y ${pendingEntriesList.length - 3} más` : "";
      errors.push(
        `No se puede cerrar el ejercicio fiscal ${year}: existen ${pendingEntriesList.length} asiento(s) pendiente(s) de contabilizar: ${summary}${extra}`
      );
    }

    const netIncomeAmount = annualTrialBalance.rows.filter((row) => row.accountCode.startsWith("7") && !row.accountCode.startsWith("79"))
      .reduce((sum, row) => sum.plus(row.creditSum).minus(row.debitSum), new Decimal(0));
    const netExpenseAmount = annualTrialBalance.rows.filter((row) => row.accountCode.startsWith("6"))
      .reduce((sum, row) => sum.plus(row.debitSum).minus(row.creditSum), new Decimal(0));
    const result = netIncomeAmount.minus(netExpenseAmount);
    const resultType: AccountingResultType = result.greaterThan(0) ? "PROFIT" : result.lessThan(0) ? "LOSS" : "ZERO";
    const balanced = totalDebit.minus(totalCredit).abs().lessThan(0.005);
    return {
      isValid: errors.length === 0 && balanced && annualTrialBalance.isBalanced && unbalancedEntries.length === 0,
      fiscalYear: year, companyId, totalEntries: entries.length,
      totalDebitSum: round2(totalDebit), totalCreditSum: round2(totalCredit),
      isDoubleEntryBalanced: balanced && unbalancedEntries.length === 0,
      trialBalanceBalanced: annualTrialBalance.isBalanced,
      netIncome: round2(netIncomeAmount), netExpense: round2(netExpenseAmount),
      accountingResult: round2(result), resultType, unbalancedEntries, unclosedPeriods,
      pendingEntries: pendingEntriesList, errors, warnings,
    };
  }

  /** Construye los asientos de cierre anual sin registrarlos, para revisión previa. */
  public buildAnnualClosingEntries(input: ExecuteAnnualCloseInput): AnnualClosingEntriesResult {
    const year = String(input.fiscalYear);
    const closingPeriod = input.closingPeriod ?? `${year}-12`;
    const closingDate = input.closingDate ?? `${year}-12-31`;

    if (!/^\d{4}-\d{2}$/.test(closingPeriod) || !closingPeriod.startsWith(`${year}-`)) {
      throw new Error("El período de cierre debe pertenecer al ejercicio fiscal indicado (YYYY-MM)");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDate) || !closingDate.startsWith(`${year}-`)) {
      throw new Error("La fecha de cierre debe pertenecer al ejercicio fiscal indicado (YYYY-MM-DD)");
    }

    const validation = this.validateFiscalYearForClosing(input.companyId, year, input.validationOptions);
    if (!validation.isValid) {
      throw new Error(`No se puede generar el cierre anual ${year}: ${validation.errors.join("; ")}`);
    }

    const trial = this.generateAnnualTrialBalance(input.companyId, year);
    const netByAccount = new Map(trial.rows.map((row) => [row.accountCode, new Decimal(row.debitSum).minus(row.creditSum)]));
    const accountNameMap = new Map(trial.rows.map((row) => [row.accountCode, row.accountName]));

    const makeLines = (predicate: (code: string) => boolean) =>
      trial.rows
        .filter((row) => predicate(row.accountCode))
        .flatMap((row) => {
          const net = netByAccount.get(row.accountCode)!;
          if (net.isZero()) return [];
          return [{
            accountCode: row.accountCode,
            accountName: row.accountName,
            debit: net.lessThan(0) ? round2(net.abs()) : "0.00",
            credit: net.greaterThan(0) ? round2(net) : "0.00",
            glosa: `Cierre anual ${year}`,
          }];
        });

    const mkEntry = (label: string, lines: CreateJournalEntryInput["lines"]): CreateJournalEntryInput => ({
      companyId: input.companyId,
      accountingPeriod: closingPeriod,
      entryDate: closingDate,
      glosa: `${label} del ejercicio ${year}`,
      currency: "PEN",
      originDocument: { type: "CLOSING", documentId: `ANNUAL-CLOSE-${input.companyId}-${year}` },
      lines,
    });

    // ASIENTO 1: Cancelación de gastos por función (Clase 9) contra Cargas Imputables (Cuenta 79)
    const expenseFunctionLines = makeLines((code) => code.startsWith("9") || code.startsWith("79"));
    let expenseByFunctionEntry: CreateJournalEntryInput | undefined;
    if (expenseFunctionLines.length > 0) {
      const balance = validateJournalEntryBalance(
        expenseFunctionLines.map((l, idx) => ({ ...l, lineNumber: idx + 1 }))
      );
      if (!balance.isBalanced) {
        throw new Error(
          `Las cuentas de clase 9 y 79 no cuadran para cierre: diferencia ${balance.difference}`
        );
      }
      expenseByFunctionEntry = mkEntry(
        "Cierre de gastos por función (clase 9 contra cuenta 79)",
        expenseFunctionLines
      );
    }

    // ASIENTO 2: Cancelación de ingresos y gastos por naturaleza contra Resultado del Ejercicio (Elemento 89)
    const operatingLines = makeLines(
      (code) =>
        (code.startsWith("6") || code.startsWith("7") || code.startsWith("8")) &&
        !code.startsWith("79") &&
        !code.startsWith("89")
    );

    const operatingTotals = operatingLines.reduce(
      (acc, line) => ({
        debit: acc.debit.plus(line.debit ?? 0),
        credit: acc.credit.plus(line.credit ?? 0),
      }),
      { debit: new Decimal(0), credit: new Decimal(0) }
    );
    const operatingDifference = operatingTotals.debit.minus(operatingTotals.credit);

    if (operatingDifference.greaterThan(0)) {
      // Ingresos > Gastos => Utilidad contable: abono (haber) a la 891
      operatingLines.push({
        accountCode: "891",
        accountName: resolveAccountName("891", "Utilidad del ejercicio"),
        debit: "0.00",
        credit: round2(operatingDifference),
        glosa: `Determinación de utilidad del ejercicio ${year}`,
      });
    } else if (operatingDifference.lessThan(0)) {
      // Gastos > Ingresos => Pérdida contable: cargo (debe) a la 892
      operatingLines.push({
        accountCode: "892",
        accountName: resolveAccountName("892", "Pérdida del ejercicio"),
        debit: round2(operatingDifference.abs()),
        credit: "0.00",
        glosa: `Determinación de pérdida del ejercicio ${year}`,
      });
    }

    const resultsClosingEntry = mkEntry(
      "Cierre de cuentas de gestión y determinación del resultado",
      operatingLines
    );

    // ASIENTO 3: Transferencia del Resultado del Ejercicio a Resultados Acumulados (Cuenta 59)
    let transferToAccumulatedEntry: CreateJournalEntryInput | undefined;
    const resultAmount = new Decimal(validation.accountingResult).abs();

    if (validation.resultType === "PROFIT" && resultAmount.greaterThan(0)) {
      transferToAccumulatedEntry = mkEntry("Transferencia de utilidad a resultados acumulados", [
        {
          accountCode: "891",
          accountName: resolveAccountName("891", "Utilidad del ejercicio"),
          debit: round2(resultAmount),
          credit: "0.00",
          glosa: `Cancelación cuenta de utilidad del ejercicio ${year}`,
        },
        {
          accountCode: "5911",
          accountName: resolveAccountName("5911", "Utilidades acumuladas"),
          debit: "0.00",
          credit: round2(resultAmount),
          glosa: `Utilidad del ejercicio ${year} transferida a resultados acumulados`,
        },
      ]);
    } else if (validation.resultType === "LOSS" && resultAmount.greaterThan(0)) {
      transferToAccumulatedEntry = mkEntry("Transferencia de pérdida a resultados acumulados", [
        {
          accountCode: "5921",
          accountName: resolveAccountName("5921", "Pérdidas acumuladas"),
          debit: round2(resultAmount),
          credit: "0.00",
          glosa: `Pérdida del ejercicio ${year} transferida a resultados acumulados`,
        },
        {
          accountCode: "892",
          accountName: resolveAccountName("892", "Pérdida del ejercicio"),
          debit: "0.00",
          credit: round2(resultAmount),
          glosa: `Cancelación cuenta de pérdida del ejercicio ${year}`,
        },
      ]);
    }

    // ASIENTO 4: Cierre de Cuentas de Balance (Elementos 1 a 5)
    // Se cancelan todos los activos (haber) contra pasivos y patrimonio (debe), incorporando el resultado del ejercicio trasladado a la 59
    const balanceLines = makeLines((code) => /^[1-5]/.test(code));

    if (validation.resultType === "PROFIT" && resultAmount.greaterThan(0)) {
      // La utilidad fue acreditada en la 5911; para saldarla en el asiento de cierre se DEBITA
      const existingLine = balanceLines.find((l) => l.accountCode === "5911");
      if (existingLine) {
        existingLine.debit = round2(new Decimal(existingLine.debit || 0).plus(resultAmount));
      } else {
        balanceLines.push({
          accountCode: "5911",
          accountName: resolveAccountName("5911", "Utilidades acumuladas"),
          debit: round2(resultAmount),
          credit: "0.00",
          glosa: `Cierre patrimonial utilidad acumulada ejercicio ${year}`,
        });
      }
    } else if (validation.resultType === "LOSS" && resultAmount.greaterThan(0)) {
      // La pérdida fue debitada en la 5921; para saldarla en el asiento de cierre se ACREDITA
      const existingLine = balanceLines.find((l) => l.accountCode === "5921");
      if (existingLine) {
        existingLine.credit = round2(new Decimal(existingLine.credit || 0).plus(resultAmount));
      } else {
        balanceLines.push({
          accountCode: "5921",
          accountName: resolveAccountName("5921", "Pérdidas acumuladas"),
          debit: "0.00",
          credit: round2(resultAmount),
          glosa: `Cierre patrimonial pérdida acumulada ejercicio ${year}`,
        });
      }
    }

    const balanceTotals = balanceLines.reduce(
      (acc, line) => ({
        debit: acc.debit.plus(line.debit ?? 0),
        credit: acc.credit.plus(line.credit ?? 0),
      }),
      { debit: new Decimal(0), credit: new Decimal(0) }
    );
    const balanceDiff = balanceTotals.debit.minus(balanceTotals.credit).abs();
    if (balanceDiff.greaterThanOrEqualTo(0.005)) {
      throw new Error(
        `Los saldos de balance (elementos 1-5) no cuadran para el cierre: Total Debe (${round2(balanceTotals.debit)}) != Total Haber (${round2(balanceTotals.credit)}). Diferencia: ${round2(balanceDiff)}`
      );
    }

    const balanceClosingEntry = mkEntry("Cierre de cuentas de balance patrimonial", balanceLines);

    // ASIENTO 5: Asiento de apertura para el ejercicio siguiente (inversión exacta de las cuentas de balance)
    const nextYearOpeningEntry = input.generateNextYearOpening
      ? {
          companyId: input.companyId,
          accountingPeriod: `${Number(year) + 1}-01`,
          entryDate: `${Number(year) + 1}-01-01`,
          glosa: `Asiento de apertura del ejercicio ${Number(year) + 1}`,
          currency: "PEN" as const,
          isOpening: true,
          originDocument: {
            type: "OPENING" as const,
            documentId: `ANNUAL-OPENING-${input.companyId}-${Number(year) + 1}`,
          },
          lines: balanceLines.map((line) => ({
            accountCode: line.accountCode,
            accountName: line.accountName,
            debit: line.credit,
            credit: line.debit,
            glosa: `Apertura ejercicio ${Number(year) + 1}`,
          })),
        }
      : undefined;

    return {
      expenseByFunctionEntry,
      resultsClosingEntry,
      transferToAccumulatedEntry,
      balanceClosingEntry,
      nextYearOpeningEntry,
      accountingResult: validation.accountingResult,
      resultType: validation.resultType,
    };
  }

  public closeFiscalYear(input: ExecuteAnnualCloseInput): AnnualCloseRecord {
    const year = String(input.fiscalYear);
    const key = `${input.companyId}_${year}`;
    if (this.isFiscalYearClosed(input.companyId, year)) throw new Error(`El ejercicio contable ${year} ya se encuentra cerrado`);
    const validation = this.validateFiscalYearForClosing(input.companyId, year, input.validationOptions);
    if (!validation.isValid) throw new Error(`No se puede cerrar el ejercicio ${year}: ${validation.errors.join("; ")}`);
    const preClosingTrialBalance = this.generateAnnualTrialBalance(input.companyId, year);
    const built = this.buildAnnualClosingEntries(input);
    const planned = [built.expenseByFunctionEntry, built.resultsClosingEntry, built.transferToAccumulatedEntry, built.balanceClosingEntry].filter((entry): entry is CreateJournalEntryInput => Boolean(entry));
    for (const entry of planned) {
      const balance = validateJournalEntryBalance(entry.lines.map((line, index) => ({ ...line, lineNumber: index + 1, accountName: line.accountName ?? resolveAccountName(line.accountCode) , debit: String(line.debit ?? 0), credit: String(line.credit ?? 0) })));
      if (!balance.isBalanced) throw new Error(`Asiento anual no balanceado (${entry.glosa}): diferencia ${balance.difference}`);
    }

    // El cierre anual abarca varios asientos. Conservamos el estado antes de
    // escribir para evitar dejar un cierre parcial si falla, por ejemplo, la
    // contabilización de la apertura del siguiente ejercicio.
    const entriesBeforeClose = this.entries.map((entry) => ({
      ...entry,
      lines: entry.lines.map((line) => ({ ...line })),
    }));
    const sequenceBeforeClose = new Map(this.entrySequenceByPeriod);
    const closuresBeforeClose = new Map(this.annualClosures);

    try {
      const closingEntries = planned.map((entry) => this.registerAnnualClosingEntry({ ...entry, isClosing: true } as CreateJournalEntryInput));
      let nextYearOpeningEntry: JournalEntry | undefined;
      if (built.nextYearOpeningEntry) nextYearOpeningEntry = this.registerEntry(built.nextYearOpeningEntry);
      const postClosingTrialBalance = this.generateAnnualTrialBalance(input.companyId, year);
      const record: AnnualCloseRecord = {
        companyId: input.companyId, fiscalYear: year, status: "CLOSED", closedAt: new Date().toISOString(),
        closedBy: input.closedBy?.trim() || "USUARIO_CONTABLE", closingNotes: input.notes?.trim(),
        netIncome: validation.netIncome, netExpense: validation.netExpense, accountingResult: validation.accountingResult,
        resultType: validation.resultType, closingEntryIds: closingEntries.map((entry) => entry.id), closingEntries,
        preClosingTrialBalance, postClosingTrialBalance, nextYearOpeningEntry,
      };
      this.annualClosures.set(key, record);
      return this.getFiscalYearCloseRecord(input.companyId, year)!;
    } catch (error) {
      this.entries = entriesBeforeClose;
      this.entrySequenceByPeriod = sequenceBeforeClose;
      this.annualClosures = closuresBeforeClose;
      throw error;
    }
  }

  /** Reabre un ejercicio anual con auditoría y motivo obligatorio. */
  public executeAnnualClose(input: ExecuteAnnualCloseInput): AnnualCloseRecord {
    return this.closeFiscalYear(input);
  }

  public getAnnualCloseRecord(companyId: string, fiscalYear: string | number): AnnualCloseRecord | undefined {
    return this.getFiscalYearCloseRecord(companyId, fiscalYear);
  }

  public listAnnualCloses(companyId: string): AnnualCloseRecord[] {
    const results: AnnualCloseRecord[] = [];
    for (const record of this.annualClosures.values()) {
      if (record.companyId === companyId) {
        results.push({ ...record });
      }
    }
    return results.sort((a, b) => a.fiscalYear.localeCompare(b.fiscalYear));
  }

  public reopenFiscalYear(input: ReopenFiscalYearInput): AnnualCloseRecord {
    const year = String(input.fiscalYear);
    if (!input.reopenedBy?.trim()) {
      throw new Error("Se requiere identificar al usuario responsable de la reapertura anual");
    }
    if (!input.reason?.trim() || input.reason.trim().length < 5) {
      throw new Error("Se requiere un motivo válido (mínimo 5 caracteres) para reabrir el ejercicio");
    }
    const key = `${input.companyId}_${year}`;
    const existing = this.annualClosures.get(key);
    if (!existing || existing.status !== "CLOSED") {
      throw new Error(`El ejercicio ${year} no se encuentra cerrado para la empresa ${input.companyId}`);
    }

    // Revertir y remover los asientos de cierre anual registrados para permitir ajustes
    const closingIds = new Set(existing.closingEntryIds);
    if (existing.nextYearOpeningEntry) {
      closingIds.add(existing.nextYearOpeningEntry.id);
    }
    this.entries = this.entries.filter((entry) => !closingIds.has(entry.id));

    const reopened: AnnualCloseRecord = {
      ...existing,
      status: "OPEN" as const,
      reopenedAt: new Date().toISOString(),
      reopenedBy: input.reopenedBy.trim(),
      reopenReason: input.reason.trim(),
      closingEntries: [],
      closingEntryIds: [],
    };
    this.annualClosures.set(key, reopened);
    return { ...reopened };
  }


  /**
   * Genera una vista previa detallada de los asientos anuales que se registrarán,
   * incluyendo cuentas contables PCGE, importes Debe/Haber, glosas y validación previa,
   * sin modificar el estado ni registrar asientos contables.
   */
  public previewAnnualClose(input: PreviewAnnualCloseInput): AnnualClosingPreview {
    const year = String(input.fiscalYear);
    if (!/^\d{4}$/.test(year)) {
      throw new Error("El ejercicio fiscal debe tener formato YYYY");
    }

    if (this.isFiscalYearClosed(input.companyId, year)) {
      throw new Error(`El ejercicio contable ${year} ya se encuentra cerrado`);
    }

    const closingPeriod = input.closingPeriod ?? `${year}-12`;
    const closingDate = input.closingDate ?? `${year}-12-31`;

    if (!/^\d{4}-\d{2}$/.test(closingPeriod) || !closingPeriod.startsWith(`${year}-`)) {
      throw new Error("El período de cierre debe pertenecer al ejercicio fiscal indicado (YYYY-MM)");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDate) || !closingDate.startsWith(`${year}-`)) {
      throw new Error("La fecha de cierre debe pertenecer al ejercicio fiscal indicado (YYYY-MM-DD)");
    }

    // 1. Validación estricta real del ejercicio
    const validation = this.validateFiscalYearForClosing(
      input.companyId,
      year,
      input.validationOptions
    );

    // 2. Construcción tentativa de los asientos de cierre
    // Se permite bypass temporal de períodos abiertos / pendientes para que el usuario pueda visualizar
    // qué asientos se generarían aunque aún tenga meses por cerrar
    let built: AnnualClosingEntriesResult | undefined;
    let buildError: string | undefined;

    try {
      built = this.buildAnnualClosingEntries({
        companyId: input.companyId,
        fiscalYear: year,
        closingDate,
        closingPeriod,
        generateNextYearOpening: input.generateNextYearOpening,
        validationOptions: {
          ...input.validationOptions,
          allowOpenPeriods: true,
          allowPendingEntries: true,
        },
      });
    } catch (err: any) {
      buildError = err?.message || String(err);
    }

    const previewEntries: AnnualClosingPreviewEntry[] = [];
    let consolidatedDebit = new Decimal(0);
    let consolidatedCredit = new Decimal(0);
    let allEntriesBalanced = true;

    if (built) {
      const entryDefs: Array<{
        type: AnnualClosingEntryType;
        title: string;
        entryInput?: CreateJournalEntryInput;
        isOpening?: boolean;
      }> = [
        {
          type: "EXPENSE_BY_FUNCTION",
          title: "Asiento 1: Cierre de cuentas de gastos por función (Clase 9 vs 79)",
          entryInput: built.expenseByFunctionEntry,
        },
        {
          type: "RESULTS_DETERMINATION",
          title: "Asiento 2: Cancelación de cuentas de gestión y determinación del resultado (Clases 6, 7 y Elemento 8)",
          entryInput: built.resultsClosingEntry,
        },
        {
          type: "TRANSFER_ACCUMULATED",
          title: "Asiento 3: Transferencia del resultado del ejercicio a resultados acumulados (Cuenta 59)",
          entryInput: built.transferToAccumulatedEntry,
        },
        {
          type: "BALANCE_CLOSING",
          title: "Asiento 4: Cierre patrimonial de cuentas de balance (Elementos 1 al 5)",
          entryInput: built.balanceClosingEntry,
        },
        {
          type: "NEXT_YEAR_OPENING",
          title: "Asiento 5: Asiento de reapertura del ejercicio siguiente",
          entryInput: built.nextYearOpeningEntry,
          isOpening: true,
        },
      ];

      for (const def of entryDefs) {
        if (!def.entryInput) continue;
        const raw = def.entryInput;
        let entryDebit = new Decimal(0);
        let entryCredit = new Decimal(0);

        const lines: AnnualClosingPreviewLine[] = raw.lines.map((line, idx) => {
          const dStr = round2(line.debit ?? 0);
          const cStr = round2(line.credit ?? 0);
          entryDebit = entryDebit.plus(dStr);
          entryCredit = entryCredit.plus(cStr);
          return {
            lineNumber: idx + 1,
            accountCode: line.accountCode,
            accountName: line.accountName ?? resolveAccountName(line.accountCode),
            debit: dStr,
            credit: cStr,
            glosa: line.glosa ?? raw.glosa,
          };
        });

        consolidatedDebit = consolidatedDebit.plus(entryDebit);
        consolidatedCredit = consolidatedCredit.plus(entryCredit);

        const diff = entryDebit.minus(entryCredit).abs();
        const balanced = diff.lessThan(0.005);
        if (!balanced) allEntriesBalanced = false;

        previewEntries.push({
          entryType: def.type,
          title: def.title,
          glosa: raw.glosa,
          entryDate: raw.entryDate,
          accountingPeriod: raw.accountingPeriod,
          currency: "PEN",
          isClosing: !def.isOpening,
          isOpening: Boolean(def.isOpening),
          lines,
          totalDebit: round2(entryDebit),
          totalCredit: round2(entryCredit),
          difference: round2(diff),
          isBalanced: balanced,
          accountsCount: lines.length,
        });
      }
    }

    if (buildError && !validation.errors.includes(buildError)) {
      validation.errors.push(buildError);
      validation.isValid = false;
    }

    const canClose = validation.isValid && !buildError && allEntriesBalanced && previewEntries.length > 0;

    return {
      companyId: input.companyId,
      fiscalYear: year,
      closingDate,
      closingPeriod,
      generatedAt: new Date().toISOString(),
      canClose,
      validation,
      netIncome: validation.netIncome,
      netExpense: validation.netExpense,
      accountingResult: validation.accountingResult,
      resultType: validation.resultType,
      summary: {
        totalPlannedEntries: previewEntries.length,
        totalDebitSum: round2(consolidatedDebit),
        totalCreditSum: round2(consolidatedCredit),
        isDoubleEntryBalanced: allEntriesBalanced && consolidatedDebit.minus(consolidatedCredit).abs().lessThan(0.005),
        entriesByType: {
          hasExpenseByFunction: previewEntries.some((e) => e.entryType === "EXPENSE_BY_FUNCTION"),
          hasResultsDetermination: previewEntries.some((e) => e.entryType === "RESULTS_DETERMINATION"),
          hasTransferAccumulated: previewEntries.some((e) => e.entryType === "TRANSFER_ACCUMULATED"),
          hasBalanceClosing: previewEntries.some((e) => e.entryType === "BALANCE_CLOSING"),
          hasNextYearOpening: previewEntries.some((e) => e.entryType === "NEXT_YEAR_OPENING"),
        },
      },
      entries: previewEntries,
      plannedEntries: built,
    };
  }

  public getAnnualClosePreview(input: PreviewAnnualCloseInput): AnnualClosingPreview {
    return this.previewAnnualClose(input);
  }

  /**
   * Genera una representación en texto formateado tipo reporte de la vista previa,
   * ideal para impresión en terminal o visualización previa por el contador.
   */
  public formatAnnualClosingPreview(preview: AnnualClosingPreview): string {
    return AccountingService.formatAnnualClosingPreview(preview);
  }

  public static formatAnnualClosingPreview(preview: AnnualClosingPreview): string {
    const lines: string[] = [];
    const sep = "=".repeat(80);
    const subsep = "-".repeat(80);

    lines.push(sep);
    lines.push(`     VISTA PREVIA DE ASIENTOS DE CIERRE ANUAL - EJERCICIO ${preview.fiscalYear}`);
    lines.push(sep);
    lines.push(`Empresa RUC : ${preview.companyId}`);
    lines.push(`Ejercicio   : ${preview.fiscalYear}   |   Fecha Cierre: ${preview.closingDate}`);
    lines.push(`Estado      : ${preview.canClose ? "[LISTO PARA CONFIRMAR CIERRE]" : "[BLOQUEADO - REQUIERE ATENCIÓN]"}`);
    lines.push(`Resultado   : S/ ${preview.accountingResult} (${preview.resultType === "PROFIT" ? "UTILIDAD" : preview.resultType === "LOSS" ? "PÉRDIDA" : "EQUILIBRIO"})`);
    lines.push(`Ingresos (7): S/ ${preview.netIncome}   |   Gastos (6): S/ ${preview.netExpense}`);

    if (!preview.canClose && preview.validation.errors.length > 0) {
      lines.push(subsep);
      lines.push("  MOTIVOS QUE IMPIDEN CONFIRMAR EL CIERRE:");
      for (const err of preview.validation.errors) {
        lines.push(`   * [ERROR] ${err}`);
      }
    }
    if (preview.validation.warnings.length > 0) {
      for (const w of preview.validation.warnings) {
        lines.push(`   * [AVISO] ${w}`);
      }
    }

    lines.push(subsep);
    lines.push(`ASIENTOS PROYECTADOS (${preview.summary.totalPlannedEntries}):`);

    for (let i = 0; i < preview.entries.length; i++) {
      const e = preview.entries[i];
      lines.push("");
      lines.push(`[${i + 1}] ${e.title}`);
      lines.push(`    Glosa: ${e.glosa}`);
      lines.push(`    Fecha: ${e.entryDate}  |  Período: ${e.accountingPeriod}  |  Moneda: ${e.currency}`);
      lines.push("    " + "-".repeat(72));
      lines.push(
        "    " +
          "#".padEnd(4) +
          "CUENTA".padEnd(10) +
          "DESCRIPCIÓN".padEnd(36) +
          "DEBE (S/)".padStart(11) +
          "HABER (S/)".padStart(11)
      );
      lines.push("    " + "-".repeat(72));

      for (const l of e.lines) {
        const desc = l.accountName.length > 34 ? l.accountName.slice(0, 31) + "..." : l.accountName;
        lines.push(
          "    " +
            String(l.lineNumber).padEnd(4) +
            l.accountCode.padEnd(10) +
            desc.padEnd(36) +
            (Number(l.debit) > 0 ? l.debit : "-").padStart(11) +
            (Number(l.credit) > 0 ? l.credit : "-").padStart(11)
        );
      }
      lines.push("    " + "-".repeat(72));
      lines.push(
        "    TOTAL ASIENTO:".padEnd(50) +
          e.totalDebit.padStart(11) +
          e.totalCredit.padStart(11) +
          (e.isBalanced ? "  [OK]" : "  [DESCUADRADO]")
      );
    }

    lines.push("");
    lines.push(sep);
    lines.push(
      `TOTAL CONSOLIDADO CIERRE:  DEBE: S/ ${preview.summary.totalDebitSum}  |  HABER: S/ ${preview.summary.totalCreditSum}  [${preview.summary.isDoubleEntryBalanced ? "PARTIDA DOBLE CUADRADA" : "DESCUADRADO"}]`
    );
    lines.push(sep);

    return lines.join("\n");
  }

}
