/**
 * PRELIQUIDACIÓN DEL FORMULARIO VIRTUAL 621 (IGV - RENTA MENSUAL)
 *
 * Uso interno y de revisión. No presenta declaraciones ante SUNAT.
 * Los números de casilla son referenciales: confirmarlos con la versión
 * vigente del Formulario Virtual 621 antes de trasladar importes.
 */
import { CurrencyCode, TaxRegimeCode } from '../../core/tax-engine/types.js';
import { PurchaseDocumentRecord } from '../purchases/types.js';

/** Estados de un CPE emitido que NO deben computarse en el período. */
export const PDT621_EXCLUDED_SALE_STATUSES = [
  'BORRADOR',
  'CALCULADO',
  'RECHAZADO',
  'DE_BAJA',
  'ANULADO',
] as const;

export interface Pdt621SaleDocument {
  cpeType: '01' | '03' | '07';
  series: string;
  correlative: number | string;
  issueDate: string; // YYYY-MM-DD
  status: string;
  currency: CurrencyCode;
  exchangeRate?: number | string; // Obligatorio si currency === 'USD'
  taxableBase: number | string; // Valor de venta gravado (sin IGV)
  igvAmount: number | string;
  exoneratedAmount?: number | string;
  inaffectedAmount?: number | string;
  exportAmount?: number | string;
}

export interface Pdt621Input {
  companyRuc: string;
  regime: TaxRegimeCode;
  period: string; // YYYY-MM
  sales: Pdt621SaleDocument[];
  purchases: PurchaseDocumentRecord[];
  /** Ingresos netos acumulados del ejercicio ANTES de este período (para el umbral de 300 UIT). */
  accumulatedNetRevenueBeforePeriod: number | string;
  previousIgvCreditBalance?: number | string;
  previousIncomeTaxCreditBalance?: number | string;
  igvPerceptions?: number | string;
  igvRetentions?: number | string;
  /** Coeficiente de pagos a cuenta (RG, o RMT tras superar 300 UIT). */
  incomeTaxCoefficient?: number | string;
  /** Proporción de crédito fiscal (prorrata) de los últimos 12 meses, entre 0 y 1. */
  prorrataCoefficient?: number | string;
  customUit?: number | string;
}

export interface Pdt621SalesSection {
  documentsCounted: number;
  documentsExcluded: number;
  ventasGravadas: string; // 100
  igvVentasGravadas: string; // 101
  descuentosNotasCredito: string; // 102
  igvDescuentosNotasCredito: string; // 103
  ventasNetasGravadas: string;
  debitoFiscal: string;
  ventasNoGravadas: string; // exoneradas + inafectas
  exportaciones: string; // 106
}

export interface Pdt621PurchasesSection {
  documentsCounted: number;
  documentsExcluded: number;
  baseGravadaExclusiva: string; // 107
  igvGravadaExclusiva: string; // 108
  baseGravadaComun: string; // 110
  igvGravadaComun: string; // 111
  prorrataAplicada: string;
  igvComunConCredito: string;
  baseSinCredito: string;
  igvSinCredito: string;
  adquisicionesNoGravadas: string;
  creditoFiscal: string;
}

export interface Pdt621IgvSection {
  debitoFiscal: string;
  creditoFiscal: string;
  impuestoResultante: string;
  saldoFavorAnterior: string;
  tributoTrasSaldo: string;
  percepcionesAplicadas: string;
  retencionesAplicadas: string;
  igvAPagar: string; // 189
  nuevoSaldoFavorIgv: string;
  percepcionesPorArrastrar: string;
  retencionesPorArrastrar: string;
}

export interface Pdt621IncomeTaxSection {
  method: 'RMT_TASA' | 'RMT_COEFICIENTE' | 'RER_CUOTA' | 'RG_COEFICIENTE' | 'RG_TASA';
  ingresosNetosMes: string; // 301
  ingresosNetosAcumulados: string;
  limite300Uit: string;
  supero300Uit: boolean;
  tasaAplicada: string; // decimal, ej. "0.0100"
  tasaAplicadaLabel: string;
  cuotaCalculada: string;
  saldoFavorAnterior: string;
  rentaAPagar: string; // 307
  nuevoSaldoFavorRenta: string;
}

export interface Pdt621Result {
  isPreliminary: true;
  companyRuc: string;
  period: string;
  regime: TaxRegimeCode;
  regimeName: string;
  uit: string;
  ventas: Pdt621SalesSection;
  compras: Pdt621PurchasesSection;
  igv: Pdt621IgvSection;
  renta: Pdt621IncomeTaxSection;
  totalAPagar: string;
  /** Casillas referenciales → importe. Confirmar numeración con el FV 621 vigente. */
  casillas: Record<string, string>;
  warnings: string[];
}
