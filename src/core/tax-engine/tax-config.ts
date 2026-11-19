import { TaxRegimeCode, TaxRegimeMetadata, TaxYearConfig } from './types.js';

/**
 * CATÁLOGO OFICIAL DE REGÍMENES TRIBUTARIOS PERUANOS (SUNAT)
 */
export const TAX_REGIMES: Record<TaxRegimeCode, TaxRegimeMetadata> = {
  RMT: {
    code: 'RMT',
    name: 'Régimen MYPE Tributario',
    description: 'Para micro y pequeñas empresas con ingresos netos anuales de hasta 1,700 UIT.',
    legalBase: 'Decreto Legislativo N° 1269',
    allowedCpeTypes: ['01', '03', '07'],
    requiresAnnualDeclaration: true,
    incomeTaxType: 'PAGO_A_CUENTA_ESCALONADO',
    maxAnnualRevenueUit: 1700,
  },
  RER: {
    code: 'RER',
    name: 'Régimen Especial de Renta',
    description: 'Para personas con negocio y empresas con ingresos netos anuales de hasta S/ 525,000.',
    legalBase: 'TUO de la Ley del Impuesto a la Renta (D.S. N° 179-2004-EF), arts. 117-124',
    allowedCpeTypes: ['01', '03', '07'],
    requiresAnnualDeclaration: false,
    incomeTaxType: 'CUOTA_CANCELATORIA_FIJA',
    maxAnnualRevenuePen: 525000,
  },
  RG: {
    code: 'RG',
    name: 'Régimen General',
    description: 'Sin límite de ingresos; obligatorio para medianas y grandes empresas o actividades excluidas.',
    legalBase: 'TUO de la Ley del Impuesto a la Renta (D.S. N° 179-2004-EF)',
    allowedCpeTypes: ['01', '03', '07'],
    requiresAnnualDeclaration: true,
    incomeTaxType: 'PAGO_A_CUENTA_COEFICIENTE',
  },
  NRUS: {
    code: 'NRUS',
    name: 'Nuevo Régimen Único Simplificado',
    description: 'Para pequeños comerciantes y prestadores de oficios. Solo emite boletas de venta y tickets.',
    legalBase: 'Decreto Legislativo N° 937',
    allowedCpeTypes: ['03'],
    requiresAnnualDeclaration: false,
    incomeTaxType: 'CUOTA_FIJA_MENSUAL',
    maxAnnualRevenuePen: 96000,
  },
};

export function getTaxRegimeConfig(regime: TaxRegimeCode): TaxRegimeMetadata {
  const config = TAX_REGIMES[regime];
  if (!config) {
    throw new Error(`Régimen tributario no soportado: '${regime}'. Debe seleccionar explícitamente: RMT, RER, RG o NRUS.`);
  }
  return config;
}

/**
 * CONFIGURACIÓN NORMATIVA TRIBUTARIA POR EJERCICIO FISCAL
 */
export const TAX_YEAR_CONFIGS: Record<number, TaxYearConfig> = {
  2024: {
    year: 2024,
    uitValue: '5150.00',
    igvRate: '0.18',
    rmtMonthlyRateLow: '0.01',
    rmtMonthlyRateHigh: '0.015',
    rmtThresholdUit: 300,
    rmtMaxRevenueUit: 1700,
    rerMonthlyRate: '0.015',
    rerMaxRevenuePen: 525000,
  },
  2025: {
    year: 2025,
    uitValue: '5350.00',
    igvRate: '0.18',
    rmtMonthlyRateLow: '0.01',
    rmtMonthlyRateHigh: '0.015',
    rmtThresholdUit: 300,
    rmtMaxRevenueUit: 1700,
    rerMonthlyRate: '0.015',
    rerMaxRevenuePen: 525000,
  },
  2026: {
    year: 2026,
    uitValue: '5500.00',
    igvRate: '0.18',
    rmtMonthlyRateLow: '0.01',
    rmtMonthlyRateHigh: '0.015',
    rmtThresholdUit: 300,
    rmtMaxRevenueUit: 1700,
    rerMonthlyRate: '0.015',
    rerMaxRevenuePen: 525000,
  },
};

export function getTaxConfigForYear(year: number, customUit?: number | string): TaxYearConfig {
  const base = TAX_YEAR_CONFIGS[year] ?? TAX_YEAR_CONFIGS[2026];
  if (customUit !== undefined) {
    return {
      ...base,
      uitValue: String(customUit),
    };
  }
  return base;
}
