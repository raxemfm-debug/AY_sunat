import { Decimal } from "decimal.js";
import JSZip from "jszip";
import { SireRceLineData, SireExportResult } from "./types.js";
import { buildSireFileName, formatDateForSire } from "./rvie-generator.js";
import { assertNoDuplicates } from "./duplicate-detector.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);

export function serializeRceLine(data: SireRceLineData): string {
  const issueDateFormatted = formatDateForSire(data.issueDate);
  const dueDateFormatted = data.dueDate ? formatDateForSire(data.dueDate) : "";
  const modifiedDateFormatted = data.modifiedIssueDate ? formatDateForSire(data.modifiedIssueDate) : "";
  const detractionDateFormatted = data.detractionDepositDate ? formatDateForSire(data.detractionDepositDate) : "";

  const fields = [
    data.companyRuc, // 1. RUC Adquirente
    data.companyName, // 2. Razón Social Adquirente
    data.period.replace("-", ""), // 3. Período AAAAMM
    data.car, // 4. CAR del emisor
    issueDateFormatted, // 5. Fecha Emisión
    dueDateFormatted, // 6. Fecha Vencimiento
    data.cpeType, // 7. Tipo CPE
    data.series, // 8. Serie
    data.duaYear ?? "", // 9. Año DUA/DAM
    String(data.correlative).padStart(8, "0"), // 10. Correlativo
    data.correlativeEnd ?? "", // 11. Correlativo Final
    data.supplierDocType, // 12. Tipo Doc Proveedor
    data.supplierDocNumber, // 13. Num Doc Proveedor
    data.supplierName, // 14. Razón Social Proveedor
    data.baseGravadaExclusiva, // 15. Base Gravada Exclusiva
    data.igvGravadoExclusivo, // 16. IGV Exclusivo
    data.baseGravadaComun ?? "0.00", // 17. Base Común
    data.igvGravadoComun ?? "0.00", // 18. IGV Común
    data.baseGravadaSinCredito ?? "0.00", // 19. Base Sin Crédito
    data.igvGravadoSinCredito ?? "0.00", // 20. IGV Sin Crédito
    data.adquisicionesNoGravadas ?? "0.00", // 21. No Gravadas
    data.iscAmount ?? "0.00", // 22. ISC
    data.icbperAmount ?? "0.00", // 23. ICBPER
    data.otherTaxes ?? "0.00", // 24. Otros tributos
    data.totalAmount, // 25. Total
    data.currency, // 26. Moneda
    data.currency === "USD" ? (data.exchangeRate ?? "1.0000") : "", // 27. Tipo Cambio
    modifiedDateFormatted, // 28. Fecha Emi Doc Modificado
    data.modifiedCpeType ?? "", // 29. Tipo Doc Modificado
    data.modifiedSeries ?? "", // 30. Serie Doc Modificado
    data.modifiedCorrelative ?? "", // 31. Correlativo Doc Modificado
    detractionDateFormatted, // 32. Fecha Detracción
    data.detractionProofNumber ?? "", // 33. Constancia Detracción
    data.retentionIndicator ?? "", // 34. Retención
    data.classificationCode ?? "1", // 35. Clasificación Bienes/Servicios (1: Mercadería)
    "", // 36. Contrato/Proyecto
    "", // 37. Error 1
    "", // 38. Error 2
    "", // 39. Error 3
    "", // 40. Error 4
    data.bancarizadoIndicator ?? "1", // 41. Bancarización (1: Sí, 0: No)
    data.statusCode ?? "1", // 42. Estado (1: En el período)
  ];

  return fields.join("|") + "|";
}

export async function generateRceExport(
  companyRuc: string,
  period: string, // "YYYY-MM"
  lines: SireRceLineData[],
  options: { zip?: boolean } = {}
): Promise<SireExportResult> {
  // Validación estricta de duplicados en RCE por proveedor, serie, número y período contable
  const rceCheckItems = lines.map((l) => ({
    entityDocNumber: l.supplierDocNumber,
    cpeType: l.cpeType,
    series: l.series,
    correlative: l.correlative,
    period: l.period,
  }));
  assertNoDuplicates(rceCheckItems, "RCE");

  const [year, month] = period.split("-");
  const hasInfo = lines.length > 0;

  const txtLines = lines.map(serializeRceLine);
  const txtContent = txtLines.join("\r\n") + (txtLines.length > 0 ? "\r\n" : "");

  const fileName = buildSireFileName({
    ruc: companyRuc,
    year,
    month,
    bookCode: "080400",
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
      bookCode: "080400",
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
    const baseExcl = new Decimal(l.baseGravadaExclusiva || 0);
    const baseCom = new Decimal(l.baseGravadaComun || 0);
    const igvExcl = new Decimal(l.igvGravadoExclusivo || 0);
    const igvCom = new Decimal(l.igvGravadoComun || 0);

    totalBase = totalBase.plus(baseExcl).plus(baseCom);
    totalIgv = totalIgv.plus(igvExcl).plus(igvCom);
    totalMonto = totalMonto.plus(l.totalAmount || 0);
  }

  return {
    bookCode: "080400",
    bookName: "Registro de Compras Electrónico (RCE)",
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
