import { describe, expect, it } from 'vitest';
import { COMPANY_RUC, purchaseInput, saleEntry } from './fixtures.js';
import { createPersistence } from '../persistence.js';
import { MemoryPurchaseRepository, DuplicatePurchaseError } from '../repositories/purchase.repository.js';
import { MemoryAccountingLedgerRepository, ConcurrentPeriodChangeError } from '../repositories/accounting-ledger.repository.js';
import { PersistentPurchaseService } from '../../modules/purchases/persistent-purchase-service.js';
import { PersistentAccountingService } from '../../modules/accounting/persistent-accounting-service.js';

describe('Fábrica de persistencia', () => {
  it('usa memoria cuando no hay DATABASE_URL fuera de producción', async () => {
    const persistence = createPersistence({ allowMemory: true });
    expect(persistence.kind).toBe('memory');
    await persistence.close();
  });

  it('exige DATABASE_URL cuando no se permite memoria', () => {
    expect(() => createPersistence({ allowMemory: false })).toThrow(/DATABASE_URL es obligatoria/);
  });
});

describe('PersistentPurchaseService (repositorio en memoria)', () => {
  it('registra, bloquea duplicados y resume el período', async () => {
    const service = new PersistentPurchaseService(new MemoryPurchaseRepository());
    const saved = await service.registerPurchase(purchaseInput());
    expect(saved.totals.totalCreditoFiscal).toBe('180.00');
    await expect(service.registerPurchase(purchaseInput())).rejects.toBeInstanceOf(DuplicatePurchaseError);

    const summary = await service.getMonthlySummary(COMPANY_RUC, '2026-03');
    expect(summary.totalDocuments).toBe(1);
    expect(summary.totalAdquisiciones).toBe('1180.00');
  });

  it('los datos guardados no cambian si se modifica el objeto devuelto', async () => {
    const repo = new MemoryPurchaseRepository();
    const service = new PersistentPurchaseService(repo);
    const saved = await service.registerPurchase(purchaseInput());
    saved.totals.totalAdquisicion = '0.00';
    expect((await service.findByCar(COMPANY_RUC, saved.car))?.totals.totalAdquisicion).toBe('1180.00');
  });
});

describe('PersistentAccountingService (repositorio en memoria)', () => {
  it('guarda asientos, cierra el período y bloquea nuevos asientos', async () => {
    const service = new PersistentAccountingService(new MemoryAccountingLedgerRepository());
    await service.registerEntry(saleEntry(COMPANY_RUC));
    await service.closePeriod({ companyId: COMPANY_RUC, period: '2026-03' });
    await expect(service.registerEntry(saleEntry(COMPANY_RUC))).rejects.toThrow(/Período contable bloqueado/);
  });

  it('detecta cierres calculados con datos desactualizados', async () => {
    const repo = new MemoryAccountingLedgerRepository();
    const service = new PersistentAccountingService(repo);
    await service.registerEntry(saleEntry(COMPANY_RUC));
    const stale = (await service.loadService(COMPANY_RUC, '2026')).closePeriod({ companyId: COMPANY_RUC, period: '2026-03' });
    await service.registerEntry(saleEntry(COMPANY_RUC));
    await expect(repo.savePeriod(stale, 'OPEN')).rejects.toBeInstanceOf(ConcurrentPeriodChangeError);
  });

  it('respeta el cierre del ejercicio anual', async () => {
    const repo = new MemoryAccountingLedgerRepository();
    repo.markFiscalYearClosed(COMPANY_RUC, '2026');
    const service = new PersistentAccountingService(repo);
    await expect(service.registerEntry(saleEntry(COMPANY_RUC))).rejects.toThrow(/Ejercicio contable bloqueado/);
  });
});
