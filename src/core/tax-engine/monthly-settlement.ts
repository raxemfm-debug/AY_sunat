import { Decimal } from 'decimal.js';
import { MonthlyTaxSettlementInput, MonthlyTaxSettlementResult } from './types.js';
import { getTaxConfigForYear } from './tax-config.js';

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);
const CENT = 2;
const roundMoney = (value: Decimal) => value.toDecimalPlaces(CENT, Decimal.ROUND_HALF_UP);

/**
 * Calcula una pre-liquidación mensual RMT para uso interno y revisión humana.
 * No reemplaza el Formulario Virtual 621 ni presenta declaraciones ante SUNAT.
 *
 * Base legal principal: D.L. 1269, arts. 6-8; TUO Ley IGV D.S. 055-99-EF.
 * Advertencia: los pagos a cuenta RMT siguen reglas acumulativas y comparativas
 * específicas (coeficiente/1.5%, pagos previos, suspensión, cambios de régimen).
 * Esta primera versión implementa solo la ruta porcentual de 1%/1.5% con
 * acumulado anual de ingresos brutos netos y créditos ingresados explícitamente.
 * Validar el algoritmo contra el Formulario 621 y un contador antes de producción.
 */
export function calculateMonthlySettlement(
  input: MonthlyTaxSettlementInput,
): MonthlyTaxSettlementResult {
  const [yearText, monthText] = input.period.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!/^\d{4}-\d{2}$/.test(input.period) || month < 1 || month > 12) {
    throw new Error(`Período inválido: ${input.period}. Use YYYY-MM.`);
  }

  const config = getTaxConfigForYear(year);
  const uit = new Decimal(config.uitValue);
  const limit = uit.mul(config.rmtThresholdUit);

  const accumulatedBefore = new Decimal(input.accumulatedNetRevenueBeforePeriod);
  const salesBase = new Decimal(input.salesTaxableBase);
  const salesIgv = new Decimal(input.salesIgv);
  const purchasesBase = new Decimal(input.purchasesTaxableBase);
  const purchasesIgv = new Decimal(input.purchasesIgv);
  const previousIgvCredit = new Decimal(input.previousFiscalCreditBalance ?? 0);
  const previousIncomeCredit = new Decimal(input.previousIncomeTaxCreditBalance ?? 0);
  const values = [accumulatedBefore, salesBase, salesIgv, purchasesBase, purchasesIgv, previousIgvCredit, previousIncomeCredit];
  if (values.some((value) => !value.isFinite() || value.isNegative())) {
    throw new Error('Los importes y saldos no pueden ser negativos ni inválidos.');
  }

  const accumulatedRevenue = accumulatedBefore.plus(salesBase);
  const supero300Uit = accumulatedRevenue.gt(limit);
  const rate = supero300Uit ? new Decimal(config.rmtMonthlyRateHigh) : new Decimal(config.rmtMonthlyRateLow);
  const rateLabel = supero300Uit ? '1.5%' : '1.0%';

  const igvNet = salesIgv.minus(purchasesIgv).minus(previousIgvCredit);
  const igvDeterminado = Decimal.max(ZERO, roundMoney(igvNet));
  const igvPagar = igvDeterminado;
  const newIgvCredit = Decimal.max(ZERO, roundMoney(igvNet.negated()));

  const incomePayment = roundMoney(salesBase.mul(rate));
  const incomeTaxPayable = Decimal.max(ZERO, incomePayment.minus(previousIncomeCredit));
  const newIncomeCredit = Decimal.max(ZERO, previousIncomeCredit.minus(incomePayment));

  return {
    regimenName: 'Régimen Mype Tributario',
    regimeName: 'Régimen Mype Tributario',
    period: input.period,
    regime: 'RMT',
    uitApplicable: uit.toFixed(2),
    ventasGravadas: roundMoney(salesBase).toFixed(2),
    debitoFiscalIgv: roundMoney(salesIgv).toFixed(2),
    comprasGravadas: roundMoney(purchasesBase).toFixed(2),
    creditoFiscalIgv: roundMoney(purchasesIgv).toFixed(2),
    subtotalIgvPeriodo: roundMoney(salesIgv.minus(purchasesIgv)).toFixed(2),
    saldoFavorIgvAnterior: roundMoney(previousIgvCredit).toFixed(2),
    igvDeterminado: igvDeterminado.toFixed(2),
    igvPagar: igvPagar.toFixed(2),
    nuevoSaldoFavorIgvMesSiguiente: newIgvCredit.toFixed(2),
    ingresosNetosMes: roundMoney(salesBase).toFixed(2),
    ingresosNetosAcumulados: roundMoney(accumulatedRevenue).toFixed(2),
    limite300UitMonto: roundMoney(limit).toFixed(2),
    supero300Uit,
    tasaRentaAplicada: rateLabel,
    cuotaRentaCalculada: incomePayment.toFixed(2),
    saldoFavorRentaAnterior: roundMoney(previousIncomeCredit).toFixed(2),
    rentaPagar: roundMoney(incomeTaxPayable).toFixed(2),
    nuevoSaldoFavorRentaMesSiguiente: roundMoney(newIncomeCredit).toFixed(2),
    totalTributosAPagar: roundMoney(igvPagar.plus(incomeTaxPayable)).toFixed(2),
  };
}
