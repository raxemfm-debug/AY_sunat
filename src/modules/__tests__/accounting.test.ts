import { describe, it, expect, beforeEach } from "vitest";
import {
  AccountingService,
  PCGE_ACCOUNTS,
  getPcgeAccount,
  validateJournalEntryBalance,
  buildSaleJournalEntry,
  buildPurchaseJournalEntries,
  buildTreasuryJournalEntry,
} from "../accounting/index.js";
import { CpeRecord } from "../cpe/types.js";
import { PurchaseDocumentRecord } from "../purchases/types.js";

describe("Módulo de Contabilidad PCGE (Plan Contable General Empresarial)", () => {
  describe("Catálogo de Cuentas PCGE", () => {
    it("debe contener las cuentas clave para el ciclo de compras y ventas", () => {
      expect(getPcgeAccount("101").name).toBe("Caja");
      expect(getPcgeAccount("1041").name).toBe("Cuentas corrientes operativas");
      expect(getPcgeAccount("1212").name).toContain("Emitidas en cartera");
      expect(getPcgeAccount("40111").name).toBe("IGV - Cuenta propia");
      expect(getPcgeAccount("4212").name).toContain("Emitidas");
      expect(getPcgeAccount("6011").name).toBe("Mercaderías manufacturadas");
      expect(getPcgeAccount("70121").name).toContain("Mercaderías - Terceros");
      expect(getPcgeAccount("20111").name).toContain("Mercaderías manufacturadas");
      expect(getPcgeAccount("6111").name).toBe("Mercaderías manufacturadas");
      expect(getPcgeAccount("791").name).toBe("Cargas imputables a cuentas de costos y gastos");
    });

    it("lanza error al consultar una cuenta inexistente", () => {
      expect(() => getPcgeAccount("999999")).toThrow(/no encontrada en el catálogo/);
    });
  });

  describe("Validación de Partida Doble", () => {
    it("aprueba un asiento perfectamente balanceado", () => {
      const result = validateJournalEntryBalance([
        {
          lineNumber: 1,
          accountCode: "1212",
          accountName: "Facturas por cobrar",
          debit: "118.00",
          credit: "0.00",
        },
        {
          lineNumber: 2,
          accountCode: "40111",
          accountName: "IGV",
          debit: "0.00",
          credit: "18.00",
        },
        {
          lineNumber: 3,
          accountCode: "70121",
          accountName: "Ventas",
          debit: "0.00",
          credit: "100.00",
        },
      ]);

      expect(result.isBalanced).toBe(true);
      expect(result.totalDebit).toBe("118.00");
      expect(result.totalCredit).toBe("118.00");
      expect(result.difference).toBe("0.00");
    });

    it("rechaza un asiento desbalanceado", () => {
      const result = validateJournalEntryBalance([
        {
          lineNumber: 1,
          accountCode: "1212",
          accountName: "Facturas por cobrar",
          debit: "120.00",
          credit: "0.00",
        },
        {
          lineNumber: 2,
          accountCode: "70121",
          accountName: "Ventas",
          debit: "0.00",
          credit: "100.00",
        },
      ]);

      expect(result.isBalanced).toBe(false);
      expect(result.difference).toBe("20.00");
    });

    it("rechaza líneas con importes negativos o simultáneos en Debe y Haber", () => {
      expect(() =>
        validateJournalEntryBalance([
          {
            lineNumber: 1,
            accountCode: "1212",
            accountName: "Facturas",
            debit: "-50.00",
            credit: "0.00",
          },
        ])
      ).toThrow(/no pueden ser negativos/);

      expect(() =>
        validateJournalEntryBalance([
          {
            lineNumber: 1,
            accountCode: "1212",
            accountName: "Facturas",
            debit: "100.00",
            credit: "100.00",
          },
        ])
      ).toThrow(/no puede tener importes simultáneos/);
    });
  });

  describe("Generación Automática de Asientos desde Ventas (CPE)", () => {
    it("genera asiento de venta para una Factura (01) con Debe 12 y Haber 40 y 70", () => {
      const mockCpe: Pick<
        CpeRecord,
        | "id"
        | "companyId"
        | "fullNumber"
        | "cpeType"
        | "series"
        | "correlative"
        | "issueDate"
        | "currency"
        | "clientDocNumber"
        | "clientName"
        | "subTotal"
        | "montoIgv"
        | "totalPagar"
      > = {
        id: "cpe-uuid-1",
        companyId: "20600000005",
        fullNumber: "F001-00000001",
        cpeType: "01",
        series: "F001",
        correlative: 1,
        issueDate: "2026-03-15",
        currency: "PEN",
        clientDocNumber: "20123456786",
        clientName: "CLIENTE INDUSTRIAL SAC",
        subTotal: "1000.00",
        montoIgv: "180.00",
        totalPagar: "1180.00",
      };

      const entry = buildSaleJournalEntry(mockCpe);
      expect(entry.accountingPeriod).toBe("2026-03");
      expect(entry.lines).toHaveLength(3);

      const line12 = entry.lines.find((l) => l.accountCode === "1212");
      const line40 = entry.lines.find((l) => l.accountCode === "40111");
      const line70 = entry.lines.find((l) => l.accountCode === "70121");

      expect(line12?.debit).toBe("1180.00");
      expect(line12?.credit).toBe("0.00");
      expect(line40?.debit).toBe("0.00");
      expect(line40?.credit).toBe("180.00");
      expect(line70?.debit).toBe("0.00");
      expect(line70?.credit).toBe("1000.00");
    });

    it("genera asiento inverso para una Nota de Crédito (07)", () => {
      const mockNc: Pick<
        CpeRecord,
        | "id"
        | "companyId"
        | "fullNumber"
        | "cpeType"
        | "series"
        | "correlative"
        | "issueDate"
        | "currency"
        | "clientDocNumber"
        | "clientName"
        | "subTotal"
        | "montoIgv"
        | "totalPagar"
      > = {
        id: "nc-uuid-1",
        companyId: "20600000005",
        fullNumber: "FC01-00000001",
        cpeType: "07",
        series: "FC01",
        correlative: 1,
        issueDate: "2026-03-18",
        currency: "PEN",
        clientDocNumber: "20123456786",
        clientName: "CLIENTE INDUSTRIAL SAC",
        subTotal: "200.00",
        montoIgv: "36.00",
        totalPagar: "236.00",
      };

      const entry = buildSaleJournalEntry(mockNc);
      const line70 = entry.lines.find((l) => l.accountCode === "70121");
      const line40 = entry.lines.find((l) => l.accountCode === "40111");
      const line12 = entry.lines.find((l) => l.accountCode === "1212");

      expect(line70?.debit).toBe("200.00");
      expect(line70?.credit).toBe("0.00");
      expect(line40?.debit).toBe("36.00");
      expect(line40?.credit).toBe("0.00");
      expect(line12?.debit).toBe("0.00");
      expect(line12?.credit).toBe("236.00");
    });
  });

  describe("Generación Automática de Asientos desde Compras", () => {
    it("genera asiento de provisión y destino para compra de mercaderías (60 contra 42 y 20 contra 61)", () => {
      const mockPurchase: PurchaseDocumentRecord = {
        id: "purch-1",
        car: "2060000000501F0010000100000000000001",
        companyRuc: "20600000005",
        accountingPeriod: "2026-03",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR MAYORISTA SAC",
        },
        docType: "01",
        series: "F001",
        correlative: "100",
        fullNumber: "F001-00000100",
        issueDate: "2026-03-10",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        canUseFiscalCredit: true,
        totals: {
          baseGravadaExclusiva: "5000.00",
          igvGravadoExclusivo: "900.00",
          baseGravadaComun: "0.00",
          igvGravadoComun: "0.00",
          baseGravadaSinCredito: "0.00",
          igvGravadoSinCredito: "0.00",
          adquisicionesNoGravadas: "0.00",
          isc: "0.00",
          icbper: "0.00",
          otrosCargos: "0.00",
          totalAdquisicion: "5900.00",
          totalCreditoFiscal: "900.00",
        },
        items: [
          {
            id: "item-1",
            description: "Mercadería A",
            quantity: "10",
            unitValue: "500.00",
            netBase: "5000.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
            classification: "1", // Mercadería
            igvAmount: "900.00",
            totalAmount: "5900.00",
            hasFiscalCredit: true,
          },
        ],
        sireStatus: "ACEPTADO",
        createdAt: "2026-03-10T10:00:00Z",
      };

      const { provisionEntry, destinationEntry } = buildPurchaseJournalEntries(mockPurchase);

      // Provisión
      expect(provisionEntry.lines).toHaveLength(3);
      const line60 = provisionEntry.lines.find((l) => l.accountCode === "6011");
      const line40 = provisionEntry.lines.find((l) => l.accountCode === "40111");
      const line42 = provisionEntry.lines.find((l) => l.accountCode === "4212");

      expect(line60?.debit).toBe("5000.00");
      expect(line40?.debit).toBe("900.00");
      expect(line42?.credit).toBe("5900.00");

      // Destino al almacén
      expect(destinationEntry).toBeDefined();
      expect(destinationEntry?.lines).toHaveLength(2);
      const line20 = destinationEntry?.lines.find((l) => l.accountCode === "20111");
      const line61 = destinationEntry?.lines.find((l) => l.accountCode === "6111");

      expect(line20?.debit).toBe("5000.00");
      expect(line61?.credit).toBe("5000.00");
    });

    it("asigna el IGV sin derecho a crédito fiscal como costo/gasto (Art. 69 LIGV)", () => {
      const mockPurchaseSinCredito: PurchaseDocumentRecord = {
        id: "purch-sin-cred",
        car: "2060000000501F0010000200000000000001",
        companyRuc: "20600000005",
        accountingPeriod: "2026-03",
        supplier: {
          docType: "6",
          docNumber: "20123456786",
          name: "PROVEEDOR SERVICIOS SAC",
        },
        docType: "01",
        series: "F001",
        correlative: "200",
        fullNumber: "F001-00000200",
        issueDate: "2026-03-12",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        canUseFiscalCredit: false,
        totals: {
          baseGravadaExclusiva: "0.00",
          igvGravadoExclusivo: "0.00",
          baseGravadaComun: "0.00",
          igvGravadoComun: "0.00",
          baseGravadaSinCredito: "1000.00",
          igvGravadoSinCredito: "180.00",
          adquisicionesNoGravadas: "0.00",
          isc: "0.00",
          icbper: "0.00",
          otrosCargos: "0.00",
          totalAdquisicion: "1180.00",
          totalCreditoFiscal: "0.00",
        },
        items: [
          {
            id: "item-2",
            description: "Gasto sin crédito",
            quantity: "1",
            unitValue: "1000.00",
            netBase: "1000.00",
            taxDestination: "GRAVADO_SIN_CREDITO",
            classification: "3", // Gastos de administración
            igvAmount: "180.00",
            totalAmount: "1180.00",
            hasFiscalCredit: false,
          },
        ],
        sireStatus: "ACEPTADO",
        createdAt: "2026-03-12T10:00:00Z",
      };

      const { provisionEntry, destinationEntry } = buildPurchaseJournalEntries(mockPurchaseSinCredito);

      // La cuenta 6321 debe absorber la base (1000) + el IGV sin crédito (180) = 1180
      const line63 = provisionEntry.lines.find((l) => l.accountCode === "6321");
      const line40 = provisionEntry.lines.find((l) => l.accountCode === "40111");
      const line42 = provisionEntry.lines.find((l) => l.accountCode === "4212");

      expect(line63?.debit).toBe("1180.00");
      expect(line40).toBeUndefined(); // No hay crédito fiscal
      expect(line42?.credit).toBe("1180.00");

      // Destino por función (Elemento 9): 50% 941 y 50% 951 contra 791
      const line94 = destinationEntry?.lines.find((l) => l.accountCode === "941");
      const line95 = destinationEntry?.lines.find((l) => l.accountCode === "951");
      const line79 = destinationEntry?.lines.find((l) => l.accountCode === "791");

      expect(line94?.debit).toBe("590.00");
      expect(line95?.debit).toBe("590.00");
      expect(line79?.credit).toBe("1180.00");
    });
  });

  describe("Asientos de Tesorería", () => {
    it("genera asiento de cobranza a cliente en cuenta corriente (Debe 1041, Haber 1212)", () => {
      const entry = buildTreasuryJournalEntry({
        companyId: "20600000005",
        type: "COLLECTION",
        amount: "1180.00",
        date: "2026-03-20",
        treasuryAccount: "1041",
        referenceDoc: "F001-00000001",
        entityName: "CLIENTE INDUSTRIAL SAC",
      });

      expect(entry.lines).toHaveLength(2);
      expect(entry.lines[0].accountCode).toBe("1041");
      expect(entry.lines[0].debit).toBe("1180.00");
      expect(entry.lines[1].accountCode).toBe("1212");
      expect(entry.lines[1].credit).toBe("1180.00");
    });

    it("genera asiento de pago a proveedor (Debe 4212, Haber 1041)", () => {
      const entry = buildTreasuryJournalEntry({
        companyId: "20600000005",
        type: "PAYMENT",
        amount: "5900.00",
        date: "2026-03-22",
        treasuryAccount: "1041",
        referenceDoc: "F001-00000100",
        entityName: "PROVEEDOR MAYORISTA SAC",
      });

      expect(entry.lines).toHaveLength(2);
      expect(entry.lines[0].accountCode).toBe("4212");
      expect(entry.lines[0].debit).toBe("5900.00");
      expect(entry.lines[1].accountCode).toBe("1041");
      expect(entry.lines[1].credit).toBe("5900.00");
    });
  });

  describe("Integración Libro Diario, Libro Mayor y Balance de Comprobación", () => {
    let service: AccountingService;

    beforeEach(() => {
      service = new AccountingService();
    });

    it("ejecuta el ciclo contable completo con doble cuadre en el Balance de Comprobación", () => {
      const companyId = "20600000005";
      const period = "2026-03";

      // 1. Asiento de Venta: S/ 1,000 + IGV S/ 180 = S/ 1,180
      const saleEntry = buildSaleJournalEntry({
        id: "cpe-1",
        companyId,
        fullNumber: "F001-00000001",
        cpeType: "01",
        series: "F001",
        correlative: 1,
        issueDate: "2026-03-05",
        currency: "PEN",
        clientDocNumber: "20123456786",
        clientName: "CLIENTE A",
        subTotal: "1000.00",
        montoIgv: "180.00",
        totalPagar: "1180.00",
      });
      service.registerEntry(saleEntry);

      // 2. Asiento de Cobranza del 100% de la venta
      const collectionEntry = buildTreasuryJournalEntry({
        companyId,
        type: "COLLECTION",
        amount: "1180.00",
        date: "2026-03-08",
        treasuryAccount: "1041",
        referenceDoc: "F001-00000001",
        entityName: "CLIENTE A",
      });
      service.registerEntry(collectionEntry);

      // 3. Asiento de Compra de mercaderías: S/ 500 + IGV S/ 90 = S/ 590
      const { provisionEntry, destinationEntry } = buildPurchaseJournalEntries({
        id: "purch-1",
        car: "2060000000501F0010000100000000000001",
        companyRuc: companyId,
        accountingPeriod: period,
        supplier: { docType: "6", docNumber: "20123456786", name: "PROVEEDOR B" },
        docType: "01",
        series: "F001",
        correlative: "10",
        fullNumber: "F001-00000010",
        issueDate: "2026-03-10",
        currency: "PEN",
        paymentMethod: "CONTADO",
        isBancarizado: true,
        canUseFiscalCredit: true,
        totals: {
          baseGravadaExclusiva: "500.00",
          igvGravadoExclusivo: "90.00",
          baseGravadaComun: "0.00",
          igvGravadoComun: "0.00",
          baseGravadaSinCredito: "0.00",
          igvGravadoSinCredito: "0.00",
          adquisicionesNoGravadas: "0.00",
          isc: "0.00",
          icbper: "0.00",
          otrosCargos: "0.00",
          totalAdquisicion: "590.00",
          totalCreditoFiscal: "90.00",
        },
        items: [
          {
            description: "Mercaderías",
            quantity: "5",
            unitValue: "100.00",
            netBase: "500.00",
            taxDestination: "GRAVADO_EXCLUSIVO",
            classification: "1",
            igvAmount: "90.00",
            totalAmount: "590.00",
            hasFiscalCredit: true,
          },
        ],
        sireStatus: "ACEPTADO",
        createdAt: "2026-03-10T10:00:00Z",
      });

      service.registerEntry(provisionEntry);
      if (destinationEntry) {
        service.registerEntry(destinationEntry);
      }

      // 4. Asiento de Pago al proveedor
      const paymentEntry = buildTreasuryJournalEntry({
        companyId,
        type: "PAYMENT",
        amount: "590.00",
        date: "2026-03-15",
        treasuryAccount: "1041",
        referenceDoc: "F001-00000010",
        entityName: "PROVEEDOR B",
      });
      service.registerEntry(paymentEntry);

      // Verificación en Libro Diario
      const journalEntries = service.getJournalEntries(companyId, period);
      expect(journalEntries).toHaveLength(5);
      expect(journalEntries.map((e) => e.entryNumber)).toEqual([1, 2, 3, 4, 5]);

      // Generación y verificación del Libro Mayor
      const ledger = service.generateGeneralLedger(companyId, period);
      expect(ledger.accounts.length).toBeGreaterThanOrEqual(6);

      // Cuenta 1041: Entró 1,180 (Debe) y Salió 590 (Haber) -> Saldo Deudor S/ 590.00
      const acc1041 = ledger.accounts.find((a) => a.accountCode === "1041");
      expect(acc1041?.totalDebit).toBe("1180.00");
      expect(acc1041?.totalCredit).toBe("590.00");
      expect(acc1041?.debtorBalance).toBe("590.00");
      expect(acc1041?.creditorBalance).toBe("0.00");

      // Cuenta 1212: Emitida por 1,180 (Debe) y Cobrada por 1,180 (Haber) -> Saldo 0.00
      const acc1212 = ledger.accounts.find((a) => a.accountCode === "1212");
      expect(acc1212?.totalDebit).toBe("1180.00");
      expect(acc1212?.totalCredit).toBe("1180.00");
      expect(acc1212?.debtorBalance).toBe("0.00");
      expect(acc1212?.creditorBalance).toBe("0.00");

      // Cuenta 4212: Por pagar 590 (Haber) y Pagada 590 (Debe) -> Saldo 0.00
      const acc4212 = ledger.accounts.find((a) => a.accountCode === "4212");
      expect(acc4212?.totalDebit).toBe("590.00");
      expect(acc4212?.totalCredit).toBe("590.00");
      expect(acc4212?.debtorBalance).toBe("0.00");
      expect(acc4212?.creditorBalance).toBe("0.00");

      // Cuenta 40111: IGV Venta 180 (Haber) e IGV Compra 90 (Debe) -> Saldo Acreedor S/ 90.00 (IGV por pagar)
      const acc40111 = ledger.accounts.find((a) => a.accountCode === "40111");
      expect(acc40111?.totalDebit).toBe("90.00");
      expect(acc40111?.totalCredit).toBe("180.00");
      expect(acc40111?.debtorBalance).toBe("0.00");
      expect(acc40111?.creditorBalance).toBe("90.00");

      // Generación y verificación del Balance de Comprobación
      const trialBalance = service.generateTrialBalance(companyId, period);

      // Verificación innegociable de doble cuadre:
      // 1. Total Debe == Total Haber
      expect(trialBalance.totalDebitSum).toBe(trialBalance.totalCreditSum);
      // 2. Total Saldo Deudor == Total Saldo Acreedor
      expect(trialBalance.totalDebtorBalance).toBe(trialBalance.totalCreditorBalance);
      expect(trialBalance.isBalanced).toBe(true);
    });
  });
});
