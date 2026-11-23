/**
 * SISTEMA INTEGRADO DE REGISTROS ELECTRÓNICOS (SIRE - SUNAT)
 * Normativa: R.S. N° 112-2021/SUNAT, R.S. N° 040-2022/SUNAT y modificatorias
 */

export type SireBookCode = "140400" | "080400"; // 140400: RVIE, 080400: RCE

export interface SireFileNameParams {
  ruc: string; // 11 dígitos
  year: number | string; // 4 dígitos
  month: number | string; // 2 dígitos (01 - 12)
  bookCode: SireBookCode;
  opportunityCode?: string; // "02" para reemplazo/propuesta SIRE (default)
  hasInformation?: boolean; // true: "1" (con datos), false: "0" (sin operaciones)
  currencyIndicator?: "1" | "2"; // 1: PEN (default), 2: USD
  generatorIndicator?: "1" | "2"; // 2: SIRE Web / Cliente (default)
  extension?: "txt" | "zip";
}

export type SireProposalAction = "ACEPTAR" | "COMPLEMENTAR" | "REEMPLAZAR" | "EXCLUIR";

export interface SireCarParsed {
  issuerRuc: string;
  cpeType: string;
  series: string;
  correlative: string;
  rawCar: string;
}

export interface SireRvieLineData {
  companyRuc: string;
  companyName: string;
  period: string; // "YYYYMM"
  car?: string;
  issueDate: string; // "DD/MM/YYYY"
  dueDate?: string;
  cpeType: string; // "01", "03", "07"
  series: string;
  correlative: string;
  correlativeEnd?: string;
  clientDocType: string; // "6", "1", "0", etc.
  clientDocNumber: string;
  clientName: string;
  exportBase?: string;
  taxableBase: string;
  baseDiscount?: string;
  igvAmount: string;
  igvDiscount?: string;
  exoneratedAmount?: string;
  inaffectedAmount?: string;
  iscAmount?: string;
  ivapBase?: string;
  ivapAmount?: string;
  icbperAmount?: string;
  otherTaxes?: string;
  totalAmount: string;
  currency: string;
  exchangeRate?: string;
  modifiedIssueDate?: string;
  modifiedCpeType?: string;
  modifiedSeries?: string;
  modifiedCorrelative?: string;
  cancellationIndicator?: string;
  statusCode?: string; // "1": Válido, "2": Anulado
}

export interface SireRceLineData {
  companyRuc: string;
  companyName: string;
  period: string; // "YYYYMM"
  car: string; // 27 caracteres del emisor/proveedor
  issueDate: string; // "DD/MM/YYYY"
  dueDate?: string;
  cpeType: string; // "01", "03", "07", etc.
  series: string;
  duaYear?: string;
  correlative: string;
  correlativeEnd?: string;
  supplierDocType: string; // "6"
  supplierDocNumber: string;
  supplierName: string;
  baseGravadaExclusiva: string; // Adquisiciones gravadas exclusivamente a ventas gravadas
  igvGravadoExclusivo: string;
  baseGravadaComun?: string; // Adquisiciones gravadas a ventas comunes
  igvGravadoComun?: string;
  baseGravadaSinCredito?: string; // Adquisiciones gravadas sin derecho a crédito fiscal
  igvGravadoSinCredito?: string;
  adquisicionesNoGravadas?: string; // Exoneradas o inafectas
  iscAmount?: string;
  icbperAmount?: string;
  otherTaxes?: string;
  totalAmount: string;
  currency: string;
  exchangeRate?: string;
  modifiedIssueDate?: string;
  modifiedCpeType?: string;
  modifiedSeries?: string;
  modifiedCorrelative?: string;
  detractionDepositDate?: string;
  detractionProofNumber?: string;
  retentionIndicator?: string;
  classificationCode?: string; // "1" a "5"
  bancarizadoIndicator?: string; // "1": Sí, "0": No
  statusCode?: string; // "1": En el período, "0": Anulado
}

export interface SireExportResult {
  bookCode: SireBookCode;
  bookName: string;
  period: string;
  fileName: string;
  txtContent: string;
  zipFileName?: string;
  zipBuffer?: Uint8Array;
  lineCount: number;
  totalTaxableBase: string;
  totalIgv: string;
  totalAmount: string;
}

export interface SireSettlementIntegrationPayload {
  period: string; // "YYYY-MM"
  salesTaxableBase: string;
  salesIgv: string;
  purchasesTaxableBase: string;
  purchasesIgv: string;
  purchasesCount: number;
  salesCount: number;
}

export interface SireCpeInput {
  id?: string;
  companyId?: string;
  companyRuc: string;
  cpeType: string;
  series: string;
  correlative: number | string;
  fullNumber?: string;
  issueDate: string;
  dueDate?: string;
  currency: string;
  exchangeRate?: string;
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  taxableBase: string;
  igvAmount: string;
  totalAmount: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
}
