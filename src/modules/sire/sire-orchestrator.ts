import { Decimal } from "decimal.js";
import {
  SireRvieLineData,
  SireRceLineData,
  SireExportResult,
  SireProposalAction,
  SireSettlementIntegrationPayload,
  SireCpeInput,
} from "./types.js";
import { generateRvieExport } from "./rvie-generator.js";
import { generateRceExport } from "./rce-generator.js";
import { detectDuplicates, DuplicateDetectionResult } from "./duplicate-detector.js";
import { buildSireCar } from "./car-generator.js";
import { PurchaseService } from "../purchases/purchase-service.js";
import { PurchaseDocumentRecord } from "../purchases/types.js";

import { CompanyProfile } from "../../core/tax-engine/types.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);
const round = (val: Decimal) => val.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export interface SireProposalComparison {
  matchedCars: string[];
  missingInSunat: string[]; // Documentos locales para COMPLEMENTAR o REEMPLAZAR
  missingInLocal: string[]; // Documentos que SUNAT propone pero no tenemos en compras
  recommendedAction: SireProposalAction;
}

export class SireOrchestrator {
  constructor(private purchaseService: PurchaseService) {}

  /**
   * Mapea un comprobante emitido (CPE) a la línea oficial de RVIE (Libro 14.4)
   */
  public mapCpeToRvieLine(
    cpe: SireCpeInput,
    company: CompanyProfile,
    period: string
  ): SireRvieLineData {
    const car = buildSireCar(company.ruc, cpe.cpeType, cpe.series, cpe.correlative);

    return {
      companyRuc: company.ruc,
      companyName: company.legalName,
      period,
      car,
      issueDate: cpe.issueDate,
      cpeType: cpe.cpeType,
      series: cpe.series,
      correlative: String(cpe.correlative),
      clientDocType: cpe.clientDocType,
      clientDocNumber: cpe.clientDocNumber,
      clientName: cpe.clientName,
      taxableBase: cpe.taxableBase,
      igvAmount: cpe.igvAmount,
      totalAmount: cpe.totalAmount,
      currency: cpe.currency,
      exchangeRate: cpe.exchangeRate,
      statusCode: cpe.status === "DE_BAJA" ? "2" : "1",
    };
  }

  /**
   * Mapea un registro de compra al formato reglamentario de RCE (Libro 8.4)
   */
  public mapPurchaseToRceLine(purchase: PurchaseDocumentRecord): SireRceLineData {
    return {
      companyRuc: purchase.companyRuc,
      companyName: purchase.supplier.name,
      period: purchase.accountingPeriod,
      car: purchase.car,
      issueDate: purchase.issueDate,
      dueDate: purchase.dueDate,
      cpeType: purchase.docType,
      series: purchase.series,
      correlative: purchase.correlative,
      supplierDocType: purchase.supplier.docType,
      supplierDocNumber: purchase.supplier.docNumber,
      supplierName: purchase.supplier.name,
      baseGravadaExclusiva: purchase.canUseFiscalCredit ? purchase.totals.baseGravadaExclusiva : "0.00",
      igvGravadoExclusivo: purchase.canUseFiscalCredit ? purchase.totals.igvGravadoExclusivo : "0.00",
      baseGravadaComun: purchase.canUseFiscalCredit ? purchase.totals.baseGravadaComun : "0.00",
      igvGravadoComun: purchase.canUseFiscalCredit ? purchase.totals.igvGravadoComun : "0.00",
      baseGravadaSinCredito: purchase.canUseFiscalCredit ? purchase.totals.baseGravadaSinCredito : purchase.totals.baseGravadaExclusiva,
      igvGravadoSinCredito: purchase.canUseFiscalCredit ? purchase.totals.igvGravadoSinCredito : purchase.totals.igvGravadoExclusivo,
      adquisicionesNoGravadas: purchase.totals.adquisicionesNoGravadas,
      totalAmount: purchase.totals.totalAdquisicion,
      currency: purchase.currency,
      exchangeRate: purchase.exchangeRate,
      detractionDepositDate: purchase.detraction?.depositDate,
      detractionProofNumber: purchase.detraction?.depositProofNumber,
      classificationCode: "1",
      bancarizadoIndicator: purchase.isBancarizado ? "1" : "0",
      statusCode: "1",
    };
  }

  /**
   * Genera el libro RVIE (Ventas) a partir de los CPE emitidos
   */

  /**
   * Verifica preventivamente si existen comprobantes duplicados en la lista de ventas para RVIE
   */
  public checkRvieDuplicates(
    cpeList: SireCpeInput[],
    period: string
  ): DuplicateDetectionResult {
    const items = cpeList.map((c) => ({
      entityDocNumber: c.companyRuc,
      cpeType: c.cpeType,
      series: c.series,
      correlative: c.correlative,
      period,
    }));
    return detectDuplicates(items, "RVIE");
  }

  /**
   * Verifica preventivamente si existen comprobantes duplicados en las compras registradas para RCE
   */
  public checkRceDuplicates(
    period: string,
    companyRuc?: string
  ): DuplicateDetectionResult {
    const purchases = this.purchaseService.listByPeriod(period, companyRuc);
    const items = purchases.map((p) => ({
      entityDocNumber: p.supplier.docNumber,
      cpeType: p.docType,
      series: p.series,
      correlative: p.correlative,
      period: p.accountingPeriod,
    }));
    return detectDuplicates(items, "RCE");
  }

  public async generateRvieBook(
    company: CompanyProfile,
    period: string, // "YYYY-MM"
    cpeList: SireCpeInput[],
    options: { zip?: boolean } = {}
  ): Promise<SireExportResult> {
    const validCpes = cpeList.filter((c) => c.status !== "RECHAZADO" && c.status !== "BORRADOR");
    const lines = validCpes.map((c) => this.mapCpeToRvieLine(c, company, period));
    return generateRvieExport(company.ruc, period, lines, options);
  }

  /**
   * Genera el libro RCE (Compras) a partir del registro de compras del período
   */
  public async generateRceBook(
    companyRuc: string,
    period: string, // "YYYY-MM"
    options: { zip?: boolean } = {}
  ): Promise<SireExportResult> {
    const purchases = this.purchaseService.listByPeriod(period, companyRuc).filter(
      (p) => p.sireStatus !== "EXCLUIDO"
    );
    const lines = purchases.map((p) => this.mapPurchaseToRceLine(p));
    return generateRceExport(companyRuc, period, lines, options);
  }

  /**
   * Concilia la propuesta de compras emitida por SUNAT con las compras registradas internamente
   */
  public compareProposalWithPurchases(
    sunatProposalCars: string[],
    period: string,
    companyRuc: string
  ): SireProposalComparison {
    const localPurchases = this.purchaseService.listByPeriod(period, companyRuc);
    const localCars = new Set(localPurchases.map((p) => p.car));
    const sunatCarSet = new Set(sunatProposalCars);

    const matchedCars: string[] = [];
    const missingInSunat: string[] = [];
    const missingInLocal: string[] = [];

    for (const car of sunatProposalCars) {
      if (localCars.has(car)) {
        matchedCars.push(car);
      } else {
        missingInLocal.push(car);
      }
    }

    for (const p of localPurchases) {
      if (!sunatCarSet.has(p.car)) {
        missingInSunat.push(p.car);
      }
    }

    let recommendedAction: SireProposalAction = "ACEPTAR";
    if (missingInSunat.length > 0 && missingInLocal.length === 0) {
      recommendedAction = "COMPLEMENTAR";
    } else if (missingInSunat.length > 0 || missingInLocal.length > 0) {
      recommendedAction = "REEMPLAZAR";
    }

    return {
      matchedCars,
      missingInSunat,
      missingInLocal,
      recommendedAction,
    };
  }

  /**
   * Prepara los totales consolidados de Compras y Ventas para la Preliquidación Mensual del PDT 621
   */
  public getSettlementIntegrationPayload(
    period: string,
    companyRuc: string,
    cpeList: SireCpeInput[]
  ): SireSettlementIntegrationPayload {
    // 1. Totales de Ventas (RVIE)
    let salesBase = ZERO;
    let salesIgv = ZERO;
    let salesCount = 0;

    for (const cpe of cpeList) {
      if (cpe.status === "ACEPTADO" || cpe.status === "ACEPTADO_CON_OBSERVACIONES") {
        salesBase = salesBase.plus(cpe.taxableBase || 0);
        salesIgv = salesIgv.plus(cpe.igvAmount || 0);
        salesCount++;
      }
    }

    // 2. Totales de Compras (RCE)
    const purchaseSummary = this.purchaseService.getMonthlySummary(period, companyRuc);

    return {
      period,
      salesTaxableBase: round(salesBase).toFixed(2),
      salesIgv: round(salesIgv).toFixed(2),
      purchasesTaxableBase: purchaseSummary.baseGravadaExclusivaTotal,
      purchasesIgv: purchaseSummary.totalCreditoFiscalAceptado,
      purchasesCount: purchaseSummary.totalDocuments,
      salesCount,
    };
  }
}
