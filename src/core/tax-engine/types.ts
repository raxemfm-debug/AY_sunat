/**
 * TIPOS Y DEFINICIONES NORMATIVAS - SUNAT PERÚ
 * Sistema de Emisión Electrónica (SEE) UBL 2.1 y Regímenes Tributarios
 */

// Catálogo 01: Tipo de Documento CPE
export type CpeTypeCode = '01' | '03' | '07'; // 01: Factura, 03: Boleta de Venta, 07: Nota de Crédito

// Catálogo 06: Tipo de Documento de Identidad
export type IdentityDocTypeCode = 
  | '1' // DNI (8 dígitos)
  | '4' // Carnet de Extranjería (hasta 12 dígitos)
  | '6' // RUC (11 dígitos)
  | '7' // Pasaporte (hasta 12 dígitos)
  | '0'; // Documento no domiciliado / Sin documento

// Catálogo 07: Tipo de Afectación al IGV
export type IgvAffectationCode =
  | '10' // Gravado - Operación Onerosa
  | '11' | '12' | '13' | '14' | '15' | '16' | '17'
  | '20' | '21'
  | '30' | '31' | '32' | '33' | '34' | '35' | '36'
  | '40'; // Exportación

// Catálogo 09: Tipos de Nota de Crédito Electrónica
export type CreditNoteTypeCode =
  | '01' | '02' | '03' | '04' | '05' | '06' | '07'
  | '08' | '09' | '10' | '11' | '12' | '13';

// Regímenes tributarios SUNAT para personas y empresas
export type TaxRegimeCode =
  | 'RMT'  // Régimen MYPE Tributario (D.L. 1269)
  | 'RER'  // Régimen Especial de Renta (TUO LIR arts. 117-124)
  | 'RG'   // Régimen General (TUO LIR)
  | 'NRUS'; // Nuevo Régimen Único Simplificado (D.L. 937)

export interface TaxRegimeMetadata {
  code: TaxRegimeCode;
  name: string;
  description: string;
  legalBase: string;
  allowedCpeTypes: CpeTypeCode[];
  requiresAnnualDeclaration: boolean;
  incomeTaxType:
    | 'PAGO_A_CUENTA_ESCALONADO'
    | 'CUOTA_CANCELATORIA_FIJA'
    | 'PAGO_A_CUENTA_COEFICIENTE'
    | 'CUOTA_FIJA_MENSUAL';
  maxAnnualRevenueUit?: number;
  maxAnnualRevenuePen?: number;
}

export type CurrencyCode = 'PEN' | 'USD';

export interface CompanyProfile {
  ruc: string;
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  address: {
    ubigeo: string;
    department: string;
    province: string;
    district: string;
    urbanization?: string;
    addressLine: string;
  };
  solCredentials?: {
    usuarioSol: string;
    claveSol: string;
  };
}

export interface ClientProfile {
  docType: IdentityDocTypeCode;
  docNumber: string;
  name: string;
  address?: string;
  email?: string;
}

export interface ItemCalculationInput {
  id?: string;
  code?: string;
  description: string;
  quantity: number | string;
  unitCode?: string;
  unitPrice: number | string;
  priceIncludesIgv: boolean;
  affectationType: IgvAffectationCode;
  discountPercentage?: number | string;
  discountAmount?: number | string;
}

export interface CalculatedItem {
  id?: string;
  code?: string;
  description: string;
  quantity: string;
  unitCode: string;
  unitValue: string;
  unitPrice: string;
  baseAmount: string;
  discountAmount: string;
  igvAmount: string;
  totalAmount: string;
  affectationType: IgvAffectationCode;
  isGratuitous: boolean;
  valueReferenceGratuitous?: string;
}

export interface CpeTotals {
  operacionesGravadas: string;
  operacionesExoneradas: string;
  operacionesInafectas: string;
  operacionesGratuitas: string;
  totalDescuentos: string;
  descuentoGlobal: string;
  montoIgv: string;
  subTotal: string;
  totalPagar: string;
  totalEnLetras: string;
}

export interface CreditNoteSpecificData {
  discrepancyCode: CreditNoteTypeCode;
  discrepancyReason: string;
  modifiedDocType: '01' | '03';
  modifiedDocSeries: string;
  modifiedDocCorrelative: number;
}

export interface CpeDocumentInput {
  company: CompanyProfile;
  client: ClientProfile;
  cpeType: CpeTypeCode;
  series: string;
  correlative: number;
  issueDate: string;
  issueTime?: string;
  currency: CurrencyCode;
  exchangeRate?: number | string;
  paymentMethod: 'CONTADO' | 'CREDITO';
  globalDiscountAmount?: number | string;
  items: ItemCalculationInput[];
  creditNoteInfo?: CreditNoteSpecificData;
}

export interface CpeDocumentCalculationResult {
  header: {
    cpeType: CpeTypeCode;
    series: string;
    correlative: number;
    fullNumber: string;
    issueDate: string;
    currency: CurrencyCode;
    exchangeRate?: string;
  };
  client: ClientProfile;
  items: CalculatedItem[];
  totals: CpeTotals;
  sunatXmlReadyPayload: Record<string, unknown>;
}

export interface TaxYearConfig {
  year: number;
  uitValue: number | string;
  igvRate: number | string;
  rmtMonthlyRateLow: number | string;
  rmtMonthlyRateHigh: number | string;
  rmtThresholdUit: number;
  rmtMaxRevenueUit: number;
  rerMonthlyRate: number | string;
  rerMaxRevenuePen: number;
}

export interface MonthlyTaxSettlementInput {
  period: string;
  regime: TaxRegimeCode;
  accumulatedNetRevenueBeforePeriod: number | string;
  salesTaxableBase: number | string;
  salesIgv: number | string;
  purchasesTaxableBase: number | string;
  purchasesIgv: number | string;
  previousFiscalCreditBalance?: number | string;
  previousIncomeTaxCreditBalance?: number | string;
  coefficientRg?: number | string;
}

export interface MonthlyTaxSettlementResult {
  period: string;
  regime: TaxRegimeCode;
  regimeName: string;
  regimenName: string;
  uitApplicable: string;
  ventasGravadas: string;
  debitoFiscalIgv: string;
  comprasGravadas: string;
  creditoFiscalIgv: string;
  subtotalIgvPeriodo: string;
  saldoFavorIgvAnterior: string;
  igvDeterminado: string;
  igvPagar: string;
  nuevoSaldoFavorIgvMesSiguiente: string;
  ingresosNetosMes: string;
  ingresosNetosAcumulados: string;
  tasaRentaAplicada: string;
  cuotaRentaCalculada: string;
  saldoFavorRentaAnterior: string;
  rentaPagar: string;
  nuevoSaldoFavorRentaMesSiguiente: string;
  totalTributosAPagar: string;
  limite300UitMonto?: string;
  supero300Uit?: boolean;
  warnings?: string[];
}
