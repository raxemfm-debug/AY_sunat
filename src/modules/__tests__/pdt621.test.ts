import { beforeEach, describe, expect, it } from 'vitest';
import { PurchaseService } from '../purchases/purchase-service.js';
import { PurchaseDocumentInput } from '../purchases/types.js';
import { calculatePdt621, Pdt621Input, Pdt621SaleDocument, saleFromSireCpe } from '../pdt621/index.js';

const RUC = '10445533811';
const PERIOD = '2026-03';

const sale = (over: Partial<Pdt621SaleDocument>): Pdt621SaleDocument => ({
  cpeType: '01',
  series: 'F001',
  correlative: 1,
  issueDate: '2026-03-10',
  status: 'ACEPTADO',
  currency: 'PEN',
  taxableBase: '0.00',
  igvAmount: '0.00',
  ...over,
});

const baseSales: Pdt621SaleDocument[] = [
  sale({ correlative: 1, taxableBase: '10000.00', igvAmount: '1800.00' }),
  sale({ cpeType: '03', series: 'B001', correlative: 1, taxableBase: '2000.00', igvAmount: '360.00' }),
  sale({ cpeType: '07', series: 'FC01', correlative: 1, taxableBase: '1000.00', igvAmount: '180.00' }),
  sale({ correlative: 2, status: 'DE_BAJA', taxableBase: '9999.00', igvAmount: '1799.82' }),
  sale({ correlative: 3, status: 'RECHAZADO', taxableBase: '5000.00', igvAmount: '900.00' }),
];

describe('Preliquidación Formulario Virtual 621 (IGV - Renta mensual)', () => {
  let purchases: PurchaseService;

  const purchase = (over: Partial<PurchaseDocumentInput> & Pick<PurchaseDocumentInput, 'correlative' | 'items'>) =>
    purchases.registerPurchase({
      companyRuc: RUC,
      supplier: { docType: '6', docNumber: '20123456786', name: 'PROVEEDOR CENTRAL S.A.C.' },
      docType: '01',
      series: 'F001',
      issueDate: '2026-03-05',
      accountingPeriod: PERIOD,
      currency: 'PEN',
      paymentMethod: 'CONTADO',
      isBancarizado: true,
      ...over,
    });

  const input = (over: Partial<Pdt621Input> = {}): Pdt621Input => ({
    companyRuc: RUC,
    regime: 'RMT',
    period: PERIOD,
    sales: baseSales,
    purchases: purchases.listByPeriod(PERIOD, RUC),
    accumulatedNetRevenueBeforePeriod: '0.00',
    ...over,
  });

  beforeEach(() => {
    purchases = new PurchaseService();
  });

  describe('1. Ventas (RVIE)', () => {
    it('suma facturas y boletas, resta notas de crédito y excluye comprobantes de baja o rechazados', () => {
      const r = calculatePdt621(input());
      expect(r.ventas.documentsCounted).toBe(3);
      expect(r.ventas.documentsExcluded).toBe(2);
      expect(r.ventas.ventasGravadas).toBe('12000.00');
      expect(r.ventas.igvVentasGravadas).toBe('2160.00');
      expect(r.ventas.descuentosNotasCredito).toBe('1000.00');
      expect(r.ventas.ventasNetasGravadas).toBe('11000.00');
      expect(r.ventas.debitoFiscal).toBe('1980.00');
    });

    it('convierte a soles las ventas en dólares con su tipo de cambio', () => {
      const r = calculatePdt621(input({
        sales: [sale({ currency: 'USD', exchangeRate: '3.750', taxableBase: '1000.00', igvAmount: '180.00' })],
      }));
      expect(r.ventas.ventasGravadas).toBe('3750.00');
      expect(r.ventas.debitoFiscal).toBe('675.00');
    });

    it('rechaza ventas en dólares sin tipo de cambio', () => {
      expect(() => calculatePdt621(input({
        sales: [sale({ currency: 'USD', taxableBase: '100.00', igvAmount: '18.00' })],
      }))).toThrow(/tipo de cambio/);
    });

    it('excluye y advierte comprobantes con fecha fuera del período', () => {
      const r = calculatePdt621(input({
        sales: [sale({ issueDate: '2026-02-28', taxableBase: '500.00', igvAmount: '90.00' })],
      }));
      expect(r.ventas.ventasGravadas).toBe('0.00');
      expect(r.warnings.join(' ')).toMatch(/fuera del período/);
    });

    it('acepta comprobantes en formato SIRE mediante el adaptador', () => {
      const r = calculatePdt621(input({
        sales: [saleFromSireCpe({
          companyRuc: RUC, cpeType: '01', series: 'F001', correlative: 9, issueDate: '2026-03-20',
          currency: 'PEN', clientDocType: '6', clientDocNumber: '20123456786', clientName: 'CLIENTE SAC',
          taxableBase: '100.00', igvAmount: '18.00', totalAmount: '118.00', status: 'ACEPTADO',
        })],
      }));
      expect(r.casillas['100']).toBe('100.00');
      expect(r.casillas['101']).toBe('18.00');
    });
  });

  describe('2. Compras (RCE) y crédito fiscal', () => {
    it('toma el crédito fiscal de compras exclusivas del registro de compras', () => {
      purchase({ correlative: 10, items: [{ description: 'Mercadería', quantity: 1, unitValue: '5000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const r = calculatePdt621(input());
      expect(r.compras.documentsCounted).toBe(1);
      expect(r.casillas['107']).toBe('5000.00');
      expect(r.casillas['108']).toBe('900.00');
      expect(r.igv.igvAPagar).toBe('1080.00');
    });

    it('excluye compras de otro período o marcadas como EXCLUIDO en SIRE', () => {
      purchase({ correlative: 11, accountingPeriod: '2026-04', items: [{ description: 'A', quantity: 1, unitValue: '1000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const excl = purchase({ correlative: 12, items: [{ description: 'B', quantity: 1, unitValue: '1000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      purchases.updateSireStatus(excl.car, 'EXCLUIDO');
      const r = calculatePdt621(input({ purchases: [...purchases.listByPeriod('2026-04', RUC), ...purchases.listByPeriod(PERIOD, RUC)] }));
      expect(r.compras.documentsCounted).toBe(0);
      expect(r.compras.creditoFiscal).toBe('0.00');
    });

    it('no otorga crédito fiscal a compras sin bancarizar por encima del umbral', () => {
      purchase({ correlative: 13, isBancarizado: false, items: [{ description: 'Equipo', quantity: 1, unitValue: '3000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const r = calculatePdt621(input());
      expect(r.compras.creditoFiscal).toBe('0.00');
      expect(r.compras.igvSinCredito).toBe('540.00');
    });

    it('resta las notas de crédito recibidas del crédito fiscal', () => {
      purchase({ correlative: 14, items: [{ description: 'Compra', quantity: 1, unitValue: '2000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      purchase({ correlative: 1, docType: '07', series: 'FC01', items: [{ description: 'Devolución', quantity: 1, unitValue: '500.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const r = calculatePdt621(input());
      expect(r.compras.baseGravadaExclusiva).toBe('1500.00');
      expect(r.compras.creditoFiscal).toBe('270.00');
    });

    it('aplica la prorrata informada a las compras de destino común', () => {
      purchase({ correlative: 15, items: [{ description: 'Alquiler', quantity: 1, unitValue: '1000.00', taxDestination: 'GRAVADO_COMUN' }] });
      const r = calculatePdt621(input({ prorrataCoefficient: '0.6' }));
      expect(r.compras.igvGravadaComun).toBe('180.00');
      expect(r.compras.igvComunConCredito).toBe('108.00');
      expect(r.casillas['111']).toBe('108.00');
    });

    it('estima la prorrata con el período y advierte cuando no se informa', () => {
      purchase({ correlative: 16, items: [{ description: 'Alquiler', quantity: 1, unitValue: '1000.00', taxDestination: 'GRAVADO_COMUN' }] });
      const r = calculatePdt621(input({
        sales: [
          sale({ taxableBase: '6000.00', igvAmount: '1080.00' }),
          sale({ correlative: 2, exoneratedAmount: '4000.00' }),
        ],
      }));
      expect(r.compras.prorrataAplicada).toBe('0.6000');
      expect(r.compras.igvComunConCredito).toBe('108.00');
      expect(r.warnings.join(' ')).toMatch(/últimos 12 meses/);
    });
  });

  describe('3. Determinación del IGV', () => {
    it('genera saldo a favor cuando el crédito supera al débito', () => {
      purchase({ correlative: 20, items: [{ description: 'Inventario', quantity: 1, unitValue: '20000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const r = calculatePdt621(input());
      expect(r.igv.impuestoResultante).toBe('-1620.00');
      expect(r.igv.igvAPagar).toBe('0.00');
      expect(r.igv.nuevoSaldoFavorIgv).toBe('1620.00');
    });

    it('aplica el saldo a favor del mes anterior', () => {
      const r = calculatePdt621(input({ previousIgvCreditBalance: '500.00' }));
      expect(r.igv.igvAPagar).toBe('1480.00');
      expect(r.igv.nuevoSaldoFavorIgv).toBe('0.00');
    });

    it('aplica percepciones y retenciones y arrastra el exceso', () => {
      purchase({ correlative: 21, items: [{ description: 'Mercadería', quantity: 1, unitValue: '5000.00', taxDestination: 'GRAVADO_EXCLUSIVO' }] });
      const r = calculatePdt621(input({ igvPerceptions: '500.00', igvRetentions: '800.00' }));
      expect(r.igv.percepcionesAplicadas).toBe('500.00');
      expect(r.igv.retencionesAplicadas).toBe('580.00');
      expect(r.igv.igvAPagar).toBe('0.00');
      expect(r.igv.retencionesPorArrastrar).toBe('220.00');
    });
  });

  describe('4. Pago a cuenta de renta por régimen', () => {
    it('RMT: aplica 1% mientras los ingresos acumulados no superen 300 UIT', () => {
      const r = calculatePdt621(input());
      expect(r.renta.method).toBe('RMT_TASA');
      expect(r.renta.tasaAplicadaLabel).toBe('1%');
      expect(r.casillas['301']).toBe('11000.00');
      expect(r.casillas['307']).toBe('110.00');
      expect(r.totalAPagar).toBe('2090.00');
    });

    it('RMT: aplica 1.5% al superar 300 UIT (UIT 2026 = S/ 5,500)', () => {
      const r = calculatePdt621(input({ accumulatedNetRevenueBeforePeriod: '1645000.00' }));
      expect(r.renta.limite300Uit).toBe('1650000.00');
      expect(r.renta.supero300Uit).toBe(true);
      expect(r.renta.rentaAPagar).toBe('165.00');
    });

    it('RMT: usa el coeficiente informado tras superar 300 UIT', () => {
      const r = calculatePdt621(input({ accumulatedNetRevenueBeforePeriod: '1700000.00', incomeTaxCoefficient: '0.0200' }));
      expect(r.renta.method).toBe('RMT_COEFICIENTE');
      expect(r.renta.rentaAPagar).toBe('220.00');
    });

    it('RMT: compensa el saldo a favor de renta del mes anterior', () => {
      const r = calculatePdt621(input({ previousIncomeTaxCreditBalance: '150.00' }));
      expect(r.renta.rentaAPagar).toBe('0.00');
      expect(r.renta.nuevoSaldoFavorRenta).toBe('40.00');
    });

    it('RER: cuota de 1.5% cancelatoria sin aplicar saldos a favor', () => {
      const r = calculatePdt621(input({ regime: 'RER', previousIncomeTaxCreditBalance: '100.00' }));
      expect(r.renta.method).toBe('RER_CUOTA');
      expect(r.renta.rentaAPagar).toBe('165.00');
      expect(r.warnings.join(' ')).toMatch(/cancelatoria/);
    });

    it('RER: advierte al superar el límite de S/ 525,000', () => {
      const r = calculatePdt621(input({ regime: 'RER', accumulatedNetRevenueBeforePeriod: '520000.00' }));
      expect(r.warnings.join(' ')).toMatch(/525000/);
    });

    it('RG: usa el coeficiente informado', () => {
      const r = calculatePdt621(input({ regime: 'RG', incomeTaxCoefficient: '0.0250' }));
      expect(r.renta.method).toBe('RG_COEFICIENTE');
      expect(r.renta.rentaAPagar).toBe('275.00');
    });

    it('NRUS: rechaza la preliquidación porque no presenta el Formulario 621', () => {
      expect(() => calculatePdt621(input({ regime: 'NRUS' }))).toThrow(/NRUS no presenta/);
    });
  });

  describe('5. Validaciones de entrada', () => {
    it('rechaza períodos con formato inválido', () => {
      expect(() => calculatePdt621(input({ period: '2026-13' }))).toThrow(/Período inválido/);
    });

    it('rechaza RUC con dígito verificador inválido', () => {
      expect(() => calculatePdt621(input({ companyRuc: '10445533810' }))).toThrow(/RUC/);
    });

    it('rechaza importes negativos', () => {
      expect(() => calculatePdt621(input({ previousIgvCreditBalance: '-1' }))).toThrow(/no negativo/);
    });

    it('marca siempre el resultado como preliminar', () => {
      expect(calculatePdt621(input()).isPreliminary).toBe(true);
    });
  });
});
