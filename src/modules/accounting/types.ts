import { CurrencyCode } from "../../core/tax-engine/types.js";

export type AccountNature = "DEUDORA" | "ACREEDORA";

export interface PcgeAccount {
  code: string;
  name: string;
  element: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  nature: AccountNature;
  level: "ELEMENTO" | "CUENTA" | "SUBCUENTA" | "DIVISIONARIA" | "SUBDIVISIONARIA";
  isMoveable: boolean; // Solo se puede asentar en cuentas con movimiento
}

export type OriginDocumentType =
  | "CPE_SALE" // Factura, Boleta o Nota de Crédito emitida
  | "PURCHASE" // Comprobante de compra / gasto
  | "COLLECTION" // Cobro a cliente
  | "PAYMENT" // Pago a proveedor
  | "OPENING" // Asiento de apertura
  | "ADJUSTMENT" // Asiento de ajuste / regularización
  | "CLOSING" // Asiento de cierre / regularización mensual o anual
  | "MANUAL"; // Asiento manual

export interface OriginDocumentReference {
  type: OriginDocumentType;
  documentId: string;
  cpeType?: string; // "01", "03", "07", "08"
  series?: string;
  correlative?: string | number;
  fullNumber?: string;
  entityDocNumber?: string;
  entityName?: string;
}

export type JournalEntryStatus = "POSTED" | "PENDING" | "DRAFT";

export interface JournalEntryLine {
  lineNumber: number;
  accountCode: string;
  accountName: string;
  debit: string; // "0.00"
  credit: string; // "0.00"
  glosa?: string;
  costCenter?: string;
  referenceDoc?: string;
}

export interface JournalEntry {
  id: string;
  companyId: string;
  accountingPeriod: string; // "YYYY-MM"
  entryNumber: number; // Correlativo de asiento
  entryDate: string; // "YYYY-MM-DD"
  glosa: string; // Explicación de la operación
  currency: CurrencyCode;
  exchangeRate?: string;
  originDocument?: OriginDocumentReference;
  lines: JournalEntryLine[];
  totalDebit: string;
  totalCredit: string;
  isBalanced: boolean;
  status?: JournalEntryStatus;
  isOpening?: boolean;
  isClosing?: boolean;
  createdAt: string;
}

export interface CreateJournalEntryInput {
  companyId: string;
  accountingPeriod: string;
  entryDate: string;
  glosa: string;
  currency?: CurrencyCode;
  exchangeRate?: string;
  originDocument?: OriginDocumentReference;
  status?: JournalEntryStatus;
  lines: Array<{
    accountCode: string;
    accountName?: string;
    debit?: number | string;
    credit?: number | string;
    glosa?: string;
    costCenter?: string;
    referenceDoc?: string;
  }>;
}

// Configuración contable para generar asientos automáticos
export interface AccountingAutomationConfig {
  defaultReceivableAccount?: string; // Por defecto: "1212"
  defaultPayableAccount?: string; // Por defecto: "4212"
  defaultIgvAccount?: string; // Por defecto: "40111"
  defaultSaleAccountMerchandise?: string; // Por defecto: "70121"
  defaultSaleAccountServices?: string; // Por defecto: "70221"
  defaultPurchaseAccountMerchandise?: string; // Por defecto: "6011"
  defaultInventoryAccount?: string; // Por defecto: "20111"
  defaultInventoryVariationAccount?: string; // Por defecto: "6111"
  defaultAdminExpenseAccount?: string; // Por defecto: "941"
  defaultSellingExpenseAccount?: string; // Por defecto: "951"
  defaultImputableExpenseAccount?: string; // Por defecto: "791"
  adminExpenseRatio?: number; // Porcentaje a gastos adm (ej. 0.50 para 50%)
  sellingExpenseRatio?: number; // Porcentaje a gastos venta (ej. 0.50 para 50%)
}

// Libro Mayor
export interface GeneralLedgerMovement {
  entryNumber: number;
  entryDate: string;
  glosa: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface GeneralLedgerAccount {
  accountCode: string;
  accountName: string;
  totalDebit: string;
  totalCredit: string;
  debtorBalance: string; // Saldo deudor
  creditorBalance: string; // Saldo acreedor
  movements: GeneralLedgerMovement[];
}

export interface GeneralLedger {
  companyId: string;
  accountingPeriod: string;
  generatedAt: string;
  totalDebit: string;
  totalCredit: string;
  accounts: GeneralLedgerAccount[];
}

// Balance de Comprobación (Sumas y Saldos)
export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debitSum: string; // Sumas del Mayor: Debe
  creditSum: string; // Sumas del Mayor: Haber
  debtorBalance: string; // Saldos: Deudor
  creditorBalance: string; // Saldos: Acreedor
}

export interface TrialBalance {
  companyId: string;
  accountingPeriod: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totalDebitSum: string;
  totalCreditSum: string;
  totalDebtorBalance: string;
  totalCreditorBalance: string;
  isBalanced: boolean;
}

// Estado del Período Contable y Cierre Mensual
export type AccountingPeriodStatus = "OPEN" | "CLOSED";

export interface AccountingPeriodRecord {
  companyId: string;
  period: string; // "YYYY-MM"
  status: AccountingPeriodStatus;
  totalEntries: number;
  totalDebit: string;
  totalCredit: string;
  isBalanced: boolean;
  closedAt?: string;
  closedBy?: string;
  closingNotes?: string;
  reopenedAt?: string;
  reopenedBy?: string;
  reopenReason?: string;
  trialBalanceSnapshot?: TrialBalance;
}

export interface CloseAccountingPeriodInput {
  companyId: string;
  period: string; // "YYYY-MM"
  closedBy?: string;
  notes?: string;
  allowEmptyPeriod?: boolean;
}

export interface ReopenAccountingPeriodInput {
  companyId: string;
  period: string; // "YYYY-MM"
  reopenedBy: string;
  reason: string;
}

export interface PeriodValidationResult {
  isValid: boolean;
  period: string;
  companyId: string;
  totalEntries: number;
  totalDebit: string;
  totalCredit: string;
  isDoubleEntryBalanced: boolean;
  unbalancedEntries: Array<{
    entryId: string;
    entryNumber: number;
    difference: string;
    totalDebit: string;
    totalCredit: string;
  }>;
  errors: string[];
}

// ==========================================
// CIERRE CONTABLE ANUAL
// ==========================================

export type AnnualClosingStatus = "OPEN" | "CLOSED";
export type AccountingResultType = "PROFIT" | "LOSS" | "ZERO";

export interface PendingJournalEntryItem {
  id: string;
  period: string;
  date?: string;
  glosa: string;
  amount?: string;
  referenceDoc?: string;
}

export interface AnnualClosingValidationOptions {
  allowEmptyYear?: boolean;
  requireMonthlyClosed?: boolean; // Si true (por defecto), exige que todos los períodos mensuales con movimientos estén en estado CLOSED
  allowOpenPeriods?: boolean; // Si true, omite el bloqueo por períodos abiertos (permite cerrar)
  requireAll12MonthsClosed?: boolean; // Si true, exige que los 12 meses YYYY-01 a YYYY-12 estén en estado CLOSED
  allowPendingEntries?: boolean; // Si true, omite el bloqueo por asientos pendientes de contabilizar
  pendingEntries?: PendingJournalEntryItem[]; // Asientos o transacciones externas pendientes adicionales
}

export interface AnnualClosingValidationResult {
  isValid: boolean;
  fiscalYear: string; // "YYYY"
  companyId: string;
  totalEntries: number;
  totalDebitSum: string;
  totalCreditSum: string;
  isDoubleEntryBalanced: boolean;
  trialBalanceBalanced: boolean;
  netIncome: string; // Total ingresos Elemento 7
  netExpense: string; // Total gastos Elemento 6 / costos netos
  accountingResult: string; // netIncome - netExpense (positivo = utilidad, negativo = pérdida)
  resultType: AccountingResultType;
  unbalancedEntries: Array<{
    entryId: string;
    entryNumber: number;
    difference: string;
    totalDebit: string;
    totalCredit: string;
  }>;
  unclosedPeriods: string[];
  pendingEntries: Array<{
    entryId: string;
    period: string;
    entryNumber?: number;
    glosa: string;
    amount?: string;
    status?: string;
  }>;
  errors: string[];
  warnings: string[];
}

export interface AnnualClosingEntriesResult {
  expenseByFunctionEntry?: CreateJournalEntryInput; // Asiento 1: Clase 9 vs 79
  resultsClosingEntry: CreateJournalEntryInput; // Asiento 2: Clases 6 y 7 vs 89
  transferToAccumulatedEntry?: CreateJournalEntryInput; // Asiento 3: Cuenta 89 vs 59
  balanceClosingEntry: CreateJournalEntryInput; // Asiento 4: Cuentas de Balance (1-5)
  nextYearOpeningEntry?: CreateJournalEntryInput; // Asiento 5 (Opcional): Reapertura YYYY+1
  accountingResult: string;
  resultType: AccountingResultType;
}

export interface AnnualCloseRecord {
  companyId: string;
  fiscalYear: string; // "YYYY"
  status: AnnualClosingStatus;
  closedAt: string;
  closedBy: string;
  closingNotes?: string;
  netIncome: string;
  netExpense: string;
  accountingResult: string;
  resultType: AccountingResultType;
  closingEntryIds: string[];
  closingEntries: JournalEntry[];
  preClosingTrialBalance: TrialBalance;
  postClosingTrialBalance: TrialBalance;
  nextYearOpeningEntry?: JournalEntry;
  reopenedAt?: string;
  reopenedBy?: string;
  reopenReason?: string;
}

export interface ExecuteAnnualCloseInput {
  companyId: string;
  fiscalYear: string | number; // "YYYY" o número (ej. 2026)
  closedBy?: string;
  notes?: string;
  closingDate?: string; // Por defecto: "YYYY-12-31"
  closingPeriod?: string; // Por defecto: "YYYY-12"
  generateNextYearOpening?: boolean; // Genera asiento de apertura para (YYYY+1)-01
  validationOptions?: AnnualClosingValidationOptions;
}

export interface ReopenFiscalYearInput {
  companyId: string;
  fiscalYear: string | number;
  reopenedBy: string;
  reason: string;
}


export type AnnualClosingEntryType =
  | "EXPENSE_BY_FUNCTION" // Asiento 1: Cancelación de gastos por función (Clase 9 vs Cuenta 79)
  | "RESULTS_DETERMINATION" // Asiento 2: Cierre de cuentas de gestión (6 y 7) y determinación del resultado (Elemento 8)
  | "TRANSFER_ACCUMULATED" // Asiento 3: Transferencia del resultado del ejercicio a resultados acumulados (89 vs 59)
  | "BALANCE_CLOSING" // Asiento 4: Cierre patrimonial de cuentas de balance (Elementos 1 al 5)
  | "NEXT_YEAR_OPENING"; // Asiento 5 (Opcional): Reapertura del ejercicio siguiente

export interface AnnualClosingPreviewLine {
  lineNumber: number;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  glosa: string;
}

export interface AnnualClosingPreviewEntry {
  entryType: AnnualClosingEntryType;
  title: string;
  glosa: string;
  entryDate: string; // "YYYY-12-31" o "YYYY+1-01-01"
  accountingPeriod: string; // "YYYY-12" o "YYYY+1-01"
  currency: "PEN";
  isClosing: boolean;
  isOpening?: boolean;
  lines: AnnualClosingPreviewLine[];
  totalDebit: string;
  totalCredit: string;
  difference: string;
  isBalanced: boolean;
  accountsCount: number;
}

export interface PreviewAnnualCloseInput {
  companyId: string;
  fiscalYear: string | number;
  closingDate?: string;
  closingPeriod?: string;
  generateNextYearOpening?: boolean;
  validationOptions?: AnnualClosingValidationOptions;
}

export interface AnnualClosingPreviewSummary {
  totalPlannedEntries: number;
  totalDebitSum: string;
  totalCreditSum: string;
  isDoubleEntryBalanced: boolean;
  entriesByType: {
    hasExpenseByFunction: boolean;
    hasResultsDetermination: boolean;
    hasTransferAccumulated: boolean;
    hasBalanceClosing: boolean;
    hasNextYearOpening: boolean;
  };
}

export interface AnnualClosingPreview {
  companyId: string;
  fiscalYear: string; // "YYYY"
  closingDate: string; // "YYYY-12-31"
  closingPeriod: string; // "YYYY-12"
  generatedAt: string; // ISO string
  canClose: boolean; // true si no hay errores de validación y los asientos proyectados cuadran
  validation: AnnualClosingValidationResult;
  netIncome: string;
  netExpense: string;
  accountingResult: string;
  resultType: AccountingResultType;
  summary: AnnualClosingPreviewSummary;
  entries: AnnualClosingPreviewEntry[];
  plannedEntries?: AnnualClosingEntriesResult;
}
