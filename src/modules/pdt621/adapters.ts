import { SireCpeInput } from '../sire/types.js';
import { Pdt621SaleDocument } from './types.js';

/** Convierte un CPE en formato SIRE (RVIE) al documento de venta de la preliquidación. */
export function saleFromSireCpe(cpe: SireCpeInput): Pdt621SaleDocument {
  if (cpe.cpeType !== '01' && cpe.cpeType !== '03' && cpe.cpeType !== '07') {
    throw new Error(`Tipo de comprobante no soportado en ventas: '${cpe.cpeType}'.`);
  }
  if (cpe.currency !== 'PEN' && cpe.currency !== 'USD') {
    throw new Error(`Moneda no soportada: '${cpe.currency}'.`);
  }
  return {
    cpeType: cpe.cpeType,
    series: cpe.series,
    correlative: cpe.correlative,
    issueDate: cpe.issueDate,
    status: cpe.status,
    currency: cpe.currency,
    exchangeRate: cpe.exchangeRate,
    taxableBase: cpe.taxableBase,
    igvAmount: cpe.igvAmount,
  };
}
