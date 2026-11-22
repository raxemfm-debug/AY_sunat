import { describe, expect, it, beforeEach } from "vitest";
import { PurchaseService } from "../purchases/purchase-service.js";
import { PurchaseDocumentInput } from "../purchases/types.js";

describe("Módulo de Compras (Gestión y Control de Crédito Fiscal)", () => {
  let purchaseService: PurchaseService;

  beforeEach(() => {
    purchaseService = new PurchaseService();
  });

  const baseSupplier = {
    docType: "6" as const,
    docNumber: "20123456786", // RUC válido
    name: "DISTRIBUIDORA MAYORISTA S.A.C.",
  };

  const validPurchaseInput: PurchaseDocumentInput = {
    companyRuc: "10445533811",
    supplier: baseSupplier,
    docType: "01",
    series: "F001",
    correlative: 1234,
    issueDate: "2026-03-10",
    accountingPeriod: "2026-03",
    currency: "PEN",
    paymentMethod: "CONTADO",
    isBancarizado: true,
    items: [
      {
        description: "Mercadería para reventa",
        quantity: 10,
        unitValue: "100.00",
        taxDestination: "GRAVADO_EXCLUSIVO",
        classification: "1",
      },
    ],
  };

  it("1. registra una compra válida y calcula el crédito fiscal al 100%", () => {
    const record = purchaseService.registerPurchase(validPurchaseInput);

    expect(record.car).toBe("2012345678601F0010000001234");
    expect(record.fullNumber).toBe("F001-00001234");
    expect(record.totals.baseGravadaExclusiva).toBe("1000.00");
    expect(record.totals.igvGravadoExclusivo).toBe("180.00");
    expect(record.totals.totalAdquisicion).toBe("1180.00");
    expect(record.canUseFiscalCredit).toBe(true);
    expect(record.totals.totalCreditoFiscal).toBe("180.00");
  });

  it("2. restringe el crédito fiscal si el comprobante excede el plazo legal de 12 meses", () => {
    const oldPurchase: PurchaseDocumentInput = {
      ...validPurchaseInput,
      series: "F002",
      correlative: 55,
      issueDate: "2024-12-01", // 15 meses antes de 2026-03
      accountingPeriod: "2026-03",
    };

    const record = purchaseService.registerPurchase(oldPurchase);

    expect(record.canUseFiscalCredit).toBe(false);
    expect(record.totals.totalCreditoFiscal).toBe("0.00");
    expect(record.fiscalCreditRestrictionReason).toMatch(/12 meses/);
  });

  it("3. restringe el crédito fiscal por falta de bancarización en compras >= S/ 2,000", () => {
    const bigPurchaseNoBank: PurchaseDocumentInput = {
      ...validPurchaseInput,
      series: "F003",
      correlative: 99,
      isBancarizado: false,
      items: [
        {
          description: "Lote grande de insumos",
          quantity: 25,
          unitValue: "100.00", // Base: 2500, IGV: 450, Total: 2950 >= 2000
          taxDestination: "GRAVADO_EXCLUSIVO",
        },
      ],
    };

    const record = purchaseService.registerPurchase(bigPurchaseNoBank);

    expect(record.canUseFiscalCredit).toBe(false);
    expect(record.totals.totalCreditoFiscal).toBe("0.00");
    expect(record.fiscalCreditRestrictionReason).toMatch(/bancarización/i);
  });

  it("4. suspende el crédito fiscal si la compra está sujeta a detracción (SPOT) sin constancia", () => {
    const detractionPurchase: PurchaseDocumentInput = {
      ...validPurchaseInput,
      series: "F004",
      correlative: 88,
      detraction: {
        hasDetraction: true,
        detractionCode: "022", // Otros servicios empresariales
        detractionPercentage: 12,
        // Sin depósito de detracción aún
      },
    };

    const record = purchaseService.registerPurchase(detractionPurchase);

    expect(record.canUseFiscalCredit).toBe(false);
    expect(record.fiscalCreditRestrictionReason).toMatch(/SPOT/i);
  });

  it("5. una boleta de venta (03) recibida no genera derecho a crédito fiscal", () => {
    const boletaPurchase: PurchaseDocumentInput = {
      ...validPurchaseInput,
      docType: "03",
      series: "B001",
      correlative: 450,
    };

    const record = purchaseService.registerPurchase(boletaPurchase);

    expect(record.canUseFiscalCredit).toBe(false);
    expect(record.totals.totalCreditoFiscal).toBe("0.00");
    expect(record.fiscalCreditRestrictionReason).toMatch(/boletas de venta/i);
  });

  it("6. evita registrar compras duplicadas con el mismo CAR", () => {
    purchaseService.registerPurchase(validPurchaseInput);

    expect(() => purchaseService.registerPurchase(validPurchaseInput)).toThrow(/ya está registrado/);
  });

  it("7. genera el resumen mensual excluyendo comprobantes marcados como EXCLUIDO", () => {
    const doc1 = purchaseService.registerPurchase(validPurchaseInput);
    const doc2 = purchaseService.registerPurchase({
      ...validPurchaseInput,
      series: "F005",
      correlative: 10,
      items: [
        {
          description: "Segundo ítem",
          quantity: 5,
          unitValue: "100.00", // Base: 500, IGV: 90
          taxDestination: "GRAVADO_EXCLUSIVO",
        },
      ],
    });

    // Excluir doc2 de la propuesta
    purchaseService.updateSireStatus(doc2.car, "EXCLUIDO");

    const summary = purchaseService.getMonthlySummary("2026-03", "10445533811");

    expect(summary.totalDocuments).toBe(1);
    expect(summary.baseGravadaExclusivaTotal).toBe("1000.00");
    expect(summary.igvGravadoExclusivoTotal).toBe("180.00");
    expect(summary.totalCreditoFiscalAceptado).toBe("180.00");
  });
});
