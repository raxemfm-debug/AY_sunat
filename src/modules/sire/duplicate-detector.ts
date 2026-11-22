/**
 * Detección y Prevención de Comprobantes Duplicados en SIRE (RVIE y RCE)
 * Criterio normativo SUNAT:
 * - RVIE: No puede existir más de un comprobante con el mismo emisor, tipo de CPE, serie, correlativo y período.
 * - RCE: No puede existir más de un comprobante con el mismo proveedor (RUC/Doc), tipo de CPE, serie, correlativo y período contable.
 */

export interface SireDuplicateCheckItem {
  entityDocNumber: string; // RUC del emisor (RVIE) o proveedor (RCE)
  cpeType: string;
  series: string;
  correlative: number | string;
  period: string; // YYYY-MM o YYYYMM
}

export function normalizeDuplicateKey(
  entityDocNumber: string,
  cpeType: string,
  series: string,
  correlative: number | string,
  period: string
): string {
  const cleanEntity = entityDocNumber.trim();
  const cleanType = cpeType.trim().padStart(2, "0").slice(-2);
  const cleanSeries = series.trim().toUpperCase().padStart(4, "0").slice(-4);
  const cleanCorrelative = String(correlative).replace(/\D/g, "").padStart(8, "0");
  const cleanPeriod = period.replace(/\D/g, "").slice(0, 6); // YYYYMM
  return `${cleanEntity}|${cleanType}|${cleanSeries}|${cleanCorrelative}|${cleanPeriod}`;
}

export interface DuplicateDetectionResult {
  hasDuplicates: boolean;
  duplicates: string[];
  uniqueCount: number;
}

export function detectDuplicates<T extends SireDuplicateCheckItem>(
  items: T[],
  contextName: "RVIE" | "RCE"
): DuplicateDetectionResult {
  const seen = new Set<string>();
  const duplicates: string[] = [];

  for (const item of items) {
    const key = normalizeDuplicateKey(
      item.entityDocNumber,
      item.cpeType,
      item.series,
      item.correlative,
      item.period
    );
    if (seen.has(key)) {
      duplicates.push(
        `${contextName}: ${item.entityDocNumber} - tipo ${item.cpeType} ${item.series.toUpperCase()}-${item.correlative} (periodo ${item.period})`
      );
    } else {
      seen.add(key);
    }
  }

  return {
    hasDuplicates: duplicates.length > 0,
    duplicates,
    uniqueCount: seen.size,
  };
}

export function assertNoDuplicates<T extends SireDuplicateCheckItem>(
  items: T[],
  contextName: "RVIE" | "RCE"
): void {
  const check = detectDuplicates(items, contextName);
  if (check.hasDuplicates) {
    throw new Error(
      `Comprobante duplicado detectado en ${contextName}: ${check.duplicates.join("; ")}.`
    );
  }
}
