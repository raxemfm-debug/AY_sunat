import type { PrintableCpe, PrintableLine } from './types.js';

export interface CpeFieldValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedCpe: PrintableCpe;
}

export class CpeValidationError extends Error {
  readonly errors: string[];
  readonly warnings: string[];

  constructor(errors: string[], warnings: string[] = []) {
    super(`Error de validación del comprobante antes de imprimir:\n- ${errors.join('\n- ')}`);
    this.name = 'CpeValidationError';
    this.errors = errors;
    this.warnings = warnings;
  }
}

const RUC_REGEX = /^(10|15|16|17|20)\d{9}$/;
const DNI_REGEX = /^\d{8}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const SERIES_INVOICE_REGEX = /^F[A-Z0-9]{3}$/i;
const SERIES_BOLETA_REGEX = /^B[A-Z0-9]{3}$/i;
const SERIES_NC_REGEX = /^[FB][A-Z0-9]{3}$/i;
const safeTrim = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Valida si una cadena YYYY-MM-DD corresponde a una fecha real del calendario gregoriano.
 */
export function isValidCalendarDate(dateStr: string): boolean {
  if (!DATE_REGEX.test(dateStr)) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Valida de forma rigurosa y segura todos los campos tributarios y estructurales de un CPE
 * antes de generar la representación impresa (PDF A4 o Ticket 80mm).
 * Aplica normalización segura (ej. mayúsculas en serie, padding de 8 dígitos en correlativo).
 */
export function validateAndSanitizeCpe(cpe: PrintableCpe): CpeFieldValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Clonar para sanitización segura sin mutar el objeto original
  const sanitized: PrintableCpe = JSON.parse(JSON.stringify(cpe));

  // 1. Tipo de Comprobante
  if (!['01', '03', '07'].includes(sanitized.type)) {
    errors.push(`Tipo de comprobante '${sanitized.type}' no soportado. Debe ser '01' (Factura), '03' (Boleta) o '07' (Nota de Crédito).`);
  }

  // 2. Serie y Correlativo
  const rawSeries = safeTrim(sanitized.series).toUpperCase();
  sanitized.series = rawSeries;

  if (!rawSeries) {
    errors.push('La serie del comprobante es obligatoria.');
  } else if (sanitized.type === '01') {
    if (!SERIES_INVOICE_REGEX.test(rawSeries)) {
      errors.push(`Serie '${rawSeries}' inválida para Factura (01). Debe tener 4 caracteres alfanuméricos e iniciar con 'F' (ej: F001).`);
    }
  } else if (sanitized.type === '03') {
    if (!SERIES_BOLETA_REGEX.test(rawSeries)) {
      errors.push(`Serie '${rawSeries}' inválida para Boleta (03). Debe tener 4 caracteres alfanuméricos e iniciar con 'B' (ej: B001).`);
    }
  } else if (sanitized.type === '07') {
    if (!SERIES_NC_REGEX.test(rawSeries)) {
      errors.push(`Serie '${rawSeries}' inválida para Nota de Crédito (07). Debe tener 4 caracteres e iniciar con 'F' o 'B' (ej: FC01, BC01).`);
    }
  }

  // Correlativo (normalizado a 8 dígitos según estándar SUNAT)
  const rawNum = String(sanitized.number || '').trim();
  const numVal = parseInt(rawNum, 10);
  if (!/^\d{1,8}$/.test(rawNum) || isNaN(numVal) || numVal <= 0 || numVal > 99999999) {
    errors.push(`Correlativo '${rawNum}' inválido. Debe ser un número entero entre 1 y 99999999.`);
  } else {
    // Normalización segura a 8 dígitos con padding
    sanitized.number = rawNum.length < 8 ? rawNum.padStart(8, '0') : rawNum;
  }

  // 3. Emisor
  if (!sanitized.issuer) {
    errors.push('Faltan los datos del emisor (issuer).');
  } else {
    sanitized.issuer.ruc = safeTrim(sanitized.issuer.ruc);
    sanitized.issuer.legalName = safeTrim(sanitized.issuer.legalName);

    if (!RUC_REGEX.test(sanitized.issuer.ruc)) {
      errors.push(`RUC del emisor '${sanitized.issuer.ruc}' inválido. Debe tener 11 dígitos y comenzar con 10, 15, 16, 17 o 20.`);
    }
    if (!sanitized.issuer.legalName) {
      errors.push('La razón social o nombre legal del emisor es obligatorio.');
    }
  }

  // 4. Cliente / Receptor
  if (!sanitized.customer) {
    errors.push('Faltan los datos del cliente (customer).');
  } else {
    sanitized.customer.name = safeTrim(sanitized.customer.name);
    sanitized.customer.documentType = safeTrim(sanitized.customer.documentType);
    sanitized.customer.documentNumber = safeTrim(sanitized.customer.documentNumber);

    if (!sanitized.customer.name) {
      errors.push('La razón social o nombre del cliente es obligatorio.');
    }

    const docType = sanitized.customer.documentType;
    const docNum = sanitized.customer.documentNumber;

    // Regla tributaria estricta: Factura exige obligatoriamente RUC de 11 dígitos
    if (sanitized.type === '01') {
      if (docType !== '6') {
        errors.push(`Para Factura Electrónica (01), el cliente debe registrar tipo de documento RUC ('6'). Se recibió tipo '${docType}'.`);
      }
      if (!RUC_REGEX.test(docNum)) {
        errors.push(`RUC del cliente '${docNum}' inválido para Factura. Debe tener 11 dígitos numéricos.`);
      }
    } else if (sanitized.type === '03') {
      // Boleta de venta
      if (docType === '1' && !DNI_REGEX.test(docNum)) {
        errors.push(`DNI del cliente '${docNum}' inválido en Boleta. Debe tener 8 dígitos numéricos.`);
      } else if (docType === '6' && !RUC_REGEX.test(docNum)) {
        errors.push(`RUC del cliente '${docNum}' inválido en Boleta.`);
      } else if (docType === '0') {
        // Sin documento permitido solo si el total es menor a S/ 700.00
        const total = sanitized.totals?.total ?? 0;
        if (total >= 700) {
          warnings.push('La boleta no identifica al cliente y alcanza un importe elevado. Verifica las reglas de identificación vigentes antes de emitir.');
        }
      }
    }
  }

  // 5. Fechas
  sanitized.issueDate = safeTrim(sanitized.issueDate);
  if (!isValidCalendarDate(sanitized.issueDate)) {
    errors.push(`Fecha de emisión '${sanitized.issueDate}' inválida o inexistente en el calendario. Use formato YYYY-MM-DD.`);
  }

  if (sanitized.dueDate) {
    sanitized.dueDate = safeTrim(sanitized.dueDate);
    if (!isValidCalendarDate(sanitized.dueDate)) {
      errors.push(`Fecha de vencimiento '${sanitized.dueDate}' inválida. Use formato YYYY-MM-DD.`);
    } else if (sanitized.dueDate < sanitized.issueDate) {
      warnings.push(`La fecha de vencimiento (${sanitized.dueDate}) es anterior a la fecha de emisión (${sanitized.issueDate}).`);
    }
  }

  // 6. Detalle de Ítems
  if (!Array.isArray(sanitized.lines) || sanitized.lines.length === 0) {
    errors.push('El comprobante debe contener al menos un ítem o detalle.');
  } else {
    sanitized.lines.forEach((line: PrintableLine, idx: number) => {
      line.description = safeTrim(line.description);
      line.unitCode = (safeTrim(line.unitCode) || 'NIU').toUpperCase();

      if (!line.description) {
        errors.push(`Línea #${idx + 1}: La descripción del producto o servicio no puede estar vacía.`);
      }
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        errors.push(`Línea #${idx + 1}: Cantidad inválida (${line.quantity}). Debe ser mayor a 0.`);
      }
      for (const [key, val] of Object.entries({
        unitValue: line.unitValue,
        unitPrice: line.unitPrice,
        lineExtensionAmount: line.lineExtensionAmount,
        igvAmount: line.igvAmount,
        totalAmount: line.totalAmount,
      })) {
        if (!Number.isFinite(val) || val < 0) {
          errors.push(`Línea #${idx + 1}: Importe '${key}' inválido (${val}). Debe ser un número mayor o igual a 0.`);
        }
      }
    });
  }

  // 7. Totales y Consistencia Numérica
  if (!sanitized.totals) {
    errors.push('Faltan los totales del comprobante.');
  } else {
    if (!['PEN', 'USD'].includes(sanitized.totals.currency)) {
      errors.push(`Moneda '${sanitized.totals.currency}' no soportada. Use 'PEN' o 'USD'.`);
    }

    const { taxable = 0, exempt = 0, unaffected = 0, free = 0, igv = 0, total = 0 } = sanitized.totals;
    for (const [key, val] of Object.entries({ taxable, exempt, unaffected, free, igv, total })) {
      if (!Number.isFinite(val) || val < 0) {
        errors.push(`Total '${key}' inválido (${val}). Debe ser un número no negativo.`);
      }
    }

    // Verificar coherencia matemática: Gravada + Exonerada + Inafecta + IGV == Total (tolerancia de 5 céntimos por redondeos)
    const calculatedSum = taxable + exempt + unaffected + igv;
    const diff = Math.abs(calculatedSum - total);
    if (diff > 0.05) {
      warnings.push(`Discrepancia en totales: Gravada (${taxable.toFixed(2)}) + Exonerada (${exempt.toFixed(2)}) + Inafecta (${unaffected.toFixed(2)}) + IGV (${igv.toFixed(2)}) = ${calculatedSum.toFixed(2)}, pero el total declarado es ${total.toFixed(2)} (diferencia de S/ ${diff.toFixed(2)}).`);
    }
  }

  // 8. Hash CPE
  sanitized.hashCpe = safeTrim(sanitized.hashCpe);
  if (!sanitized.hashCpe) {
    errors.push('El campo hashCpe es obligatorio y debe contener el DigestValue extraído de la firma digital del XML.');
  }

  // 9. Validación específica para Nota de Crédito (07)
  if (sanitized.type === '07') {
    if (!sanitized.modifiedDocument) {
      errors.push('La Nota de Crédito (07) requiere obligatoriamente la referencia al comprobante modificado (modifiedDocument).');
    } else {
      const ref = sanitized.modifiedDocument;
      ref.documentType = safeTrim(ref.documentType);
      ref.series = safeTrim(ref.series).toUpperCase();
      ref.number = safeTrim(ref.number);
      ref.reasonCode = safeTrim(ref.reasonCode);
      ref.reasonDescription = safeTrim(ref.reasonDescription);

      if (!['01', '03'].includes(ref.documentType)) {
        errors.push(`Tipo de comprobante modificado '${ref.documentType}' inválido. Debe ser '01' (Factura) o '03' (Boleta).`);
      }
      if (!ref.series || !ref.number) {
        errors.push('La serie y número del comprobante modificado son obligatorios.');
      }
      if (!ref.reasonCode) {
        errors.push('El código de motivo de la nota de crédito es obligatorio (Catálogo 09 SUNAT).');
      }
      if (!ref.reasonDescription) {
        errors.push('La descripción del motivo de la nota de crédito es obligatoria.');
      }

      // Coherencia de tipo de serie entre NC y Comprobante Modificado
      if (sanitized.series.startsWith('F') && ref.documentType !== '01') {
        errors.push(`Una Nota de Crédito con serie '${sanitized.series}' (inicia con 'F') solo puede modificar una Factura (01), no tipo '${ref.documentType}'.`);
      } else if (sanitized.series.startsWith('B') && ref.documentType !== '03') {
        errors.push(`Una Nota de Crédito con serie '${sanitized.series}' (inicia con 'B') solo puede modificar una Boleta (03), no tipo '${ref.documentType}'.`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    sanitizedCpe: sanitized,
  };
}

/**
 * Validador estricto para ejecución directa: lanza CpeValidationError si hay errores.
 */
export function validatePrintableCpe(cpe: PrintableCpe): void {
  const result = validateAndSanitizeCpe(cpe);
  if (!result.isValid) {
    throw new CpeValidationError(result.errors, result.warnings);
  }
}
