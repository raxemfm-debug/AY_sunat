import { SireCarParsed } from "./types.js";
import { validateRuc } from "../../core/tax-engine/validators.js";

/**
 * Generador y Validador del Código de Anotación de Registro (CAR) de SUNAT (27 caracteres)
 * Estructura:
 * - 01-11: RUC del emisor (11 dígitos)
 * - 12-13: Tipo de Comprobante (2 dígitos: 01, 03, 07, 08, etc.)
 * - 14-17: Serie del Comprobante (4 caracteres alfanuméricos)
 * - 18-27: Número Correlativo (10 dígitos con ceros a la izquierda)
 */
export function buildSireCar(
  issuerRuc: string,
  cpeType: string,
  series: string,
  correlative: number | string
): string {
  const cleanRuc = issuerRuc.trim().padStart(11, "0").slice(-11);
  const cleanType = cpeType.trim().padStart(2, "0").slice(-2);
  const cleanSeries = series.trim().toUpperCase().padStart(4, "0").slice(-4);
  const cleanCorrelative = String(correlative).replace(/\D/g, "").padStart(10, "0").slice(-10);

  const car = `${cleanRuc}${cleanType}${cleanSeries}${cleanCorrelative}`;
  if (car.length !== 27) {
    throw new Error(`El CAR generado debe tener exactamente 27 caracteres. Resultó: ${car} (${car.length})`);
  }
  return car;
}

export function validateSireCar(car: string): string[] {
  const errors: string[] = [];
  if (!car || typeof car !== "string") {
    errors.push("El CAR no puede estar vacío.");
    return errors;
  }
  if (car.length !== 27) {
    errors.push(`El CAR debe tener exactamente 27 caracteres (longitud actual: ${car.length}).`);
  }
  const rucPart = car.slice(0, 11);
  const rucErrors = validateRuc(rucPart);
  if (rucErrors.length > 0) {
    errors.push(`RUC emisor en CAR inválido: ${rucErrors.join(", ")}`);
  }
  const typePart = car.slice(11, 13);
  if (!/^[0-9]{2}$/.test(typePart)) {
    errors.push(`Tipo de CPE en CAR inválido: ${typePart}`);
  }
  const seriesPart = car.slice(13, 17);
  if (!/^[A-Z0-9]{4}$/.test(seriesPart)) {
    errors.push(`Serie en CAR inválida: ${seriesPart}`);
  }
  const correlativePart = car.slice(17, 27);
  if (!/^[0-9]{10}$/.test(correlativePart)) {
    errors.push(`Correlativo en CAR inválido: ${correlativePart}`);
  }
  return errors;
}

export function parseSireCar(car: string): SireCarParsed {
  const validationErrors = validateSireCar(car);
  if (validationErrors.length > 0) {
    throw new Error(`CAR inválido: ${validationErrors.join("; ")}`);
  }
  return {
    issuerRuc: car.slice(0, 11),
    cpeType: car.slice(11, 13),
    series: car.slice(13, 17),
    correlative: String(Number(car.slice(17, 27))),
    rawCar: car,
  };
}
