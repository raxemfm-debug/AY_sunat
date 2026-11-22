import { describe, it, expect, beforeEach } from "vitest";
import {
  AccountingService,
  buildSaleJournalEntry,
  buildTreasuryJournalEntry,
  JournalEntry,
} from "../accounting/index.js";

const companyId = "20600000005";
const period = "2026-03";

function saleEntry(id = "sale-1", issueDate = "2026-03-10") {
  return buildSaleJournalEntry({
    id,
    companyId,
    fullNumber: "F001-00000001",
    cpeType: "01",
    series: "F001",
    correlative: 1,
    issueDate,
    currency: "PEN",
    clientDocNumber: "20123456786",
    clientName: "CLIENTE DEMO SAC",
    subTotal: "1000.00",
    montoIgv: "180.00",
    totalPagar: "1180.00",
  });
}

describe("Cierre contable mensual e integración", () => {
  let service: AccountingService;
  beforeEach(() => { service = new AccountingService(); });

  it("valida el cuadre de cada asiento y el balance del período antes del cierre", () => {
    service.registerEntry(saleEntry());
    const result = service.validatePeriodForClosing(companyId, period);
    expect(result.isValid).toBe(true);
    expect(result.isDoubleEntryBalanced).toBe(true);
    expect(result.totalEntries).toBe(1);
    expect(result.totalDebit).toBe("1180.00");
    expect(result.totalCredit).toBe("1180.00");
    expect(result.errors).toEqual([]);
  });

  it("rechaza períodos vacíos por defecto y permite el cierre vacío solo si se autoriza", () => {
    expect(service.validatePeriodForClosing(companyId, period).isValid).toBe(false);
    expect(() => service.closePeriod({ companyId, period })).toThrow(/no contiene asientos/);
    const record = service.closePeriod({ companyId, period, allowEmptyPeriod: true });
    expect(record.status).toBe("CLOSED");
    expect(record.totalEntries).toBe(0);
  });

  it("detecta asientos preexistentes desbalanceados y no cierra el período", () => {
    const invalid: JournalEntry = {
      id: "corrupt-entry", companyId, accountingPeriod: period, entryNumber: 1,
      entryDate: "2026-03-10", glosa: "Registro legado dañado", currency: "PEN",
      lines: [
        { lineNumber: 1, accountCode: "1041", accountName: "Banco", debit: "500.00", credit: "0.00" },
        { lineNumber: 2, accountCode: "1212", accountName: "Cuentas por cobrar", debit: "0.00", credit: "400.00" },
      ], totalDebit: "500.00", totalCredit: "400.00", isBalanced: false,
      createdAt: new Date().toISOString(),
    };
    const seeded = new AccountingService([invalid]);
    const validation = seeded.validatePeriodForClosing(companyId, period);
    expect(validation.isValid).toBe(false);
    expect(validation.unbalancedEntries).toHaveLength(1);
    expect(validation.unbalancedEntries[0].difference).toBe("100.00");
    expect(() => seeded.closePeriod({ companyId, period })).toThrow(/No se puede cerrar/);
  });

  it("cierra con snapshot, usuario y notas y rechaza un segundo cierre", () => {
    service.registerEntry(saleEntry());
    const record = service.closePeriod({ companyId, period, closedBy: "CONTADOR", notes: "Cierre revisado" });
    expect(record.status).toBe("CLOSED");
    expect(record.closedBy).toBe("CONTADOR");
    expect(record.closingNotes).toBe("Cierre revisado");
    expect(record.closedAt).toBeTruthy();
    expect(record.trialBalanceSnapshot?.isBalanced).toBe(true);
    expect(service.isPeriodClosed(companyId, period)).toBe(true);
    expect(() => service.closePeriod({ companyId, period })).toThrow(/ya se encuentra cerrado/);
  });

  it("bloquea asientos manuales y generados en período cerrado, pero deja operar el período siguiente", () => {
    service.registerEntry(saleEntry());
    service.closePeriod({ companyId, period });
    expect(() => service.registerEntry({
      companyId, accountingPeriod: period, entryDate: "2026-03-25", glosa: "Manual tardío",
      lines: [
        { accountCode: "101", debit: "100.00", credit: "0.00" },
        { accountCode: "70121", debit: "0.00", credit: "100.00" },
      ],
    })).toThrow(/Período contable bloqueado/);
    expect(() => service.registerEntry(saleEntry("late", "2026-03-31"))).toThrow(/Período contable bloqueado/);
    const april = service.registerEntry(saleEntry("april", "2026-04-01"));
    expect(april.accountingPeriod).toBe("2026-04");
  });

  it("permite reabrir con motivo y responsable obligatorios, registrar ajuste y volver a cerrar", () => {
    service.registerEntry(saleEntry());
    service.closePeriod({ companyId, period });
    expect(() => service.reopenPeriod({ companyId, period, reopenedBy: "", reason: "Ajuste válido" }))
      .toThrow(/identificar al usuario/);
    expect(() => service.reopenPeriod({ companyId, period, reopenedBy: "SUPERVISOR", reason: "no" }))
      .toThrow(/motivo o justificación/);
    const reopened = service.reopenPeriod({ companyId, period, reopenedBy: "SUPERVISOR", reason: "Corrección documentada" });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.reopenReason).toBe("Corrección documentada");
    service.registerEntry({
      companyId, accountingPeriod: period, entryDate: "2026-03-31", glosa: "Ajuste mensual",
      lines: [
        { accountCode: "6321", debit: "300.00", credit: "0.00" },
        { accountCode: "4212", debit: "0.00", credit: "300.00" },
      ],
    });
    expect(service.closePeriod({ companyId, period }).status).toBe("CLOSED");
  });

  it("integra venta, cobranza, balance de comprobación y bloqueo final del cierre", () => {
    service.registerEntry(saleEntry());
    service.registerEntry(buildTreasuryJournalEntry({
      companyId, type: "COLLECTION", amount: "1180.00", date: "2026-03-12",
      treasuryAccount: "1041", referenceDoc: "F001-00000001", entityName: "CLIENTE DEMO SAC",
    }));
    const trial = service.generateTrialBalance(companyId, period);
    expect(trial.isBalanced).toBe(true);
    expect(trial.totalDebitSum).toBe(trial.totalCreditSum);
    const record = service.closePeriod({ companyId, period, closedBy: "CPC", notes: "Integración" });
    expect(record.totalEntries).toBe(2);
    expect(service.getPeriodRecord(companyId, period).status).toBe("CLOSED");
    expect(service.listPeriods(companyId).find((item) => item.period === period)?.status).toBe("CLOSED");
    expect(() => service.registerEntry(buildTreasuryJournalEntry({
      companyId, type: "PAYMENT", amount: "10.00", date: "2026-03-20",
      treasuryAccount: "1041", referenceDoc: "PROV-1", entityName: "PROVEEDOR",
    }))).toThrow(/Período contable bloqueado/);
  });
});
