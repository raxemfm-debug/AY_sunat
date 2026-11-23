import { describe, it, expect, beforeEach } from "vitest";
import {
  AccountingService,
  buildSaleJournalEntry,
  buildPurchaseJournalEntries,
  buildTreasuryJournalEntry,
  JournalEntry,
} from "../accounting/index.js";

const companyId = "20600000005";
const fiscalYear = "2026";

function makeSale(id = "sale-1", date = "2026-03-10", subTotal = "1000.00", igv = "180.00", total = "1180.00") {
  return buildSaleJournalEntry({
    id,
    companyId,
    fullNumber: `F001-${id.padStart(8, "0")}`,
    cpeType: "01",
    series: "F001",
    correlative: 1,
    issueDate: date,
    currency: "PEN",
    clientDocNumber: "20123456786",
    clientName: "CLIENTE COMERCIAL SAC",
    subTotal,
    montoIgv: igv,
    totalPagar: total,
  });
}

function makeServicePurchase(id = "purch-srv-1", date = "2026-04-15", base = "200.00", igv = "36.00", total = "236.00") {
  const { provisionEntry, destinationEntry } = buildPurchaseJournalEntries({
    id,
    car: "012345678901234567890123456",
    companyRuc: companyId,
    accountingPeriod: date.slice(0, 7),
    docType: "01",
    series: "E001",
    correlative: "10",
    fullNumber: "E001-00000010",
    issueDate: date,
    currency: "PEN",
    paymentMethod: "CREDITO",
    supplier: {
      docType: "6",
      docNumber: "20555555551",
      name: "ASESORIA TRIBUTARIA SAC",
    },
    totals: {
      baseGravadaExclusiva: base,
      igvGravadoExclusivo: igv,
      baseGravadaComun: "0.00",
      igvGravadoComun: "0.00",
      baseGravadaSinCredito: "0.00",
      igvGravadoSinCredito: "0.00",
      adquisicionesNoGravadas: "0.00",
      isc: "0.00",
      icbper: "0.00",
      otrosCargos: "0.00",
      totalAdquisicion: total,
      totalCreditoFiscal: igv,
    },
    items: [
      {
        description: "Servicio de auditoría",
        quantity: "1",
        unitValue: base,
        netBase: base,
        igvAmount: igv,
        totalAmount: total,
        taxDestination: "GRAVADO_EXCLUSIVO",
        classification: "3", // Servicios
        hasFiscalCredit: true,
      },
    ],
    isBancarizado: false,
    canUseFiscalCredit: true,
    sireStatus: "ACEPTADO",
    createdAt: new Date().toISOString(),
  });
  return { provisionEntry, destinationEntry: destinationEntry! };
}

describe("Cierre Contable Anual PCGE (Validación, Asientos de Cierre y Reapertura)", () => {
  let service: AccountingService;

  beforeEach(() => {
    service = new AccountingService();
  });

  describe("Validación de Saldos y Pre-Cierre Anual", () => {
    it("valida un ejercicio con asientos balanceados y calcula ingresos, gastos y utilidad", () => {
      service.registerEntry(makeSale("sale-1", "2026-02-15", "1000.00", "180.00", "1180.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-1", "2026-04-10", "300.00", "54.00", "354.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-02" });
      service.closePeriod({ companyId, period: "2026-04" });

      const val = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(val.isValid).toBe(true);
      expect(val.isDoubleEntryBalanced).toBe(true);
      expect(val.trialBalanceBalanced).toBe(true);
      expect(val.totalEntries).toBe(3);
      expect(val.netIncome).toBe("1000.00");
      expect(val.netExpense).toBe("300.00");
      expect(val.accountingResult).toBe("700.00");
      expect(val.resultType).toBe("PROFIT");
      expect(val.errors).toEqual([]);
    });

    it("rechaza ejercicio vacío salvo autorización explícita", () => {
      const valDefault = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(valDefault.isValid).toBe(false);
      expect(valDefault.errors[0]).toMatch(/no contiene asientos contables/);

      const valAllowed = service.validateFiscalYearForClosing(companyId, fiscalYear, { allowEmptyYear: true });
      expect(valAllowed.isValid).toBe(true);
    });

    it("detecta asientos desbalanceados e impide el cierre anual", () => {
      const corrupt: JournalEntry = {
        id: "corrupt-entry-annual",
        companyId,
        accountingPeriod: "2026-05",
        entryNumber: 1,
        entryDate: "2026-05-10",
        glosa: "Asiento manual con error en origen",
        currency: "PEN",
        lines: [
          { lineNumber: 1, accountCode: "1041", accountName: "Banco", debit: "500.00", credit: "0.00" },
          { lineNumber: 2, accountCode: "1212", accountName: "Por cobrar", debit: "0.00", credit: "450.00" },
        ],
        totalDebit: "500.00",
        totalCredit: "450.00",
        isBalanced: false,
        createdAt: new Date().toISOString(),
      };
      const seededService = new AccountingService([corrupt]);
      const val = seededService.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(val.isValid).toBe(false);
      expect(val.unbalancedEntries).toHaveLength(1);
      expect(() => seededService.closeFiscalYear({ companyId, fiscalYear })).toThrow(/No se puede cerrar el ejercicio/);
    });

    it("valida que los meses registrados estén cerrados cuando requireMonthlyClosed es true", () => {
      service.registerEntry(makeSale("sale-1", "2026-03-10"));
      // Mes 2026-03 está abierto
      const valStrict = service.validateFiscalYearForClosing(companyId, fiscalYear, { requireMonthlyClosed: true });
      expect(valStrict.isValid).toBe(false);
      expect(valStrict.unclosedPeriods).toContain("2026-03");

      // Si se cierra el mes 2026-03, pasa la validación estricta
      service.closePeriod({ companyId, period: "2026-03" });
      const valClosed = service.validateFiscalYearForClosing(companyId, fiscalYear, { requireMonthlyClosed: true });
      expect(valClosed.isValid).toBe(true);
      expect(valClosed.unclosedPeriods).toEqual([]);
    });
  });

  describe("Generación de Asientos de Cierre (Secuencia Técnica PCGE)", () => {
    it("genera los 4 asientos de cierre balanceados y el asiento de apertura para el año siguiente", () => {
      service.registerEntry(makeSale("sale-1", "2026-03-10", "1000.00", "180.00", "1180.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-1", "2026-04-10", "400.00", "72.00", "472.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-03" });
      service.closePeriod({ companyId, period: "2026-04" });

      const built = service.buildAnnualClosingEntries({
        companyId,
        fiscalYear,
        generateNextYearOpening: true,
      });

      // 1. Asiento 1: Clase 9 (941, 951) contra Cuenta 79 (791)
      expect(built.expenseByFunctionEntry).toBeDefined();
      const entry1 = built.expenseByFunctionEntry!;
      expect(entry1.lines.some((l) => l.accountCode === "79" || l.accountCode === "791")).toBe(true);
      expect(entry1.lines.some((l) => l.accountCode === "941")).toBe(true);
      expect(entry1.lines.some((l) => l.accountCode === "951")).toBe(true);

      // 2. Asiento 2: Cuentas de gestión (6 y 7) contra Resultado del Ejercicio (891)
      expect(built.resultsClosingEntry).toBeDefined();
      const entry2 = built.resultsClosingEntry;
      expect(entry2.lines.some((l) => l.accountCode === "70121" && l.debit === "1000.00")).toBe(true);
      expect(entry2.lines.some((l) => l.accountCode === "6321" && l.credit === "400.00")).toBe(true);
      expect(entry2.lines.some((l) => l.accountCode === "891" && l.credit === "600.00")).toBe(true);

      // 3. Asiento 3: Transferencia de utilidad a 5911
      expect(built.transferToAccumulatedEntry).toBeDefined();
      const entry3 = built.transferToAccumulatedEntry!;
      expect(entry3.lines.some((l) => l.accountCode === "891" && l.debit === "600.00")).toBe(true);
      expect(entry3.lines.some((l) => l.accountCode === "5911" && l.credit === "600.00")).toBe(true);

      // 4. Asiento 4: Cierre de cuentas de balance (Elementos 1 a 5)
      expect(built.balanceClosingEntry).toBeDefined();
      const entry4 = built.balanceClosingEntry;
      expect(entry4.lines.some((l) => l.accountCode === "1212" && l.credit === "1180.00")).toBe(true);
      expect(entry4.lines.some((l) => l.accountCode === "4212" && l.debit === "472.00")).toBe(true);
      expect(entry4.lines.some((l) => l.accountCode === "5911" && l.debit === "600.00")).toBe(true);

      // 5. Asiento 5: Asiento de apertura para 2027
      expect(built.nextYearOpeningEntry).toBeDefined();
      const opening = built.nextYearOpeningEntry!;
      expect(opening.accountingPeriod).toBe("2027-01");
      expect(opening.entryDate).toBe("2027-01-01");
      expect(opening.originDocument?.type).toBe("OPENING");
      // Debe ser el inverso del asiento 4
      expect(opening.lines.some((l) => l.accountCode === "1212" && l.debit === "1180.00")).toBe(true);
      expect(opening.lines.some((l) => l.accountCode === "4212" && l.credit === "472.00")).toBe(true);
      expect(opening.lines.some((l) => l.accountCode === "5911" && l.credit === "600.00")).toBe(true);
    });

    it("maneja correctamente un escenario de pérdida del ejercicio (cuenta 892 y 5921)", () => {
      // Ingreso 500, Gasto 800 -> Pérdida = -300
      service.registerEntry(makeSale("sale-loss", "2026-06-10", "500.00", "90.00", "590.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-loss", "2026-07-15", "800.00", "144.00", "944.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-06" });
      service.closePeriod({ companyId, period: "2026-07" });

      const val = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(val.resultType).toBe("LOSS");
      expect(val.accountingResult).toBe("-300.00");

      const built = service.buildAnnualClosingEntries({ companyId, fiscalYear });
      // Asiento 2 debe debitar la 892 por la pérdida
      const entry2 = built.resultsClosingEntry;
      expect(entry2.lines.some((l) => l.accountCode === "892" && l.debit === "300.00")).toBe(true);

      // Asiento 3 debe transferir la pérdida a la 5921 (debitada) cancelando la 892 (acreditada)
      const entry3 = built.transferToAccumulatedEntry!;
      expect(entry3.lines.some((l) => l.accountCode === "5921" && l.debit === "300.00")).toBe(true);
      expect(entry3.lines.some((l) => l.accountCode === "892" && l.credit === "300.00")).toBe(true);

      // Asiento 4 debe cerrar la 5921 en el Haber (ya que su saldo patrimonial es deudor)
      const entry4 = built.balanceClosingEntry;
      expect(entry4.lines.some((l) => l.accountCode === "5921" && l.credit === "300.00")).toBe(true);
    });
  });

  describe("Ejecución, Bloqueo y Saldado Total del Ejercicio", () => {
    it("ejecuta el cierre anual, deja todos los saldos del mayor en 0.00 y bloquea nuevos asientos", () => {
      service.registerEntry(makeSale("sale-1", "2026-01-20", "1000.00", "180.00", "1180.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-1", "2026-02-15", "400.00", "72.00", "472.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-01" });
      service.closePeriod({ companyId, period: "2026-02" });

      // Cierre anual
      const record = service.executeAnnualClose({
        companyId,
        fiscalYear,
        closedBy: "CONTADOR_GENERAL",
        notes: "Cierre anual 2026 definitivo",
        generateNextYearOpening: true,
      });

      expect(record.status).toBe("CLOSED");
      expect(record.closedBy).toBe("CONTADOR_GENERAL");
      expect(record.accountingResult).toBe("600.00");
      expect(record.resultType).toBe("PROFIT");
      expect(record.closingEntries.length).toBeGreaterThanOrEqual(3);
      expect(record.nextYearOpeningEntry).toBeDefined();

      // Verificación de saldos en postClosingTrialBalance:
      // Después de registrar los asientos de cierre anual, TODAS las cuentas deben tener saldo 0.00
      const postTrial = record.postClosingTrialBalance;
      expect(postTrial.isBalanced).toBe(true);
      for (const row of postTrial.rows) {
        expect(row.debtorBalance).toBe("0.00");
        expect(row.creditorBalance).toBe("0.00");
      }
      expect(postTrial.totalDebtorBalance).toBe("0.00");
      expect(postTrial.totalCreditorBalance).toBe("0.00");

      // Bloqueo: no se pueden registrar asientos en el ejercicio cerrado
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(true);
      expect(() =>
        service.registerEntry({
          companyId,
          accountingPeriod: "2026-08",
          entryDate: "2026-08-10",
          glosa: "Asiento fuera de plazo",
          lines: [
            { accountCode: "101", debit: "100.00", credit: "0.00" },
            { accountCode: "70121", debit: "0.00", credit: "100.00" },
          ],
        })
      ).toThrow(/Ejercicio contable bloqueado/);

      // Pero sí permite operar el año siguiente 2027
      const sale2027 = service.registerEntry(makeSale("sale-2027", "2027-01-15", "500.00", "90.00", "590.00"));
      expect(sale2027.accountingPeriod).toBe("2027-01");
    });

    it("impide ejecutar dos veces el cierre del mismo ejercicio fiscal", () => {
      service.registerEntry(makeSale("sale-1", "2026-01-20"));
      service.closePeriod({ companyId, period: "2026-01" });
      service.executeAnnualClose({ companyId, fiscalYear });
      expect(() => service.executeAnnualClose({ companyId, fiscalYear })).toThrow(/ya se encuentra cerrado/);
    });
  });

  describe("Reapertura Auditada del Ejercicio Anual", () => {
    it("exige usuario responsable y motivo válido (mínimo 5 caracteres)", () => {
      service.registerEntry(makeSale("sale-1", "2026-01-20"));
      service.closePeriod({ companyId, period: "2026-01" });
      service.executeAnnualClose({ companyId, fiscalYear });

      expect(() => service.reopenFiscalYear({ companyId, fiscalYear, reopenedBy: "", reason: "Ajuste documentado" }))
        .toThrow(/identificar al usuario responsable/);

      expect(() => service.reopenFiscalYear({ companyId, fiscalYear, reopenedBy: "AUDITOR", reason: "no" }))
        .toThrow(/motivo válido \(mínimo 5 caracteres\)/);
    });

    it("reabre el ejercicio, revierte los asientos de cierre, permite registrar ajustes y re-cerrar", () => {
      service.registerEntry(makeSale("sale-1", "2026-01-20", "1000.00", "180.00", "1180.00"));
      service.closePeriod({ companyId, period: "2026-01" });
      service.executeAnnualClose({ companyId, fiscalYear, generateNextYearOpening: true });
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(true);

      // Reabrir
      const reopened = service.reopenFiscalYear({
        companyId,
        fiscalYear,
        reopenedBy: "SUPERVISOR_CONTABLE",
        reason: "Ajuste por provisión de gastos omitida de diciembre",
      });
      expect(reopened.status).toBe("OPEN");
      expect(reopened.reopenReason).toContain("Ajuste por provisión");
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(false);

      // Registrar gasto de ajuste en 2026
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-late", "2026-12-28", "200.00", "36.00", "236.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-12" });

      // Volver a cerrar el año: el resultado ahora es 1000 - 200 = 800
      const reClosed = service.executeAnnualClose({
        companyId,
        fiscalYear,
        closedBy: "SUPERVISOR_CONTABLE",
        notes: "Cierre anual 2026 definitivo tras ajuste",
      });
      expect(reClosed.status).toBe("CLOSED");
      expect(reClosed.accountingResult).toBe("800.00");
      expect(reClosed.postClosingTrialBalance.totalDebtorBalance).toBe("0.00");
    });
  });

  describe("Integración Completa del Ciclo Anual", () => {
    it("integra ventas, compras, cobranzas, pagos, cierres mensuales y cierre anual con balance perfecto", () => {
      // 1. Enero: Venta 2000 + IGV 360 = 2360
      service.registerEntry(makeSale("sale-jan", "2026-01-15", "2000.00", "360.00", "2360.00"));
      // 2. Febrero: Cobro total de venta enero
      service.registerEntry(
        buildTreasuryJournalEntry({
          companyId,
          type: "COLLECTION",
          amount: "2360.00",
          date: "2026-02-05",
          treasuryAccount: "1041",
          referenceDoc: "F001-00000001",
          entityName: "CLIENTE COMERCIAL SAC",
        })
      );
      // 3. Marzo: Gasto 500 + IGV 90 = 590
      const srvMarch = makeServicePurchase("srv-mar", "2026-03-12", "500.00", "90.00", "590.00");
      service.registerEntry(srvMarch.provisionEntry);
      service.registerEntry(srvMarch.destinationEntry);
      // 4. Abril: Pago de la factura de servicio
      service.registerEntry(
        buildTreasuryJournalEntry({
          companyId,
          type: "PAYMENT",
          amount: "590.00",
          date: "2026-04-02",
          treasuryAccount: "1041",
          referenceDoc: "E001-00000010",
          entityName: "ASESORIA TRIBUTARIA SAC",
        })
      );

      // Cierre de meses
      service.closePeriod({ companyId, period: "2026-01" });
      service.closePeriod({ companyId, period: "2026-02" });
      service.closePeriod({ companyId, period: "2026-03" });
      service.closePeriod({ companyId, period: "2026-04" });

      // Validar ejercicio con exigencia de meses cerrados
      const preValidation = service.validateFiscalYearForClosing(companyId, fiscalYear, { requireMonthlyClosed: true });
      expect(preValidation.isValid).toBe(true);
      expect(preValidation.netIncome).toBe("2000.00");
      expect(preValidation.netExpense).toBe("500.00");
      expect(preValidation.accountingResult).toBe("1500.00");
      expect(preValidation.resultType).toBe("PROFIT");

      // Cierre Anual
      const closeRecord = service.executeAnnualClose({
        companyId,
        fiscalYear,
        closedBy: "CPC_TITULAR",
        notes: "Auditoría anual concluida sin observaciones",
        generateNextYearOpening: true,
      });

      expect(closeRecord.status).toBe("CLOSED");
      expect(closeRecord.accountingResult).toBe("1500.00");
      expect(closeRecord.closingEntries.length).toBe(4); // 9 vs 79, 6/7 vs 89, 89 vs 59, balance 1-5
      expect(closeRecord.postClosingTrialBalance.isBalanced).toBe(true);
      expect(closeRecord.postClosingTrialBalance.totalDebtorBalance).toBe("0.00");
      expect(closeRecord.postClosingTrialBalance.totalCreditorBalance).toBe("0.00");

      // Asiento de apertura para 2027 registrado en el libro diario
      expect(closeRecord.nextYearOpeningEntry).toBeDefined();
      expect(closeRecord.nextYearOpeningEntry?.accountingPeriod).toBe("2027-01");
      expect(closeRecord.nextYearOpeningEntry?.isOpening).toBe(true);

      // Verificar que el asiento de apertura tenga el saldo de caja/bancos en el Debe
      // Banco 1041: Cobro 2360 - Pago 590 = 1770
      const opening1041 = closeRecord.nextYearOpeningEntry?.lines.find((l) => l.accountCode === "1041");
      expect(opening1041?.debit).toBe("1770.00");

      // IGV por pagar en 40111: Venta 360 - Compra 90 = 270 en Haber
      const opening40111 = closeRecord.nextYearOpeningEntry?.lines.find((l) => l.accountCode === "40111");
      expect(opening40111?.credit).toBe("270.00");

      // Utilidad acumulada en 5911: 1500 en Haber
      const opening5911 = closeRecord.nextYearOpeningEntry?.lines.find((l) => l.accountCode === "5911");
      expect(opening5911?.credit).toBe("1500.00");

      // Comprobación de partida doble del asiento de apertura: 1770 (Debe) = 270 + 1500 = 1770 (Haber)
      expect(closeRecord.nextYearOpeningEntry?.totalDebit).toBe("1770.00");
      expect(closeRecord.nextYearOpeningEntry?.totalCredit).toBe("1770.00");
    });
  });

  describe("Validaciones de Bloqueo: Períodos Mensuales Abiertos y Asientos Pendientes", () => {
    it("bloquea el cierre anual si existen períodos mensuales con movimientos sin cerrar", () => {
      service.registerEntry(makeSale("sale-feb", "2026-02-15", "1000.00", "180.00", "1180.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("srv-may", "2026-05-20", "300.00", "54.00", "354.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);

      // Ambos períodos están abiertos: la validación debe fallar
      const val = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(val.isValid).toBe(false);
      expect(val.unclosedPeriods).toEqual(["2026-02", "2026-05"]);
      expect(val.errors.some((err) => err.includes("períodos mensuales con movimientos sin cerrar"))).toBe(true);

      // Intentar ejecutar el cierre debe lanzar excepción con los períodos afectados
      expect(() => service.executeAnnualClose({ companyId, fiscalYear })).toThrow(
        /períodos mensuales con movimientos sin cerrar \(2026-02, 2026-05\)/
      );

      // Cerramos solo 2026-02: todavía debe fallar por 2026-05
      service.closePeriod({ companyId, period: "2026-02" });
      const valPartial = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(valPartial.isValid).toBe(false);
      expect(valPartial.unclosedPeriods).toEqual(["2026-05"]);

      // Cerramos 2026-05: ahora debe superar la validación
      service.closePeriod({ companyId, period: "2026-05" });
      const valAllClosed = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(valAllClosed.isValid).toBe(true);
      expect(valAllClosed.unclosedPeriods).toEqual([]);

      // Y el cierre anual se ejecuta sin inconvenientes
      const record = service.executeAnnualClose({ companyId, fiscalYear });
      expect(record.status).toBe("CLOSED");
    });

    it("bloquea el cierre anual si existen asientos en borrador o pendientes de contabilizar (PENDING / DRAFT)", () => {
      service.registerEntry(makeSale("sale-mar", "2026-03-10", "800.00", "144.00", "944.00"));

      // Registramos un asiento en borrador / pendiente de contabilizar antes de cerrar el mes
      const draft = service.registerDraftEntry({
        companyId,
        accountingPeriod: "2026-03",
        entryDate: "2026-03-25",
        glosa: "Provisión preliminar pendiente de sustento",
        lines: [
          { accountCode: "6321", debit: "100.00", credit: "0.00" },
          { accountCode: "4212", debit: "0.00", credit: "100.00" },
        ],
      });

      // El mes 2026-03 se cierra con el borrador existente
      service.closePeriod({ companyId, period: "2026-03" });
      expect(draft.status).toBe("PENDING");

      // La validación anual debe detectar el asiento pendiente y rechazar el cierre
      const val = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(val.isValid).toBe(false);
      expect(val.pendingEntries.length).toBe(1);
      expect(val.pendingEntries[0].entryId).toBe(draft.id);
      expect(val.pendingEntries[0].glosa).toContain("Provisión preliminar");
      expect(val.errors.some((err) => err.includes("asiento(s) pendiente(s) de contabilizar"))).toBe(true);

      // Intentar cerrar el ejercicio debe arrojar error explícito
      expect(() => service.executeAnnualClose({ companyId, fiscalYear })).toThrow(
        /asiento\(s\) pendiente\(s\) de contabilizar/
      );

      // Contabilizamos formalmente el asiento con postEntry
      // Nota: Como 2026-03 estaba cerrado, reabrimos el período para aprobar el asiento y volvemos a cerrar
      service.reopenPeriod({ companyId, period: "2026-03", reopenedBy: "CONTADOR", reason: "Aprobar asiento pendiente" });
      const posted = service.postEntry(draft.id);
      expect(posted.status).toBe("POSTED");
      service.closePeriod({ companyId, period: "2026-03" });

      // Ahora no hay asientos pendientes y el cierre anual procede
      const valClean = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(valClean.isValid).toBe(true);
      expect(valClean.pendingEntries).toHaveLength(0);

      const record = service.executeAnnualClose({ companyId, fiscalYear });
      expect(record.status).toBe("CLOSED");
    });

    it("detecta transacciones pendientes reportadas externamente vía pendingEntries", () => {
      service.registerEntry(makeSale("sale-apr", "2026-04-12", "500.00", "90.00", "590.00"));
      service.closePeriod({ companyId, period: "2026-04" });

      // Pasamos una transacción pendiente de procesar (por ejemplo de cola SIRE o de facturación)
      const val = service.validateFiscalYearForClosing(companyId, fiscalYear, {
        pendingEntries: [
          {
            id: "sire-pend-01",
            period: "2026-04",
            glosa: "Comprobante de compra en SIRE sin propuesta aceptada",
            amount: "250.00",
          },
        ],
      });

      expect(val.isValid).toBe(false);
      expect(val.pendingEntries.length).toBe(1);
      expect(val.pendingEntries[0].entryId).toBe("sire-pend-01");
      expect(val.errors.some((err) => err.includes("asiento(s) pendiente(s) de contabilizar"))).toBe(true);
    });

    it("permite bypass controlado con allowOpenPeriods y allowPendingEntries si se autoriza explícitamente", () => {
      service.registerEntry(makeSale("sale-jun", "2026-06-15", "600.00", "108.00", "708.00"));
      // 2026-06 queda abierto intencionalmente
      service.registerDraftEntry({
        companyId,
        accountingPeriod: "2026-06",
        entryDate: "2026-06-20",
        glosa: "Asiento en revisión",
        lines: [
          { accountCode: "659", debit: "50.00", credit: "0.00" },
          { accountCode: "469", debit: "0.00", credit: "50.00" },
        ],
      });

      // Con bypass explícito:
      const val = service.validateFiscalYearForClosing(companyId, fiscalYear, {
        allowOpenPeriods: true,
        allowPendingEntries: true,
      });

      expect(val.isValid).toBe(true);
      expect(val.warnings.length).toBeGreaterThan(0);
      expect(val.unclosedPeriods).toContain("2026-06");
    });

    it("soporta requireAll12MonthsClosed para exigir que todo el calendario esté cerrado", () => {
      service.registerEntry(makeSale("sale-jan", "2026-01-10", "400.00", "72.00", "472.00"));
      service.closePeriod({ companyId, period: "2026-01" });

      // Por defecto solo exige los períodos con movimientos (2026-01 está cerrado)
      const valNormal = service.validateFiscalYearForClosing(companyId, fiscalYear);
      expect(valNormal.isValid).toBe(true);

      // Si se exige estricto los 12 meses:
      const valStrict12 = service.validateFiscalYearForClosing(companyId, fiscalYear, {
        requireAll12MonthsClosed: true,
      });
      expect(valStrict12.isValid).toBe(false);
      expect(valStrict12.unclosedPeriods).toHaveLength(11); // 2026-02 hasta 2026-12
      expect(valStrict12.unclosedPeriods).toContain("2026-12");
    });
  });


  describe("Vista previa de asientos anuales antes de confirmar el cierre (previewAnnualClose)", () => {
    it("genera la vista previa detallada con importes, cuentas PCGE, glosas y confirmación de balance para un ejercicio con utilidad", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-1", "2026-03-10", "2000.00", "360.00", "2360.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("purch-1", "2026-04-12", "600.00", "108.00", "708.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);

      service.closePeriod({ companyId, period: "2026-03" });
      service.closePeriod({ companyId, period: "2026-04" });

      const preview = service.previewAnnualClose({
        companyId,
        fiscalYear,
        generateNextYearOpening: true,
      });

      expect(preview.companyId).toBe(companyId);
      expect(preview.fiscalYear).toBe(fiscalYear);
      expect(preview.canClose).toBe(true);
      expect(preview.validation.isValid).toBe(true);
      expect(preview.resultType).toBe("PROFIT");
      expect(preview.netIncome).toBe("2000.00");
      expect(preview.netExpense).toBe("600.00");
      expect(preview.accountingResult).toBe("1400.00");

      // Verificamos resumen de asientos proyectados
      expect(preview.summary.totalPlannedEntries).toBe(5);
      expect(preview.summary.isDoubleEntryBalanced).toBe(true);
      expect(preview.summary.entriesByType.hasExpenseByFunction).toBe(true);
      expect(preview.summary.entriesByType.hasResultsDetermination).toBe(true);
      expect(preview.summary.entriesByType.hasTransferAccumulated).toBe(true);
      expect(preview.summary.entriesByType.hasBalanceClosing).toBe(true);
      expect(preview.summary.entriesByType.hasNextYearOpening).toBe(true);

      // Verificación detallada de Asiento 1 (Clase 9 vs 79)
      const entry1 = preview.entries.find((e) => e.entryType === "EXPENSE_BY_FUNCTION")!;
      expect(entry1).toBeDefined();
      expect(entry1.isBalanced).toBe(true);
      expect(entry1.totalDebit).toBe("600.00");
      expect(entry1.totalCredit).toBe("600.00");
      expect(entry1.lines.some((l) => l.accountCode === "791" && l.debit === "600.00")).toBe(true);
      expect(entry1.lines.some((l) => l.accountCode === "941" && l.credit === "300.00")).toBe(true);
      expect(entry1.lines.some((l) => l.accountCode === "951" && l.credit === "300.00")).toBe(true);

      // Verificación de Asiento 2 (Gestión 6 y 7 contra 891)
      const entry2 = preview.entries.find((e) => e.entryType === "RESULTS_DETERMINATION")!;
      expect(entry2).toBeDefined();
      expect(entry2.isBalanced).toBe(true);
      expect(entry2.lines.some((l) => l.accountCode === "70121" && l.debit === "2000.00")).toBe(true);
      expect(entry2.lines.some((l) => l.accountCode === "6321" && l.credit === "600.00")).toBe(true);
      expect(entry2.lines.some((l) => l.accountCode === "891" && l.credit === "1400.00")).toBe(true);

      // Verificación de Asiento 3 (Transferencia a 5911)
      const entry3 = preview.entries.find((e) => e.entryType === "TRANSFER_ACCUMULATED")!;
      expect(entry3).toBeDefined();
      expect(entry3.isBalanced).toBe(true);
      expect(entry3.lines.some((l) => l.accountCode === "891" && l.debit === "1400.00")).toBe(true);
      expect(entry3.lines.some((l) => l.accountCode === "5911" && l.credit === "1400.00")).toBe(true);

      // Verificación de Asiento 4 (Balance patrimonial 1 a 5 saldado)
      const entry4 = preview.entries.find((e) => e.entryType === "BALANCE_CLOSING")!;
      expect(entry4).toBeDefined();
      expect(entry4.isBalanced).toBe(true);
      expect(entry4.lines.some((l) => l.accountCode === "1212" && l.credit === "2360.00")).toBe(true);
      expect(entry4.lines.some((l) => l.accountCode === "5911" && l.debit === "1400.00")).toBe(true);

      // Verificación de Asiento 5 (Reapertura invertida)
      const entry5 = preview.entries.find((e) => e.entryType === "NEXT_YEAR_OPENING")!;
      expect(entry5).toBeDefined();
      expect(entry5.isOpening).toBe(true);
      expect(entry5.isBalanced).toBe(true);
      expect(entry5.accountingPeriod).toBe("2027-01");
      expect(entry5.lines.some((l) => l.accountCode === "1212" && l.debit === "2360.00")).toBe(true);
      expect(entry5.lines.some((l) => l.accountCode === "5911" && l.credit === "1400.00")).toBe(true);

      // Verificación de que todas las líneas tengan denominación de cuenta válida
      for (const entry of preview.entries) {
        expect(entry.lines.length).toBeGreaterThan(0);
        for (const line of entry.lines) {
          expect(line.accountCode).toBeTruthy();
          expect(line.accountName).toBeTruthy();
          expect(typeof line.debit).toBe("string");
          expect(typeof line.credit).toBe("string");
        }
      }
    });

    it("la vista previa es completamente inmutable y no modifica el estado contable hasta confirmar el cierre", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-imm-1", "2026-05-10", "1500.00", "270.00", "1770.00"));
      service.closePeriod({ companyId, period: "2026-05" });

      const initialEntriesCount = service.getJournalEntries(companyId).length;

      // Se solicita la vista previa
      const preview = service.previewAnnualClose({ companyId, fiscalYear });
      expect(preview.canClose).toBe(true);

      // El estado debe permanecer intacto
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(false);
      expect(service.getFiscalYearCloseRecord(companyId, fiscalYear)).toBeUndefined();
      expect(service.getJournalEntries(companyId).length).toBe(initialEntriesCount);

      // Confirmar el cierre formal posteriormente
      const record = service.closeFiscalYear({
        companyId,
        fiscalYear,
        closedBy: "CPC_CONTADOR_GENERAL",
      });
      expect(record.status).toBe("CLOSED");
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(true);
      expect(service.getJournalEntries(companyId).length).toBeGreaterThan(initialEntriesCount);
    });

    it("muestra la vista previa de asientos proyectados aun cuando existan períodos mensuales abiertos pero marca canClose como false", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-open-1", "2026-02-15", "3000.00", "540.00", "3540.00"));
      service.registerEntry(makeSale("sale-open-2", "2026-06-20", "2000.00", "360.00", "2360.00"));

      // NO cerramos ningún período mensual
      const preview = service.previewAnnualClose({
        companyId,
        fiscalYear,
      });

      // El cierre está bloqueado para confirmación
      expect(preview.canClose).toBe(false);
      expect(preview.validation.isValid).toBe(false);
      expect(preview.validation.errors.some((err) => err.includes("2026-02") || err.includes("2026-06"))).toBe(true);

      // Pero los asientos proyectados se construyeron para que el usuario pueda revisarlos anticipadamente
      expect(preview.entries.length).toBeGreaterThanOrEqual(3);
      expect(preview.accountingResult).toBe("5000.00");
      expect(preview.resultType).toBe("PROFIT");
      expect(preview.summary.isDoubleEntryBalanced).toBe(true);
    });

    it("detecta asientos en borrador o pendientes en la vista previa y detalla los impedimentos", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-draft-1", "2026-07-10", "1000.00", "180.00", "1180.00"));
      service.closePeriod({ companyId, period: "2026-07" });

      // Se registra un asiento en borrador
      service.registerDraftEntry({
        companyId,
        accountingPeriod: "2026-08",
        entryDate: "2026-08-15",
        glosa: "Asiento de ajuste pendiente de revisión",
        lines: [
          { accountCode: "6311", debit: "100.00", credit: "0.00" },
          { accountCode: "4212", debit: "0.00", credit: "100.00" },
        ],
      });

      const preview = service.previewAnnualClose({ companyId, fiscalYear });
      expect(preview.canClose).toBe(false);
      expect(preview.validation.pendingEntries.length).toBe(1);
      expect(preview.validation.pendingEntries[0].glosa).toContain("ajuste pendiente");
    });

    it("genera un reporte en texto claro y legible con cuentas, denominaciones y columnas Debe/Haber", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-rep-1", "2026-09-10", "1000.00", "180.00", "1180.00"));
      service.closePeriod({ companyId, period: "2026-09" });

      const preview = service.previewAnnualClose({ companyId, fiscalYear });
      const report = service.formatAnnualClosingPreview(preview);

      expect(typeof report).toBe("string");
      expect(report).toContain("VISTA PREVIA DE ASIENTOS DE CIERRE ANUAL");
      expect(report).toContain(companyId);
      expect(report).toContain(fiscalYear);
      expect(report).toContain("DEBE (S/)");
      expect(report).toContain("HABER (S/)");
      expect(report).toContain("70121");
      expect(report).toContain("891");
      expect(report).toContain("5911");
      expect(report).toContain("TOTAL CONSOLIDADO CIERRE");
    });

    it("genera vista previa de cierre anual con pérdida contable (cuentas 892 y 5921)", () => {
      const service = new AccountingService();
      // Venta de 200 y Gasto de 500 => Pérdida de 300
      service.registerEntry(makeSale("sale-loss", "2026-10-10", "200.00", "36.00", "236.00"));
      const { provisionEntry, destinationEntry } = makeServicePurchase("purch-loss", "2026-10-15", "500.00", "90.00", "590.00");
      service.registerEntry(provisionEntry);
      service.registerEntry(destinationEntry);
      service.closePeriod({ companyId, period: "2026-10" });

      const preview = service.previewAnnualClose({ companyId, fiscalYear });

      expect(preview.canClose).toBe(true);
      expect(preview.resultType).toBe("LOSS");
      expect(preview.accountingResult).toBe("-300.00");

      // Asiento 2 debe debitar la 892 (Pérdida del ejercicio)
      const entry2 = preview.entries.find((e) => e.entryType === "RESULTS_DETERMINATION")!;
      expect(entry2.lines.some((l) => l.accountCode === "892" && l.debit === "300.00")).toBe(true);

      // Asiento 3 debe transferir a la 5921 (debitada) y cancelar la 892 (acreditada)
      const entry3 = preview.entries.find((e) => e.entryType === "TRANSFER_ACCUMULATED")!;
      expect(entry3.lines.some((l) => l.accountCode === "5921" && l.debit === "300.00")).toBe(true);
      expect(entry3.lines.some((l) => l.accountCode === "892" && l.credit === "300.00")).toBe(true);

      // Asiento 4 (Balance) debe acreditar la 5921 por 300.00 para cuadrar el patrimonio
      const entry4 = preview.entries.find((e) => e.entryType === "BALANCE_CLOSING")!;
      expect(entry4.lines.some((l) => l.accountCode === "5921" && l.credit === "300.00")).toBe(true);
      expect(entry4.isBalanced).toBe(true);
    });

    it("impide generar vista previa de un ejercicio que ya fue cerrado previamente", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-closed", "2026-11-10", "1000.00", "180.00", "1180.00"));
      service.closePeriod({ companyId, period: "2026-11" });

      // Se cierra el ejercicio formalmente
      service.closeFiscalYear({ companyId, fiscalYear });
      expect(service.isFiscalYearClosed(companyId, fiscalYear)).toBe(true);

      // La vista previa debe rechazar el ejercicio ya cerrado
      expect(() => {
        service.previewAnnualClose({ companyId, fiscalYear });
      }).toThrow(/ya se encuentra cerrado/);
    });

    it("permite forzar canClose a true si se pasan opciones de validación permisivas explícitas", () => {
      const service = new AccountingService();
      service.registerEntry(makeSale("sale-open-perm", "2026-01-10", "1000.00", "180.00", "1180.00"));
      // El período mensual 2026-01 está abierto, pero se pasa allowOpenPeriods: true
      const preview = service.previewAnnualClose({
        companyId,
        fiscalYear,
        validationOptions: { allowOpenPeriods: true },
      });

      expect(preview.canClose).toBe(true);
      expect(preview.entries.length).toBeGreaterThanOrEqual(3);
    });
  });

});
