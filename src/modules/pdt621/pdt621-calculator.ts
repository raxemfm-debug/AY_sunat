import { Decimal } from 'decimal.js';
import { getTaxConfigForYear, getTaxRegimeConfig } from '../../core/tax-engine/tax-config.js';
import { validateRuc } from '../../core/tax-engine/validators.js';
import { PurchaseDocumentRecord } from '../purchases/types.js';
import {
  PDT621_EXCLUDED_SALE_STATUSES,
  Pdt621Input,
  Pdt621IncomeTaxSection,
  Pdt621Result,
  Pdt621SaleDocument,
} from './types.js';

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const money = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (v: Decimal) => money(v).toFixed(2);
const pos = (v: Decimal) => Decimal.max(ZERO, v);

function toDecimal(value: number | string | undefined, field: string): Decimal {
  if (value === undefined || value === null || value === '') return ZERO;
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new Error(`Importe inválido en ${field}: '${value}'.`);
  }
  if (!d.isFinite() || d.isNegative()) {
    throw new Error(`Importe inválido en ${field}: debe ser un número no negativo.`);
  }
  return d;
}

function exchangeFactor(currency: string, rate: number | string | undefined, ref: string): Decimal {
  if (currency === 'PEN') return ONE;
  const fx = toDecimal(rate, `tipo de cambio de ${ref}`);
  if (fx.lte(0)) throw new Error(`El comprobante ${ref} está en ${currency} y requiere tipo de cambio positivo.`);
  return fx;
}

function isExcludedSale(status: string): boolean {
  return (PDT621_EXCLUDED_SALE_STATUSES as readonly string[]).includes(status.toUpperCase());
}

function validateInput(input: Pdt621Input): { year: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new Error(`Período inválido: '${input.period}'. Use YYYY-MM.`);
  }
  const rucErrors = validateRuc(input.companyRuc);
  if (rucErrors.length > 0) throw new Error(`RUC de la empresa inválido: ${rucErrors.join(', ')}`);
  getTaxRegimeConfig(input.regime);
  if (input.regime === 'NRUS') {
    throw new Error('El NRUS no presenta el Formulario 621: paga una cuota mensual fija (Formulario 1611).');
  }
  return { year: Number(input.period.slice(0, 4)) };
}

function summarizeSales(sales: Pdt621SaleDocument[], period: string, warnings: string[]) {
  let gravadas = ZERO, igvGravadas = ZERO, nc = ZERO, igvNc = ZERO;
  let noGravadas = ZERO, exportaciones = ZERO, ncNoGravadas = ZERO;
  let counted = 0, excluded = 0;

  for (const s of sales) {
    const ref = `${s.cpeType}-${s.series}-${s.correlative}`;
    if (isExcludedSale(s.status)) { excluded++; continue; }
    if (!s.issueDate.startsWith(period)) {
      warnings.push(`El comprobante ${ref} tiene fecha ${s.issueDate} fuera del período ${period}; se excluyó.`);
      excluded++;
      continue;
    }
    const fx = exchangeFactor(s.currency, s.exchangeRate, ref);
    const base = toDecimal(s.taxableBase, `${ref}.taxableBase`).mul(fx);
    const igv = toDecimal(s.igvAmount, `${ref}.igvAmount`).mul(fx);
    const noGrav = toDecimal(s.exoneratedAmount, `${ref}.exoneratedAmount`)
      .plus(toDecimal(s.inaffectedAmount, `${ref}.inaffectedAmount`)).mul(fx);
    const exp = toDecimal(s.exportAmount, `${ref}.exportAmount`).mul(fx);

    if (s.cpeType === '07') {
      nc = nc.plus(base);
      igvNc = igvNc.plus(igv);
      ncNoGravadas = ncNoGravadas.plus(noGrav).plus(exp);
    } else {
      gravadas = gravadas.plus(base);
      igvGravadas = igvGravadas.plus(igv);
      noGravadas = noGravadas.plus(noGrav);
      exportaciones = exportaciones.plus(exp);
    }
    counted++;
  }

  const netNoGravadas = noGravadas.minus(ncNoGravadas);
  if (netNoGravadas.isNegative()) {
    warnings.push('Las notas de crédito de operaciones no gravadas superan las ventas no gravadas del período.');
  }
  return {
    counted, excluded,
    gravadas: money(gravadas), igvGravadas: money(igvGravadas),
    nc: money(nc), igvNc: money(igvNc),
    netGravadas: money(gravadas.minus(nc)),
    debito: money(igvGravadas.minus(igvNc)),
    noGravadas: money(pos(netNoGravadas)),
    exportaciones: money(exportaciones),
  };
}

function summarizePurchases(purchases: PurchaseDocumentRecord[], input: Pdt621Input) {
  let bExc = ZERO, iExc = ZERO, bCom = ZERO, iCom = ZERO, bSin = ZERO, iSin = ZERO, noGrav = ZERO;
  let counted = 0, excluded = 0;

  for (const p of purchases) {
    if (p.accountingPeriod !== input.period || p.companyRuc !== input.companyRuc || p.sireStatus === 'EXCLUIDO') {
      excluded++;
      continue;
    }
    const fx = exchangeFactor(p.currency, p.exchangeRate, p.fullNumber);
    const sign = p.docType === '07' ? -1 : 1;
    const t = p.totals;
    const v = (x: string) => new Decimal(x).mul(fx).mul(sign);

    if (p.canUseFiscalCredit) {
      bExc = bExc.plus(v(t.baseGravadaExclusiva));
      iExc = iExc.plus(v(t.igvGravadoExclusivo));
      bCom = bCom.plus(v(t.baseGravadaComun));
      iCom = iCom.plus(v(t.igvGravadoComun));
      bSin = bSin.plus(v(t.baseGravadaSinCredito));
      iSin = iSin.plus(v(t.igvGravadoSinCredito));
    } else {
      bSin = bSin.plus(v(t.baseGravadaExclusiva)).plus(v(t.baseGravadaComun)).plus(v(t.baseGravadaSinCredito));
      iSin = iSin.plus(v(t.igvGravadoExclusivo)).plus(v(t.igvGravadoComun)).plus(v(t.igvGravadoSinCredito));
    }
    noGrav = noGrav.plus(v(t.adquisicionesNoGravadas));
    counted++;
  }
  return { counted, excluded, bExc, iExc, bCom, iCom, bSin, iSin, noGrav };
}

function resolveProrrata(
  input: Pdt621Input,
  hasCommon: boolean,
  sales: { netGravadas: Decimal; exportaciones: Decimal; noGravadas: Decimal },
  warnings: string[],
): Decimal {
  if (input.prorrataCoefficient !== undefined) {
    const p = toDecimal(input.prorrataCoefficient, 'prorrataCoefficient');
    if (p.gt(1)) throw new Error('La prorrata debe estar entre 0 y 1.');
    return p;
  }
  if (!hasCommon) return ONE;
  const gravadasYExport = pos(sales.netGravadas).plus(sales.exportaciones);
  const total = gravadasYExport.plus(sales.noGravadas);
  if (sales.noGravadas.isZero()) return ONE;
  warnings.push(
    'Hay compras de destino común y no se indicó la prorrata: se estimó solo con las ventas del período. ' +
      'La Ley del IGV exige calcularla con los últimos 12 meses; informe prorrataCoefficient.',
  );
  return total.isZero() ? ONE : gravadasYExport.div(total).toDecimalPlaces(4, Decimal.ROUND_DOWN);
}

function calculateIncomeTax(
  input: Pdt621Input,
  ingresosMes: Decimal,
  uit: Decimal,
  cfg: ReturnType<typeof getTaxConfigForYear>,
  warnings: string[],
): Pdt621IncomeTaxSection {
  const before = toDecimal(input.accumulatedNetRevenueBeforePeriod, 'accumulatedNetRevenueBeforePeriod');
  const accumulated = before.plus(ingresosMes);
  const limit300 = uit.mul(cfg.rmtThresholdUit);
  const supero300 = accumulated.gt(limit300);
  const coefficient = input.incomeTaxCoefficient !== undefined
    ? toDecimal(input.incomeTaxCoefficient, 'incomeTaxCoefficient')
    : undefined;

  let method: Pdt621IncomeTaxSection['method'];
  let rate: Decimal;
  switch (input.regime) {
    case 'RMT':
      if (!supero300) {
        method = 'RMT_TASA';
        rate = new Decimal(cfg.rmtMonthlyRateLow);
      } else if (coefficient && coefficient.gt(0)) {
        method = 'RMT_COEFICIENTE';
        rate = coefficient;
      } else {
        method = 'RMT_TASA';
        rate = new Decimal(cfg.rmtMonthlyRateHigh);
      }
      if (accumulated.gt(uit.mul(cfg.rmtMaxRevenueUit))) {
        warnings.push(`Los ingresos acumulados superan ${cfg.rmtMaxRevenueUit} UIT: corresponde evaluar el paso al Régimen General.`);
      }
      break;
    case 'RER':
      method = 'RER_CUOTA';
      rate = new Decimal(cfg.rerMonthlyRate);
      if (accumulated.gt(cfg.rerMaxRevenuePen)) {
        warnings.push(`Los ingresos acumulados superan S/ ${cfg.rerMaxRevenuePen}: el RER deja de ser aplicable.`);
      }
      break;
    default:
      if (coefficient && coefficient.gt(0)) {
        method = 'RG_COEFICIENTE';
        rate = coefficient;
      } else {
        method = 'RG_TASA';
        rate = new Decimal('0.015');
        warnings.push('Régimen General sin coeficiente informado: se aplicó 1.5%. Verifique el sistema de pagos a cuenta que corresponde.');
      }
  }

  const cuota = money(ingresosMes.mul(rate));
  // En el RER la cuota es cancelatoria: no se compensan saldos a favor de pagos a cuenta.
  const previous = input.regime === 'RER' ? ZERO : toDecimal(input.previousIncomeTaxCreditBalance, 'previousIncomeTaxCreditBalance');
  if (input.regime === 'RER' && input.previousIncomeTaxCreditBalance !== undefined && !new Decimal(input.previousIncomeTaxCreditBalance).isZero()) {
    warnings.push('En el RER la cuota es cancelatoria: no se aplicó el saldo a favor de renta informado.');
  }

  return {
    method,
    ingresosNetosMes: fmt(ingresosMes),
    ingresosNetosAcumulados: fmt(accumulated),
    limite300Uit: fmt(limit300),
    supero300Uit: supero300,
    tasaAplicada: rate.toFixed(4),
    tasaAplicadaLabel: `${rate.mul(100).toDecimalPlaces(2).toString()}%`,
    cuotaCalculada: fmt(cuota),
    saldoFavorAnterior: fmt(previous),
    rentaAPagar: fmt(pos(cuota.minus(previous))),
    nuevoSaldoFavorRenta: fmt(pos(previous.minus(cuota))),
  };
}

/**
 * Calcula la preliquidación del Formulario Virtual 621 a partir de los
 * comprobantes emitidos y del registro de compras del período.
 */
export function calculatePdt621(input: Pdt621Input): Pdt621Result {
  const { year } = validateInput(input);
  const warnings: string[] = [];
  const cfg = getTaxConfigForYear(year, input.customUit);
  const uit = new Decimal(cfg.uitValue);
  const regimeInfo = getTaxRegimeConfig(input.regime);

  // 1. Ventas
  const s = summarizeSales(input.sales, input.period, warnings);
  if (s.netGravadas.isNegative()) {
    warnings.push('Las notas de crédito superan las ventas gravadas del período: revise los comprobantes.');
  }

  // 2. Compras
  const p = summarizePurchases(input.purchases, input);
  const prorrata = resolveProrrata(input, !p.iCom.isZero(), s, warnings);
  const igvComunConCredito = money(p.iCom.mul(prorrata));
  const creditoFiscal = money(p.iExc.plus(igvComunConCredito));

  // 3. Determinación del IGV
  const saldoAnterior = toDecimal(input.previousIgvCreditBalance, 'previousIgvCreditBalance');
  const percepciones = toDecimal(input.igvPerceptions, 'igvPerceptions');
  const retenciones = toDecimal(input.igvRetentions, 'igvRetentions');

  const resultante = s.debito.minus(creditoFiscal);
  const trasSaldo = resultante.minus(saldoAnterior);
  const nuevoSaldoFavorIgv = pos(trasSaldo.negated());
  let pendiente = pos(trasSaldo);
  const percepcionesAplicadas = Decimal.min(pendiente, percepciones);
  pendiente = pendiente.minus(percepcionesAplicadas);
  const retencionesAplicadas = Decimal.min(pendiente, retenciones);
  const igvAPagar = pendiente.minus(retencionesAplicadas);

  // 4. Pago a cuenta / cuota de renta
  const ingresosMes = pos(s.netGravadas).plus(s.noGravadas).plus(s.exportaciones);
  const renta = calculateIncomeTax(input, ingresosMes, uit, cfg, warnings);

  const ventas = {
    documentsCounted: s.counted,
    documentsExcluded: s.excluded,
    ventasGravadas: fmt(s.gravadas),
    igvVentasGravadas: fmt(s.igvGravadas),
    descuentosNotasCredito: fmt(s.nc),
    igvDescuentosNotasCredito: fmt(s.igvNc),
    ventasNetasGravadas: fmt(s.netGravadas),
    debitoFiscal: fmt(s.debito),
    ventasNoGravadas: fmt(s.noGravadas),
    exportaciones: fmt(s.exportaciones),
  };
  const compras = {
    documentsCounted: p.counted,
    documentsExcluded: p.excluded,
    baseGravadaExclusiva: fmt(p.bExc),
    igvGravadaExclusiva: fmt(p.iExc),
    baseGravadaComun: fmt(p.bCom),
    igvGravadaComun: fmt(p.iCom),
    prorrataAplicada: prorrata.toFixed(4),
    igvComunConCredito: fmt(igvComunConCredito),
    baseSinCredito: fmt(p.bSin),
    igvSinCredito: fmt(p.iSin),
    adquisicionesNoGravadas: fmt(p.noGrav),
    creditoFiscal: fmt(creditoFiscal),
  };
  const igv = {
    debitoFiscal: fmt(s.debito),
    creditoFiscal: fmt(creditoFiscal),
    impuestoResultante: fmt(resultante),
    saldoFavorAnterior: fmt(saldoAnterior),
    tributoTrasSaldo: fmt(trasSaldo),
    percepcionesAplicadas: fmt(percepcionesAplicadas),
    retencionesAplicadas: fmt(retencionesAplicadas),
    igvAPagar: fmt(igvAPagar),
    nuevoSaldoFavorIgv: fmt(nuevoSaldoFavorIgv),
    percepcionesPorArrastrar: fmt(percepciones.minus(percepcionesAplicadas)),
    retencionesPorArrastrar: fmt(retenciones.minus(retencionesAplicadas)),
  };

  return {
    isPreliminary: true,
    companyRuc: input.companyRuc,
    period: input.period,
    regime: input.regime,
    regimeName: regimeInfo.name,
    uit: fmt(uit),
    ventas,
    compras,
    igv,
    renta,
    totalAPagar: fmt(igvAPagar.plus(renta.rentaAPagar)),
    casillas: {
      '100': ventas.ventasGravadas,
      '101': ventas.igvVentasGravadas,
      '102': ventas.descuentosNotasCredito,
      '103': ventas.igvDescuentosNotasCredito,
      '106': ventas.exportaciones,
      '107': compras.baseGravadaExclusiva,
      '108': compras.igvGravadaExclusiva,
      '110': compras.baseGravadaComun,
      '111': compras.igvComunConCredito,
      '189': igv.igvAPagar,
      '301': renta.ingresosNetosMes,
      '307': renta.rentaAPagar,
    },
    warnings,
  };
}
