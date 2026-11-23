import { describe, expect, it, beforeEach } from "vitest";
import { PurchaseService } from "../purchases/purchase-service.js";
import { PurchaseDocumentInput } from "../purchases/types.js";
import { SireOrchestrator } from "../sire/sire-orchestrator.js";
import { generateRvieExport } from "../sire/rvie-generator.js";
import { generateRceExport } from "../sire/rce-generator.js";
import {
  detectDuplicates,
  normalizeDuplicateKey,
  assertNoDuplicates,
} from "../sire/duplicate-detector.js";
import { SireRvieLineData, SireRceLineData, SireCpeInput } from "../sire/types.js";
import { CompanyProfile } from "../../core/tax-engine/types.js";

describe("Detección y Prevención de Comprobantes Duplicados en RVIE y RCE", () => {
  let purchaseService: PurchaseService;
  let sireOrchestrator: SireOrchestrator;

  beforeEach(() => {
    purchaseService = new PurchaseService();
    sireOrchestrator = new SireOrchestrator(purchaseService);
  });

  const company: CompanyProfile = {
    ruc: "10445533811",
    legalName: "JOSE BARRIENTOS",
    taxRegime: "RMT",
    address: {
      ubigeo: "150101",
      department: "Lima",
      province: "Lima",
      district: "Lima",
      addressLine: "Av. Principal 123",
    },
  };

  const supplierA = {
    docType: "6" as const,
    docNumber: "20123456786", // RUC con dígito verificador válido
    name: "PROVEEDOR ALFA S.A.C.",
  };

  const supplierB = {
    docType: "6" as const,
    docNumber: "20600000005", // RUC con dígito verificador válido
    name: "PROVEEDOR BETA S.A.C.",
  };

  const basePurchase: PurchaseDocumentInput = {
    companyRuc: "10445533811",
    supplier: supplierA,
    docType: "01",
    series: "F001",
    correlative: 100,
    issueDate: "2026-03-10",
    accountingPeriod: "2026-03",
    currency: "PEN",
    paymentMethod: "CONTADO",
    isBancarizado: true,
    items: [
      {
        description: "Bienes comerciales",
        quantity: 1,
        unitValue: "500.00",
        taxDestination: "GRAVADO_EXCLUSIVO",
      },
    ],
  };

  describe("1. Detección en Compras y RCE (Registro de Compras)", () => {
    it("evita registrar dos veces el mismo comprobante del mismo proveedor, serie, número y período", () => {
      purchaseService.registerPurchase(basePurchase);

      expect(
        purchaseService.hasPurchase("20123456786", "01", "F001", 100, "2026-03")
      ).toBe(true);

      // Intento de registrar el duplicado
      expect(() => purchaseService.registerPurchase(basePurchase)).toThrow(
        /ya está registrado para el proveedor 20123456786 en el periodo 2026-03/
      );
    });

    it("permite registrar comprobantes con la misma serie y número si pertenecen a PROVEEDORES DISTINTOS", () => {
      const purchaseProvA = purchaseService.registerPurchase({
        ...basePurchase,
        supplier: supplierA,
        series: "F001",
        correlative: 555,
      });

      const purchaseProvB = purchaseService.registerPurchase({
        ...basePurchase,
        supplier: supplierB,
        series: "F001",
        correlative: 555,
      });

      expect(purchaseProvA.car).not.toBe(purchaseProvB.car);
      expect(purchaseProvA.supplier.docNumber).toBe("20123456786");
      expect(purchaseProvB.supplier.docNumber).toBe("20600000005");
    });

    it("permite registrar comprobantes del mismo proveedor con distinta serie o número correlativo", () => {
      purchaseService.registerPurchase({
        ...basePurchase,
        series: "F001",
        correlative: 1,
      });

      const secondDoc = purchaseService.registerPurchase({
        ...basePurchase,
        series: "F001",
        correlative: 2,
      });

      const thirdDoc = purchaseService.registerPurchase({
        ...basePurchase,
        series: "F002",
        correlative: 1,
      });

      expect(secondDoc.correlative).toBe("00000002");
      expect(thirdDoc.series).toBe("F002");
    });

    it("generateRceExport rechaza tramas que contengan comprobantes repetidos de un mismo proveedor", async () => {
      const line: SireRceLineData = {
        companyRuc: "10445533811",
        companyName: "JOSE BARRIENTOS",
        period: "202603",
        car: "2012345678601F0010000000100",
        issueDate: "10/03/2026",
        cpeType: "01",
        series: "F001",
        correlative: "100",
        supplierDocType: "6",
        supplierDocNumber: "20123456786",
        supplierName: "PROVEEDOR ALFA S.A.C.",
        baseGravadaExclusiva: "500.00",
        igvGravadoExclusivo: "90.00",
        totalAmount: "590.00",
        currency: "PEN",
      };

      // Trama con dos líneas exactamente iguales
      await expect(
        generateRceExport("10445533811", "2026-03", [line, { ...line }], { zip: false })
      ).rejects.toThrow(/Comprobante duplicado detectado en RCE/);
    });
  });

  describe("2. Detección en Ventas y RVIE (Registro de Ventas)", () => {
    it("generateRvieExport rechaza la generación si existen comprobantes repetidos en el mismo período", async () => {
      const line: SireRvieLineData = {
        companyRuc: "10445533811",
        companyName: "JOSE BARRIENTOS",
        period: "202603",
        car: "1044553381101F0010000000001",
        issueDate: "05/03/2026",
        cpeType: "01",
        series: "F001",
        correlative: "1",
        clientDocType: "6",
        clientDocNumber: "20123456786",
        clientName: "CLIENTE S.A.C.",
        taxableBase: "1000.00",
        igvAmount: "180.00",
        totalAmount: "1180.00",
        currency: "PEN",
      };

      await expect(
        generateRvieExport("10445533811", "2026-03", [line, { ...line }], { zip: false })
      ).rejects.toThrow(/Comprobante duplicado detectado en RVIE/);
    });

    it("sireOrchestrator.generateRvieBook bloquea la emisión si se envían comprobantes duplicados", async () => {
      const duplicateCpes: SireCpeInput[] = [
        {
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 5,
          issueDate: "2026-03-05",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE S.A.",
          taxableBase: "1000.00",
          igvAmount: "180.00",
          totalAmount: "1180.00",
          status: "ACEPTADO",
        },
        {
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 5, // Mismo tipo, serie y correlativo
          issueDate: "2026-03-05",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE S.A.",
          taxableBase: "1000.00",
          igvAmount: "180.00",
          totalAmount: "1180.00",
          status: "ACEPTADO",
        },
      ];

      await expect(
        sireOrchestrator.generateRvieBook(company, "2026-03", duplicateCpes, { zip: false })
      ).rejects.toThrow(/Comprobante duplicado detectado en RVIE/);
    });

    it("sireOrchestrator.checkRvieDuplicates alerta preventivamente sin lanzar excepción", () => {
      const duplicateCpes: SireCpeInput[] = [
        {
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 8,
          issueDate: "2026-03-08",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE",
          taxableBase: "100.00",
          igvAmount: "18.00",
          totalAmount: "118.00",
          status: "ACEPTADO",
        },
        {
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 8,
          issueDate: "2026-03-08",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE",
          taxableBase: "100.00",
          igvAmount: "18.00",
          totalAmount: "118.00",
          status: "ACEPTADO",
        },
      ];

      const report = sireOrchestrator.checkRvieDuplicates(duplicateCpes, "2026-03");

      expect(report.hasDuplicates).toBe(true);
      expect(report.duplicates).toHaveLength(1);
      expect(report.duplicates[0]).toMatch(/10445533811 - tipo 01 F001-8/);
      expect(report.uniqueCount).toBe(1);
    });

    it("permite el mismo correlativo si difieren en tipo de comprobante (ej. Factura 01 vs Boleta 03)", async () => {
      const lines: SireRvieLineData[] = [
        {
          companyRuc: "10445533811",
          companyName: "JOSE BARRIENTOS",
          period: "202603",
          issueDate: "05/03/2026",
          cpeType: "01", // Factura
          series: "F001",
          correlative: "1",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE 1",
          taxableBase: "100.00",
          igvAmount: "18.00",
          totalAmount: "118.00",
          currency: "PEN",
        },
        {
          companyRuc: "10445533811",
          companyName: "JOSE BARRIENTOS",
          period: "202603",
          issueDate: "05/03/2026",
          cpeType: "03", // Boleta
          series: "B001",
          correlative: "1",
          clientDocType: "1",
          clientDocNumber: "12345678",
          clientName: "CLIENTE 2",
          taxableBase: "50.00",
          igvAmount: "9.00",
          totalAmount: "59.00",
          currency: "PEN",
        },
      ];

      const res = await generateRvieExport("10445533811", "2026-03", lines, { zip: false });
      expect(res.lineCount).toBe(2);
    });
  });

  describe("3. Normalización de Claves Únicas", () => {
    it("normaliza series en mayúsculas, ceros correlativos y formato de período", () => {
      const key1 = normalizeDuplicateKey("20123456786", "1", "f001", 5, "2026-03");
      const key2 = normalizeDuplicateKey("20123456786", "01", "F001", "00000005", "202603");

      expect(key1).toBe("20123456786|01|F001|00000005|202603");
      expect(key1).toBe(key2);
    });

    it("detectDuplicates identifica colisiones con distintos formatos de entrada equivalentes", () => {
      const items = [
        { entityDocNumber: "20123456786", cpeType: "01", series: "f001", correlative: 12, period: "2026-03" },
        { entityDocNumber: "20123456786", cpeType: "1", series: "F001", correlative: "00000012", period: "202603" },
      ];

      const result = detectDuplicates(items, "RCE");
      expect(result.hasDuplicates).toBe(true);
      expect(result.uniqueCount).toBe(1);
    });
  });
});
