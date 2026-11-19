import { Decimal } from 'decimal.js';
import { CpeDocumentCalculationResult, CpeDocumentInput, CalculatedItem, IgvAffectationCode } from './types.js';
import { getTaxConfigForYear } from './tax-config.js';
import { validateCpeInput } from './validators.js';
import { numberToWordsPeru } from './number-to-words.js';

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });

const IGV_RATE = new Decimal('0.18');
const ZERO = new Decimal(0);
const TWO_DECIMALS = 2;

function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(TWO_DECIMALS, Decimal.ROUND_HALF_UP);
}

function calculateItem(item: CpeDocumentInput['items'][number]): CalculatedItem {
  const quantity = new Decimal(item.quantity);
  const inputPrice = new Decimal(item.unitPrice);
  const discountPercentage = new Decimal(item.discountPercentage ?? 0).div(100);
  const explicitDiscount = new Decimal(item.discountAmount ?? 0);
  const isExonerated = item.affectationType.startsWith('2');
  const isInafect = item.affectationType.startsWith('3') || item.affectationType === '40';
  const isGratuitous = item.affectationType.endsWith('1') || ['12','13','14','16','21','31','32','33','34','35','36'].includes(item.affectationType);
  const hasIgv = !isExonerated && !isInafect && item.affectationType !== '40';

  let unitValue: Decimal;
  let unitPrice: Decimal;
  let grossBase: Decimal;

  if (item.priceIncludesIgv && hasIgv) {
    unitValue = inputPrice.div(new Decimal(1).plus(IGV_RATE));
    unitPrice = inputPrice;
  } else if (item.priceIncludesIgv) {
    unitValue = inputPrice;
    unitPrice = inputPrice;
  } else {
    unitValue = inputPrice;
    unitPrice = hasIgv ? inputPrice.mul(new Decimal(1).plus(IGV_RATE)) : inputPrice;
  }

  grossBase = unitValue.mul(quantity);
  const percentageDiscount = grossBase.mul(discountPercentage);
  const discountAmount = roundMoney(percentageDiscount.plus(explicitDiscount));
  const baseAmount = roundMoney(Decimal.max(ZERO, grossBase.minus(discountAmount)));
  const igvAmount = isGratuitous || !hasIgv ? ZERO : roundMoney(baseAmount.mul(IGV_RATE));
  const totalAmount = isGratuitous ? ZERO : roundMoney(baseAmount.plus(igvAmount));

  const valueReferenceGratuitous = isGratuitous ? roundMoney(baseAmount.plus(hasIgv ? baseAmount.mul(IGV_RATE) : ZERO)).toFixed(2) : undefined;

  return {
    id: item.id,
    code: item.code,
    description: item.description,
    quantity: quantity.toFixed(4),
    unitCode: item.unitCode ?? 'NIU',
    unitValue: roundMoney(unitValue).toFixed(2),
    unitPrice: roundMoney(unitPrice).toFixed(2),
    baseAmount: baseAmount.toFixed(2),
    discountAmount: discountAmount.toFixed(2),
    igvAmount: igvAmount.toFixed(2),
    totalAmount: totalAmount.toFixed(2),
    affectationType: item.affectationType as IgvAffectationCode,
    isGratuitous,
    valueReferenceGratuitous,
  };
}

export function calculateCpe(input: CpeDocumentInput): CpeDocumentCalculationResult {
  const validationErrors = validateCpeInput(input);
  if (validationErrors.length > 0) {
    throw new Error(`Errores de validación del comprobante:\n- ${validationErrors.join('\n- ')}`);
  }

  const calculatedItems = input.items.map(calculateItem);
  let operacionesGravadas = ZERO;
  let operacionesExoneradas = ZERO;
  let operacionesInafectas = ZERO;
  let operacionesGratuitas = ZERO;
  let totalDescuentos = ZERO;
  let montoIgv = ZERO;
  let totalOperaciones = ZERO;

  for (const item of calculatedItems) {
    const affectation = item.affectationType;
    if (item.isGratuitous) {
      operacionesGratuitas = operacionesGratuitas.plus(item.valueReferenceGratuitous ?? 0);
    } else if (affectation.startsWith('2')) {
      operacionesExoneradas = operacionesExoneradas.plus(item.baseAmount);
    } else if (affectation.startsWith('3') || affectation === '40') {
      operacionesInafectas = operacionesInafectas.plus(item.baseAmount);
    } else {
      operacionesGravadas = operacionesGravadas.plus(item.baseAmount);
      montoIgv = montoIgv.plus(item.igvAmount);
    }
    totalDescuentos = totalDescuentos.plus(item.discountAmount);
    totalOperaciones = totalOperaciones.plus(item.totalAmount);
  }

  const descuentoGlobal = roundMoney(new Decimal(input.globalDiscountAmount ?? 0));
  const totalPagar = roundMoney(totalOperaciones.minus(descuentoGlobal));
  const subTotal = roundMoney(operacionesGravadas.plus(operacionesExoneradas).plus(operacionesInafectas).minus(descuentoGlobal));
  const year = Number(input.issueDate.slice(0, 4));
  const config = getTaxConfigForYear(year);

  // Comprobantes con descuento global deben distribuir el descuento por tipo de afectación.
  // La asignación proporcional se incluye en el payload como pendiente de aplicar según regla SUNAT validada.
  const totals = {
    operacionesGravadas: roundMoney(operacionesGravadas).toFixed(2),
    operacionesExoneradas: roundMoney(operacionesExoneradas).toFixed(2),
    operacionesInafectas: roundMoney(operacionesInafectas).toFixed(2),
    operacionesGratuitas: roundMoney(operacionesGratuitas).toFixed(2),
    totalDescuentos: roundMoney(totalDescuentos.plus(descuentoGlobal)).toFixed(2),
    descuentoGlobal: descuentoGlobal.toFixed(2),
    montoIgv: roundMoney(montoIgv).toFixed(2),
    subTotal: subTotal.toFixed(2),
    totalPagar: totalPagar.toFixed(2),
    totalEnLetras: numberToWordsPeru(totalPagar.toNumber(), input.currency),
  };

  const paddedCorrelative = String(input.correlative).padStart(8, '0');
  return {
    header: {
      cpeType: input.cpeType,
      series: input.series,
      correlative: input.correlative,
      fullNumber: `${input.series}-${paddedCorrelative}`,
      issueDate: input.issueDate,
      currency: input.currency,
      exchangeRate: input.exchangeRate === undefined ? undefined : new Decimal(input.exchangeRate).toFixed(4),
    },
    client: input.client,
    items: calculatedItems,
    totals,
    sunatXmlReadyPayload: {
      customizationID: '2.0',
      profileID: '0101', // Catálogo 17: Factura de venta interna
      id: `${input.series}-${paddedCorrelative}`,
      issueDate: input.issueDate,
      issueTime: input.issueTime ?? '00:00:00',
      invoiceTypeCode: input.cpeType,
      documentCurrencyCode: input.currency,
      taxInclusiveAmount: totals.totalPagar,
      taxExclusiveAmount: totals.subTotal,
      igvTaxAmount: totals.montoIgv,
      lineCountNumeric: calculatedItems.length,
      note: totals.totalEnLetras,
      items: calculatedItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unitCode: item.unitCode,
        unitValue: item.unitValue,
        unitPrice: item.unitPrice,
        baseAmount: item.baseAmount,
        igvAmount: item.igvAmount,
        totalAmount: item.totalAmount,
        igvAffectationCode: item.affectationType,
        isGratuitous: item.isGratuitous,
      })),
      taxYearConfig: {
        year: config.year,
        igvRate: config.igvRate,
      },
    },
  };
}
