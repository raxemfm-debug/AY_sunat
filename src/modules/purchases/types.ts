import { CurrencyCode, IdentityDocTypeCode } from "../../core/tax-engine/types.js";

/**
 * Destino del Crédito Fiscal en Compras según Ley del IGV (TUO D.S. 055-99-EF):
 * - GRAVADO_EXCLUSIVO: Adquisiciones destinadas exclusivamente a operaciones gravadas y de exportación (100% crédito fiscal).
 * - GRAVADO_COMUN: Adquisiciones destinadas a operaciones gravadas y no gravadas (sujeto a prorrata de crédito fiscal).
 * - GRAVADO_SIN_CREDITO: Adquisiciones gravadas destinadas exclusivamente a operaciones no gravadas (costo/gasto, sin crédito fiscal).
 * - NO_GRAVADO: Adquisiciones no gravadas, exoneradas o inafectas.
 */
export type PurchaseTaxDestination =
  | "GRAVADO_EXCLUSIVO"
  | "GRAVADO_COMUN"
  | "GRAVADO_SIN_CREDITO"
  | "NO_GRAVADO";

/**
 * Clasificación de Bienes y Servicios según Tabla 31 de SUNAT (SIRE RCE):
 * 1: Mercaderías, materia prima, insumos
 * 2: Activo fijo
 * 3: Otros costos de producción o gastos de administración/ventas
 * 4: Gastos no deducibles
 * 5: Contratos de construcción
 */
export type PurchaseExpenseClassification = "1" | "2" | "3" | "4" | "5";

export interface SupplierProfile {
  id?: string;
  docType: IdentityDocTypeCode; // "6" para RUC
  docNumber: string;
  name: string; // Razón Social
  tradeName?: string;
  isHabido?: boolean;
  isActive?: boolean;
  address?: string;
  email?: string;
}

export interface PurchaseItemInput {
  id?: string;
  description: string;
  quantity: number | string;
  unitValue: number | string; // Valor neto sin IGV
  taxDestination: PurchaseTaxDestination;
  classification?: PurchaseExpenseClassification;
  igvRate?: number | string; // Default: 0.18
}

export interface PurchaseCalculatedItem {
  id?: string;
  description: string;
  quantity: string;
  unitValue: string;
  netBase: string;
  igvAmount: string;
  totalAmount: string;
  taxDestination: PurchaseTaxDestination;
  classification: PurchaseExpenseClassification;
  hasFiscalCredit: boolean;
}

export interface DetractionData {
  hasDetraction: boolean;
  detractionCode?: string; // Código de servicio o bien según D.L. 940
  detractionPercentage?: number | string;
  detractionAmount?: number | string;
  depositDate?: string; // "YYYY-MM-DD"
  depositProofNumber?: string; // Número de constancia del Banco de la Nación
}

export interface PurchaseDocumentInput {
  companyRuc: string; // RUC de la empresa compradora
  supplier: SupplierProfile;
  docType: "01" | "03" | "07" | "08" | "50"; // 01: Factura, 03: Boleta, 07: NC, 08: ND, 50: DUA
  series: string; // Serie del emisor (ej. F001, E001)
  correlative: number | string; // Correlativo del emisor
  issueDate: string; // "YYYY-MM-DD"
  dueDate?: string; // "YYYY-MM-DD"
  accountingPeriod: string; // "YYYY-MM" Período en el que se anota en el RCE
  currency: CurrencyCode;
  exchangeRate?: number | string; // Requerido si currency === "USD"
  paymentMethod: "CONTADO" | "CREDITO";
  isBancarizado?: boolean; // True si se pagó mediante medio bancario (bancarización)
  bancarizacionMedium?: string; // Depósito en cuenta, transferencia, etc.
  detraction?: DetractionData;
  retentionApplied?: boolean;
  retentionAmount?: number | string;
  modifiedDocument?: {
    docType: "01" | "03" | "50";
    series: string;
    correlative: number | string;
    issueDate: string;
  };
  items: PurchaseItemInput[];
}

export interface PurchaseTotals {
  baseGravadaExclusiva: string; // Casilla 107
  igvGravadoExclusivo: string; // Casilla 108
  baseGravadaComun: string; // Casilla 110
  igvGravadoComun: string; // Casilla 111
  baseGravadaSinCredito: string; // Casilla 113
  igvGravadoSinCredito: string; // Casilla 114
  adquisicionesNoGravadas: string; // Exoneradas/Inafectas
  isc: string;
  icbper: string;
  otrosCargos: string;
  totalAdquisicion: string;
  totalCreditoFiscal: string; // Suma de IGV con derecho a crédito fiscal
}

export interface PurchaseDocumentRecord {
  id: string;
  car: string; // Código de Anotación de Registro de 27 caracteres
  companyRuc: string;
  accountingPeriod: string; // "YYYY-MM"
  supplier: SupplierProfile;
  docType: "01" | "03" | "07" | "08" | "50";
  series: string;
  correlative: string;
  fullNumber: string; // Serie-Correlativo
  issueDate: string;
  dueDate?: string;
  currency: CurrencyCode;
  exchangeRate?: string;
  paymentMethod: "CONTADO" | "CREDITO";
  isBancarizado: boolean;
  detraction?: DetractionData;
  canUseFiscalCredit: boolean;
  fiscalCreditRestrictionReason?: string;
  totals: PurchaseTotals;
  items: PurchaseCalculatedItem[];
  sireStatus: "PROPUESTA_PENDIENTE" | "ACEPTADO" | "COMPLEMENTADO" | "EXCLUIDO";
  createdAt: string;
}

export interface MonthlyPurchasesSummary {
  period: string;
  totalDocuments: number;
  baseGravadaExclusivaTotal: string;
  igvGravadoExclusivoTotal: string;
  baseGravadaComunTotal: string;
  igvGravadoComunTotal: string;
  baseGravadaSinCreditoTotal: string;
  igvGravadoSinCreditoTotal: string;
  adquisicionesNoGravadasTotal: string;
  totalAdquisiciones: string;
  totalCreditoFiscalAceptado: string;
}
