import { describe, expect, it } from 'vitest';
import { calculateCpe, calculateMonthlySettlement, numberToWordsPeru } from '../index.js';

const baseCpe = {
  company: {
    ruc: '10445533811',
    legalName: 'Jose Barrientos',
    taxRegime: 'MYPE_TRIBUTARIO' as const,
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
