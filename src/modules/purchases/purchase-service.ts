import { Decimal } from "decimal.js";
import {
  PurchaseDocumentInput,
  PurchaseDocumentRecord,
  PurchaseCalculatedItem,
  PurchaseTotals,
  MonthlyPurchasesSummary,
  SupplierProfile,
} from "./types.js";
import { validateRuc } from "../../core/tax-engine/validators.js";
import { normalizeDuplicateKey } from "../sire/duplicate-detector.js";

Decimal.set({ precision: 24, rounding: Decimal.ROUND_HALF_UP });
const ZERO = new Decimal(0);
const round = (val: Decimal) => val.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function buildCarCode(
  issuerRuc: string,
  cpeType: string,
  series: string,
  correlative: number | string
): string {
  const cleanRuc = issuerRuc.trim().padStart(11, "0").slice(-11);
  const cleanType = cpeType.trim().padStart(2, "0").slice(-2);
  const cleanSeries = series.trim().toUpperCase().padStart(4, "0").slice(-4);
  const cleanCorrelative = String(correlative).replace(/\D/g, "").padStart(10, "0").slice(-10);
  return `${cleanRuc}${cleanType}${cleanSeries}${cleanCorrelative}`;
}

export function calculateMonthsDifference(issueDateStr: string, accountingPeriodStr: string): number {
  const [issueYear, issueMonth] = issueDateStr.split("-").map(Number);
  const [accYear, accMonth] = accountingPeriodStr.split("-").map(Number);
  return (accYear - issueYear) * 12 + (accMonth - issueMonth);
}

export class PurchaseService {
  private purchases: Map<string, PurchaseDocumentRecord> = new Map();
  private purchasesByPeriodKey: Map<string, PurchaseDocumentRecord> = new Map();
  private suppliers: Map<string, SupplierProfile> = new Map();

  /**
   * Carga registros ya persistidos (por ejemplo, desde PostgreSQL) para reutilizar
   * los resúmenes y validaciones en memoria sin recalcular los comprobantes.
   */
  public loadRecords(records: PurchaseDocumentRecord[]): void {
    for (const record of records) {
      const key = normalizeDuplicateKey(
        record.supplier.docNumber,
        record.docType,
        record.series,
        record.correlative,
        record.accountingPeriod
      );
      this.purchases.set(record.car, record);
      this.purchasesByPeriodKey.set(key, record);
      if (!this.suppliers.has(record.supplier.docNumber)) {
        this.suppliers.set(record.supplier.docNumber, record.supplier);
      }
    }
  }

  public registerSupplier(supplier: SupplierProfile): SupplierProfile {
    const rucErrors = validateRuc(supplier.docNumber);
    if (supplier.docType === "6" && rucErrors.length > 0) {
      throw new Error(`RUC de proveedor inválido: ${rucErrors.join(", ")}`);
    }
    const record: SupplierProfile = {
      ...supplier,
      id: supplier.id || `prov-${supplier.docNumber}`,
      isHabido: supplier.isHabido ?? true,
      isActive: supplier.isActive ?? true,
    };
    this.suppliers.set(supplier.docNumber, record);
    return record;
  }

  public getSupplier(docNumber: string): SupplierProfile | undefined {
    return this.suppliers.get(docNumber);
  }

  public registerPurchase(input: PurchaseDocumentInput): PurchaseDocumentRecord {
    // 1. Validar RUC del emisor/proveedor
    if (input.supplier.docType === "6") {
      const rucErrors = validateRuc(input.supplier.docNumber);
      if (rucErrors.length > 0) {
        throw new Error(`Error en el proveedor: ${rucErrors.join(", ")}`);
      }
    }
    this.registerSupplier(input.supplier);

    // 2. Validar formato de período y fecha
    if (!/^\d{4}-\d{2}$/.test(input.accountingPeriod)) {
      throw new Error(`Período contable inválido: ${input.accountingPeriod}. Formato esperado: YYYY-MM.`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) {
      throw new Error(`Fecha de emisión inválida: ${input.issueDate}. Formato esperado: YYYY-MM-DD.`);
    }

    if (input.currency === "USD" && (!input.exchangeRate || Number(input.exchangeRate) <= 0)) {
      throw new Error("Comprobantes de compra en USD requieren tipo de cambio positivo.");
    }

    if (!input.items || input.items.length === 0) {
      throw new Error("El comprobante de compra debe tener al menos un ítem.");
    }

    // 3. Generar CAR determinista SUNAT y verificar duplicidad por proveedor, serie, número y período
    const car = buildCarCode(input.supplier.docNumber, input.docType, input.series, input.correlative);

    const periodDuplicateKey = normalizeDuplicateKey(
      input.supplier.docNumber,
      input.docType,
      input.series,
      input.correlative,
      input.accountingPeriod
    );

    if (this.purchasesByPeriodKey.has(periodDuplicateKey)) {
      throw new Error(
        `El comprobante de compra con CAR ${car} (${input.series}-${input.correlative}) ya está registrado para el proveedor ${input.supplier.docNumber} en el periodo ${input.accountingPeriod}.`
      );
    }

    if (this.purchases.has(car)) {
      throw new Error(`El comprobante de compra con CAR ${car} (${input.series}-${input.correlative}) ya está registrado.`);
    }

    // 4. Calcular ítems y desgloses
    let baseGravadaExclusiva = ZERO;
    let igvGravadoExclusivo = ZERO;
    let baseGravadaComun = ZERO;
    let igvGravadoComun = ZERO;
    let baseGravadaSinCredito = ZERO;
    let igvGravadoSinCredito = ZERO;
    let noGravadas = ZERO;

    const calculatedItems: PurchaseCalculatedItem[] = input.items.map((it, idx) => {
      const qty = new Decimal(it.quantity);
      const val = new Decimal(it.unitValue);
      const netBase = round(qty.mul(val));
      const rate = new Decimal(it.igvRate ?? 0.18);
      const isGravado = it.taxDestination !== "NO_GRAVADO";
      const igv = isGravado ? round(netBase.mul(rate)) : ZERO;
      const total = round(netBase.plus(igv));

      const hasFiscalCredit = it.taxDestination === "GRAVADO_EXCLUSIVO" || it.taxDestination === "GRAVADO_COMUN";

      if (it.taxDestination === "GRAVADO_EXCLUSIVO") {
        baseGravadaExclusiva = baseGravadaExclusiva.plus(netBase);
        igvGravadoExclusivo = igvGravadoExclusivo.plus(igv);
      } else if (it.taxDestination === "GRAVADO_COMUN") {
        baseGravadaComun = baseGravadaComun.plus(netBase);
        igvGravadoComun = igvGravadoComun.plus(igv);
      } else if (it.taxDestination === "GRAVADO_SIN_CREDITO") {
        baseGravadaSinCredito = baseGravadaSinCredito.plus(netBase);
        igvGravadoSinCredito = igvGravadoSinCredito.plus(igv);
      } else {
        noGravadas = noGravadas.plus(netBase);
      }

      return {
        id: it.id || `item-${idx + 1}`,
        description: it.description,
        quantity: qty.toFixed(4),
        unitValue: round(val).toFixed(2),
        netBase: netBase.toFixed(2),
        igvAmount: igv.toFixed(2),
        totalAmount: total.toFixed(2),
        taxDestination: it.taxDestination,
        classification: it.classification || "1",
        hasFiscalCredit,
      };
    });

    const totalAdquisicion = round(
      baseGravadaExclusiva
        .plus(igvGravadoExclusivo)
        .plus(baseGravadaComun)
        .plus(igvGravadoComun)
        .plus(baseGravadaSinCredito)
        .plus(igvGravadoSinCredito)
        .plus(noGravadas)
    );

    // 5. Validaciones de Crédito Fiscal
    let canUseFiscalCredit = true;
    let restrictionReason: string | undefined;

    // A. Boletas de venta (03) no dan derecho a crédito fiscal
    if (input.docType === "03") {
      canUseFiscalCredit = false;
      restrictionReason = "Las boletas de venta recibidas no otorgan derecho a crédito fiscal del IGV.";
    }

    // B. Antigüedad máxima de 12 meses para crédito fiscal (Art. 19 Ley IGV)
    const monthsDiff = calculateMonthsDifference(input.issueDate, input.accountingPeriod);
    if (monthsDiff > 12) {
      canUseFiscalCredit = false;
      restrictionReason = `El comprobante tiene ${monthsDiff} meses de antigüedad respecto al período contable, superando el límite legal de 12 meses para ejercer el crédito fiscal (Art. 19 Ley del IGV).`;
    }

    // C. Bancarización obligatoria (Ley 28194)
    const bancarizacionThreshold = input.currency === "USD" ? new Decimal(500) : new Decimal(2000);
    const requiresBancarizacion = totalAdquisicion.gte(bancarizacionThreshold);
    const isBancarizado = input.isBancarizado ?? false;

    if (requiresBancarizacion && !isBancarizado) {
      canUseFiscalCredit = false;
      restrictionReason = `Operación por ${totalAdquisicion.toFixed(2)} ${input.currency} supera el umbral de bancarización y no cuenta con medio de pago bancario (Ley 28194).`;
    }

    // D. Detracciones SPOT (D.L. 940)
    if (input.detraction?.hasDetraction) {
      if (!input.detraction.depositProofNumber || !input.detraction.depositDate) {
        canUseFiscalCredit = false;
        restrictionReason = "Operación sujeta a SPOT sin depósito de detracción verificado. El crédito fiscal queda suspendido hasta el pago efectivo (D.L. 940).";
      }
    }

    const totalFiscalCredit = canUseFiscalCredit ? round(igvGravadoExclusivo.plus(igvGravadoComun)) : ZERO;

    const totals: PurchaseTotals = {
      baseGravadaExclusiva: round(baseGravadaExclusiva).toFixed(2),
      igvGravadoExclusivo: round(igvGravadoExclusivo).toFixed(2),
      baseGravadaComun: round(baseGravadaComun).toFixed(2),
      igvGravadoComun: round(igvGravadoComun).toFixed(2),
      baseGravadaSinCredito: round(baseGravadaSinCredito).toFixed(2),
      igvGravadoSinCredito: round(igvGravadoSinCredito).toFixed(2),
      adquisicionesNoGravadas: round(noGravadas).toFixed(2),
      isc: "0.00",
      icbper: "0.00",
      otrosCargos: "0.00",
      totalAdquisicion: totalAdquisicion.toFixed(2),
      totalCreditoFiscal: totalFiscalCredit.toFixed(2),
    };

    const record: PurchaseDocumentRecord = {
      id: `purch-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      car,
      companyRuc: input.companyRuc,
      accountingPeriod: input.accountingPeriod,
      supplier: input.supplier,
      docType: input.docType,
      series: input.series.toUpperCase(),
      correlative: String(input.correlative).padStart(8, "0"),
      fullNumber: `${input.series.toUpperCase()}-${String(input.correlative).padStart(8, "0")}`,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: input.currency,
      exchangeRate: input.exchangeRate ? new Decimal(input.exchangeRate).toFixed(4) : undefined,
      paymentMethod: input.paymentMethod,
      isBancarizado,
      detraction: input.detraction,
      canUseFiscalCredit,
      fiscalCreditRestrictionReason: restrictionReason,
      totals,
      items: calculatedItems,
      sireStatus: "PROPUESTA_PENDIENTE",
      createdAt: new Date().toISOString(),
    };

    this.purchases.set(car, record);
    this.purchasesByPeriodKey.set(periodDuplicateKey, record);
    return record;
  }


  public hasPurchase(
    supplierDocNumber: string,
    docType: string,
    series: string,
    correlative: number | string,
    accountingPeriod: string
  ): boolean {
    const key = normalizeDuplicateKey(
      supplierDocNumber,
      docType,
      series,
      correlative,
      accountingPeriod
    );
    return this.purchasesByPeriodKey.has(key);
  }

  public findByCar(car: string): PurchaseDocumentRecord | undefined {
    return this.purchases.get(car);
  }

  public listByPeriod(period: string, companyRuc?: string): PurchaseDocumentRecord[] {
    return Array.from(this.purchases.values()).filter((p) => {
      const matchPeriod = p.accountingPeriod === period;
      const matchCompany = companyRuc ? p.companyRuc === companyRuc : true;
      return matchPeriod && matchCompany;
    });
  }

  public updateSireStatus(
    car: string,
    status: PurchaseDocumentRecord["sireStatus"]
  ): PurchaseDocumentRecord {
    const record = this.purchases.get(car);
    if (!record) {
      throw new Error(`Comprobante de compra con CAR ${car} no encontrado.`);
    }
    record.sireStatus = status;
    return record;
  }

  public getMonthlySummary(period: string, companyRuc?: string): MonthlyPurchasesSummary {
    const periodPurchases = this.listByPeriod(period, companyRuc).filter(
      (p) => p.sireStatus !== "EXCLUIDO"
    );

    let baseExclusiva = ZERO;
    let igvExclusivo = ZERO;
    let baseComun = ZERO;
    let igvComun = ZERO;
    let baseSinCredito = ZERO;
    let igvSinCredito = ZERO;
    let noGravadas = ZERO;
    let totalAdq = ZERO;
    let creditoFiscalAceptado = ZERO;

    for (const p of periodPurchases) {
      baseExclusiva = baseExclusiva.plus(p.totals.baseGravadaExclusiva);
      igvExclusivo = igvExclusivo.plus(p.totals.igvGravadoExclusivo);
      baseComun = baseComun.plus(p.totals.baseGravadaComun);
      igvComun = igvComun.plus(p.totals.igvGravadoComun);
      baseSinCredito = baseSinCredito.plus(p.totals.baseGravadaSinCredito);
      igvSinCredito = igvSinCredito.plus(p.totals.igvGravadoSinCredito);
      noGravadas = noGravadas.plus(p.totals.adquisicionesNoGravadas);
      totalAdq = totalAdq.plus(p.totals.totalAdquisicion);

      if (p.canUseFiscalCredit) {
        creditoFiscalAceptado = creditoFiscalAceptado.plus(p.totals.totalCreditoFiscal);
      }
    }

    return {
      period,
      totalDocuments: periodPurchases.length,
      baseGravadaExclusivaTotal: round(baseExclusiva).toFixed(2),
      igvGravadoExclusivoTotal: round(igvExclusivo).toFixed(2),
      baseGravadaComunTotal: round(baseComun).toFixed(2),
      igvGravadoComunTotal: round(igvComun).toFixed(2),
      baseGravadaSinCreditoTotal: round(baseSinCredito).toFixed(2),
      igvGravadoSinCreditoTotal: round(igvSinCredito).toFixed(2),
      adquisicionesNoGravadasTotal: round(noGravadas).toFixed(2),
      totalAdquisiciones: round(totalAdq).toFixed(2),
      totalCreditoFiscalAceptado: round(creditoFiscalAceptado).toFixed(2),
    };
  }
}
