import { describe, expect, it, beforeEach } from "vitest";
import JSZip from "jszip";
import { SireOrchestrator } from "../sire/sire-orchestrator.js";
import { buildSireCar, parseSireCar, validateSireCar } from "../sire/car-generator.js";
import { buildSireFileName } from "../sire/rvie-generator.js";
import { PurchaseService } from "../purchases/purchase-service.js";
import { calculateMonthlySettlement } from "../../core/tax-engine/monthly-settlement.js";
import { SireCpeInput } from "../sire/types.js";
import { CompanyProfile } from "../../core/tax-engine/types.js";

describe("Módulo SIRE: Sistema Integrado de Registros Electrónicos (RVIE / RCE)", () => {
  let purchaseService: PurchaseService;
  let sireOrchestrator: SireOrchestrator;

  beforeEach(() => {
    purchaseService = new PurchaseService();
    sireOrchestrator = new SireOrchestrator(purchaseService);
  });

  const testCompany: CompanyProfile = {
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

  describe("1. Generador y Validador del Código de Anotación de Registro (CAR)", () => {
    it("genera un CAR determinista de exactamente 27 caracteres", () => {
      const car = buildSireCar("20123456786", "01", "F001", 123);
      expect(car).toHaveLength(27);
      expect(car).toBe("2012345678601F0010000000123");

      const errors = validateSireCar(car);
      expect(errors).toHaveLength(0);
    });

    it("parsea correctamente los componentes del CAR", () => {
      const car = "2012345678601F0010000000123";
      const parsed = parseSireCar(car);

      expect(parsed.issuerRuc).toBe("20123456786");
      expect(parsed.cpeType).toBe("01");
      expect(parsed.series).toBe("F001");
      expect(parsed.correlative).toBe("123");
    });

    it("detecta errores cuando el CAR tiene longitud o formato inválido", () => {
      const errors = validateSireCar("CAR_CORTO_INVALIDO");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/27 caracteres/);
    });
  });

  describe("2. Nomenclatura oficial de Archivos SIRE", () => {
    it("genera el nombre reglamentario SUNAT para RVIE (Libro 140400)", () => {
      const fileName = buildSireFileName({
        ruc: "10445533811",
        year: 2026,
        month: "03",
        bookCode: "140400",
        extension: "txt",
      });

      expect(fileName).toBe("LE1044553381120260300140400021112.txt");
    });

    it("genera el nombre reglamentario SUNAT para RCE (Libro 080400)", () => {
      const fileName = buildSireFileName({
        ruc: "10445533811",
        year: 2026,
        month: "03",
        bookCode: "080400",
        extension: "zip",
      });

      expect(fileName).toBe("LE1044553381120260300080400021112.zip");
    });
  });

  describe("3. RVIE (Registro de Ventas e Ingresos Electrónico)", () => {
    it("genera el libro RVIE con tramas delimitadas por pipe y empaquetado ZIP", async () => {
      const cpeList: SireCpeInput[] = [
        {
          id: "cpe-1",
          companyId: "comp-1",
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 1,
          fullNumber: "F001-00000001",
          issueDate: "2026-03-05",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE VIP S.A.C.",
          taxableBase: "2000.00",
          igvAmount: "360.00",
          totalAmount: "2360.00",
          status: "ACEPTADO",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const result = await sireOrchestrator.generateRvieBook(testCompany, "2026-03", cpeList, { zip: true });

      expect(result.bookCode).toBe("140400");
      expect(result.lineCount).toBe(1);
      expect(result.totalTaxableBase).toBe("2000.00");
      expect(result.totalIgv).toBe("360.00");
      expect(result.totalAmount).toBe("2360.00");

      // Validar delimitadores pipe |
      expect(result.txtContent).toContain("10445533811|JOSE BARRIENTOS|202603|");
      expect(result.txtContent).toContain("|2000.00|0.00|360.00|");

      // Validar ZIP generado
      expect(result.zipFileName).toBe("LE1044553381120260300140400021112.zip");
      expect(result.zipBuffer).toBeDefined();

      const zip = await JSZip.loadAsync(result.zipBuffer!);
      const filesInZip = Object.keys(zip.files);
      expect(filesInZip).toContain(result.fileName);
    });
  });

  describe("4. RCE (Registro de Compras Electrónico)", () => {
    it("genera el libro RCE a partir de las compras registradas con 42 campos reglamentarios", async () => {
      purchaseService.registerPurchase({
        companyRuc: "10445533811",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR CENTRAL S.A.C.",
        },
        docType: "01",
        series: "F001",
        correlative: 890,
        issueDate: "2026-03-12",
        accountingPeriod: "2026-03",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        items: [
          {
            description: "Servidor local y equipos",
            quantity: 1,
            unitValue: "5000.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
            classification: "2", // Activo fijo
          },
        ],
      });

      const result = await sireOrchestrator.generateRceBook("10445533811", "2026-03", { zip: true });

      expect(result.bookCode).toBe("080400");
      expect(result.lineCount).toBe(1);
      expect(result.totalTaxableBase).toBe("5000.00");
      expect(result.totalIgv).toBe("900.00");
      expect(result.totalAmount).toBe("5900.00");

      const line = result.txtContent.trim().split("\r\n")[0];
      const fields = line.split("|");
      // Debe contener al menos 42 campos reglamentarios
      expect(fields.length).toBeGreaterThanOrEqual(42);
      expect(fields[0]).toBe("10445533811");
      expect(fields[3]).toBe("2012345678601F0010000000890"); // CAR
      expect(fields[14]).toBe("5000.00"); // Base gravada exclusiva
      expect(fields[15]).toBe("900.00"); // IGV exclusivo
    });
  });

  describe("5. Conciliación y Acciones sobre la Propuesta SUNAT", () => {
    it("recomienda ACEPTAR cuando la propuesta de SUNAT coincide exactamente con los registros locales", () => {
      const reg = purchaseService.registerPurchase({
        companyRuc: "10445533811",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR 1 S.A.",
        },
        docType: "01",
        series: "F001",
        correlative: 100,
        issueDate: "2026-03-15",
        accountingPeriod: "2026-03",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        items: [
          {
            description: "Item",
            quantity: 1,
            unitValue: "100.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
          },
        ],
      });

      const comparison = sireOrchestrator.compareProposalWithPurchases([reg.car], "2026-03", "10445533811");

      expect(comparison.recommendedAction).toBe("ACEPTAR");
      expect(comparison.matchedCars).toHaveLength(1);
      expect(comparison.missingInSunat).toHaveLength(0);
      expect(comparison.missingInLocal).toHaveLength(0);
    });

    it("recomienda COMPLEMENTAR cuando hay compras locales que SUNAT no incluyó en su propuesta", () => {
      const reg = purchaseService.registerPurchase({
        companyRuc: "10445533811",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR 2 S.A.",
        },
        docType: "01",
        series: "F002",
        correlative: 200,
        issueDate: "2026-03-16",
        accountingPeriod: "2026-03",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        items: [
          {
            description: "Item 2",
            quantity: 1,
            unitValue: "200.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
          },
        ],
      });

      // SUNAT propone lista vacía
      const comparison = sireOrchestrator.compareProposalWithPurchases([], "2026-03", "10445533811");

      expect(comparison.recommendedAction).toBe("COMPLEMENTAR");
      expect(comparison.missingInSunat).toContain(reg.car);
    });
  });

  describe("6. Integración con el Motor Contable y Preliquidación PDT 621", () => {
    it("alimenta automáticamente los totales a la Preliquidación Mensual del IGV y Renta", () => {
      // 1. Registrar ventas emitidas
      const cpeList: SireCpeInput[] = [
        {
          id: "cpe-v1",
          companyId: "comp-1",
          companyRuc: "10445533811",
          cpeType: "01",
          series: "F001",
          correlative: 10,
          fullNumber: "F001-00000010",
          issueDate: "2026-03-15",
          currency: "PEN",
          clientDocType: "6",
          clientDocNumber: "20123456786",
          clientName: "CLIENTE S.A.C.",
          taxableBase: "10000.00",
          igvAmount: "1800.00",
          totalAmount: "11800.00",
          status: "ACEPTADO",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      // 2. Registrar compras aceptadas
      purchaseService.registerPurchase({
        companyRuc: "10445533811",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR S.A.C.",
        },
        docType: "01",
        series: "F001",
        correlative: 50,
        issueDate: "2026-03-18",
        accountingPeriod: "2026-03",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        items: [
          {
            description: "Mercaderías",
            quantity: 1,
            unitValue: "4000.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
          },
        ],
      });

      // 3. Extraer payload integrado desde SIRE
      const payload = sireOrchestrator.getSettlementIntegrationPayload("2026-03", "10445533811", cpeList);

      expect(payload.salesTaxableBase).toBe("10000.00");
      expect(payload.salesIgv).toBe("1800.00");
      expect(payload.purchasesTaxableBase).toBe("4000.00");
      expect(payload.purchasesIgv).toBe("720.00"); // 4000 * 18%

      // 4. Ejecutar preliquidación tributaria
      const settlement = calculateMonthlySettlement({
        period: "2026-03",
        regime: "RMT",
        accumulatedNetRevenueBeforePeriod: "0",
        salesTaxableBase: payload.salesTaxableBase,
        salesIgv: payload.salesIgv,
        purchasesTaxableBase: payload.purchasesTaxableBase,
        purchasesIgv: payload.purchasesIgv,
      });

      // Débito fiscal (1800) - Crédito fiscal (720) = IGV a pagar (1080)
      expect(settlement.debitoFiscalIgv).toBe("1800.00");
      expect(settlement.creditoFiscalIgv).toBe("720.00");
      expect(settlement.igvPagar).toBe("1080.00");
      expect(settlement.rentaPagar).toBe("100.00"); // 1% de 10,000 en RMT <= 300 UIT
      expect(settlement.totalTributosAPagar).toBe("1180.00");
    });
  });
});
