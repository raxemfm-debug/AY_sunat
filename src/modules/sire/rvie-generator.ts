import { Decimal } from "decimal.js";
import JSZip from "jszip";
import { SireFileNameParams, SireRvieLineData, SireExportResult } from "./types.js";
import { buildSireCar } from "./car-generator.js";
import { assertNoDuplicates, normalizeDuplicateKey } from "./duplicate-detector.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);

export function buildSireFileName(params: SireFileNameParams): string {
  const cleanRuc = params.ruc.padStart(11, "0").slice(-11);
  const cleanYear = String(params.year).padStart(4, "0").slice(-4);
  const cleanMonth = String(params.month).padStart(2, "0").slice(-2);
  const opportunity = params.opportunityCode ?? "02";
  const hasInfo = params.hasInformation !== false ? "1" : "0";
  const hasContent = "1";
  const currency = params.currencyIndicator ?? "1";
  const generator = params.generatorIndicator ?? "2";
  const ext = params.extension ?? "txt";

  return `LE${cleanRuc}${cleanYear}${cleanMonth}00${params.bookCode}${opportunity}${hasInfo}${hasContent}${currency}${generator}.${ext}`;
}

export function formatDateForSire(isoDate: string): string {
  if (!isoDate) return "";
  // If YYYY-MM-DD -> DD/MM/YYYY
  const parts = isoDate.split("-");
  if (parts.length === 3) {
    return `${parts[2].padStart(2, "0")}/${parts[1].padStart(2, "0")}/${parts[0]}`;
  }
  return isoDate;
}

export function serializeRvieLine(data: SireRvieLineData): string {
  const car = data.car || buildSireCar(data.companyRuc, data.cpeType, data.series, data.correlative);
  const issueDateFormatted = formatDateForSire(data.issueDate);
  const dueDateFormatted = data.dueDate ? formatDateForSire(data.dueDate) : "";
  const modifiedDateFormatted = data.modifiedIssueDate ? formatDateForSire(data.modifiedIssueDate) : "";

  const fields = [
    data.companyRuc, // 1. RUC Emisor
    data.companyName, // 2. Razón Social Emisor
    data.period.replace("-", ""), // 3. Período AAAAMM
    car, // 4. CAR
    issueDateFormatted, // 5. Fecha Emisión
    dueDateFormatted, // 6. Fecha Vencimiento
    data.cpeType, // 7. Tipo CPE
    data.series, // 8. Serie
    String(data.correlative).padStart(8, "0"), // 9. Correlativo
    data.correlativeEnd ?? "", // 10. Correlativo Final
    data.clientDocType, // 11. Tipo Doc Cliente
    data.clientDocNumber, // 12. Num Doc Cliente
    data.clientName, // 13. Razón Social Cliente
    data.exportBase ?? "0.00", // 14. Exportación
    data.taxableBase, // 15. Base Gravada
    data.baseDiscount ?? "0.00", // 16. Descuento Base
    data.igvAmount, // 17. IGV/IPM
    data.igvDiscount ?? "0.00", // 18. Descuento IGV
    data.exoneratedAmount ?? "0.00", // 19. Exonerado
    data.inaffectedAmount ?? "0.00", // 20. Inafecto
    data.iscAmount ?? "0.00", // 21. ISC
    data.ivapBase ?? "0.00", // 22. Base IVAP
    data.ivapAmount ?? "0.00", // 23. IVAP
    data.icbperAmount ?? "0.00", // 24. ICBPER
    data.otherTaxes ?? "0.00", // 25. Otros tributos
    data.totalAmount, // 26. Total
    data.currency, // 27. Moneda
    data.currency === "USD" ? (data.exchangeRate ?? "1.0000") : "", // 28. Tipo Cambio
    modifiedDateFormatted, // 29. Fecha Emi Doc Modificado
    data.modifiedCpeType ?? "", // 30. Tipo Doc Modificado
    data.modifiedSeries ?? "", // 31. Serie Doc Modificado
    data.modifiedCorrelative ?? "", // 32. Correlativo Modificado
    "", // 33. Identificación contrato
    "", // 34. Error tipo 1
    data.cancellationIndicator ?? "1", // 35. Indicador pago bancarizado
    data.statusCode ?? "1", // 36. Estado (1: Válido)
  ];

  return fields.join("|") + "|";
}

export async function generateRvieExport(
  companyRuc: string,
  period: string, // "YYYY-MM"
  lines: SireRvieLineData[],
  options: { zip?: boolean } = {}
): Promise<SireExportResult> {
  // Validación estricta de duplicados en RVIE por emisor, serie, número y período
  const rvieCheckItems = lines.map((l) => ({
    entityDocNumber: l.companyRuc,
    cpeType: l.cpeType,
    series: l.series,
    correlative: l.correlative,
    period: l.period,
  }));
  assertNoDuplicates(rvieCheckItems, "RVIE");

  const [year, month] = period.split("-");
  const hasInfo = lines.length > 0;

  const txtLines = lines.map(serializeRvieLine);
  const txtContent = txtLines.join("\r\n") + (txtLines.length > 0 ? "\r\n" : "");

  const fileName = buildSireFileName({
    ruc: companyRuc,
    year,
    month,
    bookCode: "140400",
    hasInformation: hasInfo,
    extension: "txt",
  });

  let zipFileName: string | undefined;
  let zipBuffer: Uint8Array | undefined;

  if (options.zip !== false) {
    zipFileName = buildSireFileName({
      ruc: companyRuc,
      year,
      month,
      bookCode: "140400",
      hasInformation: hasInfo,
      extension: "zip",
    });

    const zip = new JSZip();
    zip.file(fileName, txtContent);
    zipBuffer = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  let totalBase = ZERO;
  let totalIgv = ZERO;
  let totalMonto = ZERO;

  for (const l of lines) {
    totalBase = totalBase.plus(l.taxableBase || 0);
    totalIgv = totalIgv.plus(l.igvAmount || 0);
    totalMonto = totalMonto.plus(l.totalAmount || 0);
  }

  return {
    bookCode: "140400",
    bookName: "Registro de Ventas e Ingresos Electrónico (RVIE)",
    period,
    fileName,
    txtContent,
    zipFileName,
    zipBuffer,
    lineCount: lines.length,
    totalTaxableBase: totalBase.toFixed(2),
    totalIgv: totalIgv.toFixed(2),
    totalAmount: totalMonto.toFixed(2),
  };
}
