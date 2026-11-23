import { TaxRegimeCode, TaxRegimeMetadata } from './types.js';
import { getTaxRegimeConfig, TAX_REGIMES } from './tax-config.js';

export const INITIAL_TAX_REGIME_OPTIONS: TaxRegimeMetadata[] = Object.values(TAX_REGIMES);

export interface InitialTaxSetup {
  taxpayerType: 'PERSONA_NATURAL_CON_NEGOCIO' | 'PERSONA_JURIDICA';
  regime: TaxRegimeCode;
  configuredAt: string;
}

export function createInitialTaxSetup(
  taxpayerType: InitialTaxSetup['taxpayerType'],
  regime: TaxRegimeCode | undefined,
): InitialTaxSetup {
  if (!regime) {
    throw new Error('Selecciona el régimen tributario vigente antes de continuar. No hay un régimen predeterminado.');
  }
  getTaxRegimeConfig(regime);
  return {
    taxpayerType,
    regime,
    configuredAt: new Date().toISOString(),
  };
}
