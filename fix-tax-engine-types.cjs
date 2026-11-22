#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();

console.log('Aplicando correcciones en:', root);

// 1. Asegurar initial-setup.ts
const setupPath = path.join(root, 'src/core/tax-engine/initial-setup.ts');
const setupContent = `import { TaxRegimeCode, TaxRegimeMetadata } from './types.js';
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
`;
fs.writeFileSync(setupPath, setupContent, 'utf8');
console.log('[OK] src/core/tax-engine/initial-setup.ts verificado');

// 2. Asegurar re-export en src/core/tax-engine/index.ts
const indexPath = path.join(root, 'src/core/tax-engine/index.ts');
let indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
if (!indexContent.includes('./initial-setup.js')) {
  indexContent += "\nexport * from './initial-setup.js';\n";
  fs.writeFileSync(indexPath, indexContent.trim() + '\n', 'utf8');
}
console.log('[OK] src/core/tax-engine/index.ts actualizado');

// 3. Normalizar types.ts con regimeName y regimenName
const typesPath = path.join(root, 'src/core/tax-engine/types.ts');
if (fs.existsSync(typesPath)) {
  let typesContent = fs.readFileSync(typesPath, 'utf8');
  typesContent = typesContent.replace(/export interface MonthlyTaxSettlementResult \{[\s\S]*?\n\}/, (match) => {
    let cleaned = match;
    cleaned = cleaned.replace(/\s*regimen?Name\??:\s*string;?/g, '');
    cleaned = cleaned.replace('regime: TaxRegimeCode;', 'regime: TaxRegimeCode;\n  regimeName: string;\n  regimenName: string;');
    return cleaned;
  });
  fs.writeFileSync(typesPath, typesContent, 'utf8');
  console.log('[OK] src/core/tax-engine/types.ts verificado');
}

// 4. Corregir return en monthly-settlement.ts
const msPath = path.join(root, 'src/core/tax-engine/monthly-settlement.ts');
if (fs.existsSync(msPath)) {
  let msContent = fs.readFileSync(msPath, 'utf8');
  msContent = msContent.replace(/return\s*\{([\s\S]*?)\};/, (match, body) => {
    let newBody = body;
    if (!newBody.includes('regimeName:')) {
      newBody = '\n    regimeName: regimeConfig.name,' + newBody;
    }
    if (!newBody.includes('regimenName:')) {
      newBody = '\n    regimenName: regimeConfig.name,' + newBody;
    }
    return `return {${newBody}};`;
  });
  fs.writeFileSync(msPath, msContent, 'utf8');
  console.log('[OK] src/core/tax-engine/monthly-settlement.ts actualizado');
}

// 5. Corregir tax-engine.test.ts con regime: RMT
const testPath = path.join(root, 'src/core/tax-engine/__tests__/tax-engine.test.ts');
const testContent = `import { describe, expect, it } from 'vitest';
import { calculateCpe, calculateMonthlySettlement, numberToWordsPeru, createInitialTaxSetup, INITIAL_TAX_REGIME_OPTIONS } from '../index.js';

const baseCpe = {
  company: {
    ruc: '10445533811',
    legalName: 'Jose Barrientos',
    taxRegime: 'RMT' as const,
    address: { ubigeo: '150101', department: 'Lima', province: 'Lima', district: 'Lima', addressLine: 'Av. Ejemplo 123' },
  },
  client: { docType: '1' as const, docNumber: '12345678', name: 'Cliente Ejemplo' },
  cpeType: '03' as const,
  series: 'B001',
  correlative: 1,
  issueDate: '2026-01-15',
  currency: 'PEN' as const,
  paymentMethod: 'CONTADO' as const,
  items: [{ description: 'Servicio profesional', quantity: '1', unitPrice: '118.00', priceIncludesIgv: true, affectationType: '10' as const }],
};

describe('Cálculo de comprobantes electrónicos', () => {
  it('extrae base e IGV desde precio con IGV incluido', () => {
    const result = calculateCpe(baseCpe);
    expect(result.items[0].baseAmount).toBe('100.00');
    expect(result.items[0].igvAmount).toBe('18.00');
    expect(result.totals.totalPagar).toBe('118.00');
    expect(result.header.fullNumber).toBe('B001-00000001');
  });

  it('calcula precio con IGV no incluido', () => {
    const result = calculateCpe({
      ...baseCpe,
      items: [{ ...baseCpe.items[0], unitPrice: '100.00', priceIncludesIgv: false }],
    });
    expect(result.items[0].igvAmount).toBe('18.00');
    expect(result.totals.totalPagar).toBe('118.00');
  });

  it('rechaza un RUC inválido', () => {
    expect(() => calculateCpe({
      ...baseCpe,
      company: { ...baseCpe.company, ruc: '20100000000' },
    })).toThrow(/dígito verificador/);
  });
});

describe('Preliquidación mensual RMT', () => {
  it('aplica 1% antes de superar 300 UIT e IGV neto', () => {
    const result = calculateMonthlySettlement({
      period: '2026-01',
      regime: 'RMT',
      accumulatedNetRevenueBeforePeriod: '0',
      salesTaxableBase: '10000',
      salesIgv: '1800',
      purchasesTaxableBase: '2000',
      purchasesIgv: '360',
    });
    expect(result.tasaRentaAplicada).toBe('1.0%');
    expect(result.rentaPagar).toBe('100.00');
    expect(result.igvPagar).toBe('1440.00');
    expect(result.totalTributosAPagar).toBe('1540.00');
  });

  it('aplica 1.5% cuando los ingresos acumulados exceden 300 UIT', () => {
    const result = calculateMonthlySettlement({
      period: '2026-01',
      regime: 'RMT',
      accumulatedNetRevenueBeforePeriod: '1600000',
      salesTaxableBase: '100000',
      salesIgv: '0',
      purchasesTaxableBase: '0',
      purchasesIgv: '0',
    });
    expect(result.supero300Uit).toBe(true);
    expect(result.tasaRentaAplicada).toBe('1.5%');
    expect(result.rentaPagar).toBe('1500.00');
  });

  it('mantiene saldo a favor de IGV cuando el crédito supera débito', () => {
    const result = calculateMonthlySettlement({
      period: '2026-02',
      regime: 'RMT',
      accumulatedNetRevenueBeforePeriod: '0',
      salesTaxableBase: '1000',
      salesIgv: '180',
      purchasesTaxableBase: '2000',
      purchasesIgv: '360',
    });
    expect(result.igvPagar).toBe('0.00');
    expect(result.nuevoSaldoFavorIgvMesSiguiente).toBe('180.00');
  });
});

describe('Importe en letras', () => {
  it('convierte PEN a texto', () => {
    expect(numberToWordsPeru('118.50', 'PEN')).toBe('SON: CIENTO DIECIOCHO CON 50/100 SOLES');
  });
});

describe('Configuración inicial del régimen tributario', () => {
  it('no asigna régimen por defecto y exige selección explícita', () => {
    expect(INITIAL_TAX_REGIME_OPTIONS.map((option) => option.code)).toEqual(['RMT', 'RER', 'RG', 'NRUS']);
    expect(() => createInitialTaxSetup('PERSONA_NATURAL_CON_NEGOCIO', undefined)).toThrow(/No hay un régimen predeterminado/);
  });

  it('guarda el régimen seleccionado explícitamente', () => {
    const setup = createInitialTaxSetup('PERSONA_NATURAL_CON_NEGOCIO', 'RER');
    expect(setup.regime).toBe('RER');
    expect(setup.taxpayerType).toBe('PERSONA_NATURAL_CON_NEGOCIO');
  });

  it('bloquea comprobantes no permitidos por el NRUS', () => {
    expect(() => calculateCpe({
      ...baseCpe,
      company: { ...baseCpe.company, taxRegime: 'NRUS' },
      cpeType: '01',
      series: 'F001',
    })).toThrow(/no permite emitir/);
  });
});
`;
fs.writeFileSync(testPath, testContent, 'utf8');
console.log('[OK] src/core/tax-engine/__tests__/tax-engine.test.ts actualizado');

console.log('\\n¡Listo! Ejecuta ahora: npm run typecheck && npm test');
