/**
 * Pruebas de integración contra PostgreSQL real.
 * Se ejecutan solo si TEST_DATABASE_URL apunta a un servidor donde el usuario pueda crear bases
 * (por ejemplo, el Postgres local de `npx supabase start`). Cada corrida usa una base temporal.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { createTestDatabase, TestDatabase, truncateAll } from './helpers/pg-test-database.js';
import { companyDto, COMPANY_RUC, cpeDto, cpeItems, purchaseInput, saleEntry, SUPPLIER_RUC } from './fixtures.js';
import { createPersistence, Persistence } from '../persistence.js';
import { PostgresCompanyRepository } from '../postgres/postgres-company.repository.js';
import { ConcurrentPeriodChangeError } from '../repositories/accounting-ledger.repository.js';
import { DuplicatePurchaseError } from '../repositories/purchase.repository.js';
import { PersistentPurchaseService } from '../../modules/purchases/persistent-purchase-service.js';
import { PersistentAccountingService } from '../../modules/accounting/persistent-accounting-service.js';
import { AccountingService } from '../../modules/accounting/accounting-service.js';
import { CpeEmissionOrchestrator } from '../../modules/cpe/cpe-orchestrator.js';

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)('Persistencia PostgreSQL real', () => {
  let db: TestDatabase;
  let persistence: Persistence;

  beforeAll(async () => {
    db = await createTestDatabase(adminUrl!);
    persistence = createPersistence({ pool: db.pool });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await truncateAll(db.pool);
  });

  describe('Empresas y series', () => {
    it('guarda la empresa con sus series por defecto y la recupera desde otra instancia', async () => {
      const company = await persistence.companies.create(companyDto());
      const freshRepo = new PostgresCompanyRepository(db.pool);

      const loaded = await freshRepo.findByRuc(COMPANY_RUC);
      expect(loaded?.id).toBe(company.id);
      expect(loaded?.legalName).toBe('Jose Barrientos Negocios');
      expect((await freshRepo.listSeriesByCompany(company.id)).map((s) => s.series).sort()).toEqual([
        'B001', 'BC01', 'F001', 'FC01',
      ]);
    });

    it('rechaza RUC duplicado sin dejar series huérfanas', async () => {
      await persistence.companies.create(companyDto());
      await expect(persistence.companies.create(companyDto())).rejects.toThrow(/Ya existe una empresa/);
      const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM document_series');
      expect(rows[0].n).toBe(4);
    });

    it('actualiza datos y devuelve null para identificadores inexistentes o mal formados', async () => {
      const company = await persistence.companies.create(companyDto());
      const updated = await persistence.companies.update(company.id, { tradeName: '  NUEVO NOMBRE ', isHabido: false });
      expect(updated.tradeName).toBe('NUEVO NOMBRE');
      expect(updated.isHabido).toBe(false);
      expect(await persistence.companies.findById('no-es-uuid')).toBeNull();
      expect(await persistence.companies.findById('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('asigna correlativos únicos aunque se pidan en paralelo', async () => {
      const company = await persistence.companies.create(companyDto());
      const results = await Promise.all(
        Array.from({ length: 25 }, () => persistence.companies.getNextFullNumber(company.id, '01', 'F001')),
      );
      const numbers = results.map((r) => r.correlative).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(new Set(results.map((r) => r.fullNumber)).size).toBe(25);
    });

    it('distingue serie inactiva de serie no configurada', async () => {
      const company = await persistence.companies.create(companyDto());
      await db.pool.query(`UPDATE document_series SET is_active = false WHERE series = 'B001'`);
      await expect(persistence.companies.incrementCorrelative(company.id, '03', 'B001')).rejects.toThrow(/inactiva/);
      await expect(persistence.companies.incrementCorrelative(company.id, '01', 'F999')).rejects.toThrow(/no configurada/);
    });
  });

  describe('Comprobantes emitidos', () => {
    let companyId: string;
    beforeEach(async () => {
      companyId = (await persistence.companies.create(companyDto())).id;
    });

    it('guarda cabecera e ítems conservando montos decimales y fechas exactas', async () => {
      const created = await persistence.cpe.create(cpeDto(companyId), cpeItems());
      const loaded = await persistence.cpe.findByFullNumber(companyId, 'f001-00000001');

      expect(loaded?.document.id).toBe(created.document.id);
      expect(loaded?.document.issueDate).toBe('2026-03-05');
      expect(loaded?.document.issueTime).toBe('10:15:00');
      expect(loaded?.document.totalPagar).toBe('2360.00');
      expect(loaded?.document.operacionesExoneradas).toBe('0.00');
      expect(loaded?.document.rawPayload).toEqual({ origen: 'prueba' });
      expect(loaded?.items).toHaveLength(1);
      expect(loaded?.items[0].quantity).toBe('1.0000');
      expect(loaded?.items[0].igvAmount).toBe('360.00');
    });

    it('rechaza el mismo número de comprobante y revierte la transacción completa', async () => {
      await persistence.cpe.create(cpeDto(companyId), cpeItems());
      await expect(persistence.cpe.create(cpeDto(companyId), cpeItems())).rejects.toThrow(/ya se encuentra registrado/);
      const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM cpe_items');
      expect(rows[0].n).toBe(1);
    });

    it('registra la CDR y filtra comprobantes por estado y fecha', async () => {
      const first = await persistence.cpe.create(cpeDto(companyId), cpeItems());
      await persistence.cpe.create(
        cpeDto(companyId, { correlative: 2, fullNumber: 'F001-00000002', issueDate: '2026-04-01' }),
        cpeItems(),
      );

      const accepted = await persistence.cpe.attachCdr(first.document.id, {
        cdrReceivedAt: '2026-03-05T15:20:00.000Z',
        sunatResponseCode: '0',
        sunatDescription: 'Aceptada',
        xmlHash: 'abc123',
      });
      expect(accepted.status).toBe('ACEPTADO');
      expect(accepted.cdrReceivedAt).toBe('2026-03-05T15:20:00.000Z');

      expect((await persistence.cpe.listByCompany(companyId, { status: 'ACEPTADO' })).map((d) => d.fullNumber)).toEqual([
        'F001-00000001',
      ]);
      expect((await persistence.cpe.listByCompany(companyId, { startDate: '2026-04-01' })).map((d) => d.fullNumber)).toEqual([
        'F001-00000002',
      ]);
      await expect(persistence.cpe.updateStatus('00000000-0000-0000-0000-000000000000', { status: 'RECHAZADO' }))
        .rejects.toThrow(/no encontrado/);
    });

    it('el orquestador emite una factura de punta a punta y la deja guardada en PostgreSQL', async () => {
      const cdrXml = `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>R-F001-00000001</cbc:ID>
  <cac:DocumentResponse><cac:Response>
    <cbc:ReferenceID>F001-00000001</cbc:ReferenceID>
    <cbc:ResponseCode>0</cbc:ResponseCode>
    <cbc:Description>Aceptada</cbc:Description>
  </cac:Response></cac:DocumentResponse>
</ar:ApplicationResponse>`;
      const zip = new JSZip();
      zip.file(`R-${COMPANY_RUC}-01-F001-00000001.xml`, cdrXml);
      const cdrZip = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
      const soap = `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
        xmlns:ser="http://service.sunat.gob.pe"><soapenv:Body><ser:sendBillResponse>
        <applicationResponse>${cdrZip}</applicationResponse></ser:sendBillResponse></soapenv:Body></soapenv:Envelope>`;
      const fetchMock = vi.fn().mockResolvedValue({ status: 200, ok: true, text: async () => soap });

      await persistence.companies.update(companyId, { solUserEncrypted: 'MODDATOS', solPassEncrypted: 'moddatos' });
      const orchestrator = new CpeEmissionOrchestrator({ companyRepo: persistence.companies, cpeRepo: persistence.cpe });
      const result = await orchestrator.emitDocument(
        {
          companyId,
          cpeType: '01',
          series: 'F001',
          client: { docType: '6', docNumber: '20123456789', name: 'CORPORACION INDUSTRIAL S.A.C.' },
          paymentMethod: 'CONTADO',
          items: [{ code: 'S1', description: 'Servicio', quantity: '1', unitPrice: '2360.00', priceIncludesIgv: true, affectationType: '10' }],
        },
        { customFetchFn: fetchMock as never },
      );

      expect(result.status).toBe('ACEPTADO');
      const stored = await persistence.cpe.findById(result.cpeId);
      expect(stored?.document.fullNumber).toBe('F001-00000001');
      expect(stored?.document.status).toBe('ACEPTADO');
      expect(stored?.document.totalPagar).toBe('2360.00');
      expect(stored?.document.xmlHash).toBe(result.hashCpe);
      expect((await persistence.companies.getSeries(companyId, '01', 'F001'))?.currentCorrelative).toBe(1);
    });
  });

  describe('Registro de compras (RCE)', () => {
    let purchases: PersistentPurchaseService;
    beforeEach(() => {
      purchases = new PersistentPurchaseService(persistence.purchases);
    });

    it('guarda la compra calculada y la devuelve idéntica desde la base de datos', async () => {
      const saved = await purchases.registerPurchase(purchaseInput());
      const loaded = await purchases.findByCar(COMPANY_RUC, saved.car);

      expect(loaded?.car).toBe('2012345678601F0010000001234');
      expect(loaded?.totals.totalAdquisicion).toBe('1180.00');
      expect(loaded?.totals.totalCreditoFiscal).toBe('180.00');
      expect(loaded?.items[0]).toMatchObject({ quantity: '10.0000', unitValue: '100.00', netBase: '1000.00' });
      expect(loaded?.supplier.name).toBe('PROVEEDOR CENTRAL S.A.C.');
      expect(await persistence.purchases.getSupplier(COMPANY_RUC, SUPPLIER_RUC)).not.toBeNull();
    });

    it('bloquea el mismo comprobante en el mismo o en otro período', async () => {
      await purchases.registerPurchase(purchaseInput());
      await expect(purchases.registerPurchase(purchaseInput())).rejects.toBeInstanceOf(DuplicatePurchaseError);
      await expect(purchases.registerPurchase(purchaseInput({ accountingPeriod: '2026-04', correlative: '00001234' })))
        .rejects.toBeInstanceOf(DuplicatePurchaseError);
      expect(await purchases.hasPurchase(COMPANY_RUC, SUPPLIER_RUC, '01', 'F001', 1234)).toBe(true);
    });

    it('si dos registros del mismo comprobante llegan a la vez, solo uno se guarda', async () => {
      const results = await Promise.allSettled([
        purchases.registerPurchase(purchaseInput()),
        purchases.registerPurchase(purchaseInput()),
        purchases.registerPurchase(purchaseInput()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.every((r) => r.reason instanceof DuplicatePurchaseError)).toBe(true);
      expect(await purchases.listByPeriod(COMPANY_RUC, '2026-03')).toHaveLength(1);
    });

    it('el resumen mensual excluye compras marcadas EXCLUIDO en SIRE', async () => {
      const first = await purchases.registerPurchase(purchaseInput());
      await purchases.registerPurchase(purchaseInput({ correlative: 1235 }));
      expect((await purchases.getMonthlySummary(COMPANY_RUC, '2026-03')).totalCreditoFiscalAceptado).toBe('360.00');

      await purchases.updateSireStatus(COMPANY_RUC, first.car, 'EXCLUIDO');
      const summary = await purchases.getMonthlySummary(COMPANY_RUC, '2026-03');
      expect(summary.totalDocuments).toBe(1);
      expect(summary.totalCreditoFiscalAceptado).toBe('180.00');
    });
  });

  describe('Contabilidad (Libro Diario y cierre mensual)', () => {
    let accounting: PersistentAccountingService;
    beforeEach(() => {
      accounting = new PersistentAccountingService(persistence.ledger);
    });

    it('guarda asientos con numeración correlativa y los reconstruye en otra instancia', async () => {
      await accounting.registerEntry(saleEntry(COMPANY_RUC));
      await accounting.registerEntry(saleEntry(COMPANY_RUC, { glosa: 'Venta F001-00000002' }));

      const reloaded = new PersistentAccountingService(createPersistence({ pool: db.pool }).ledger);
      const entries = await reloaded.getJournalEntries(COMPANY_RUC, '2026-03');
      expect(entries.map((e) => e.entryNumber)).toEqual([1, 2]);
      expect(entries[0].lines.map((l) => [l.accountCode, l.debit, l.credit])).toEqual([
        ['1212', '1180.00', '0.00'],
        ['40111', '0.00', '180.00'],
        ['70121', '0.00', '1000.00'],
      ]);
      const trial = await reloaded.generateTrialBalance(COMPANY_RUC, '2026-03');
      expect(trial.isBalanced).toBe(true);
    });

    it('no guarda asientos desbalanceados', async () => {
      await expect(
        accounting.registerEntry(saleEntry(COMPANY_RUC, {
          lines: [{ accountCode: '1212', debit: '100.00' }, { accountCode: '70121', credit: '90.00' }],
        })),
      ).rejects.toThrow(/desbalanceado/);
      expect(await accounting.getJournalEntries(COMPANY_RUC)).toHaveLength(0);
    });

    it('numera sin huecos ni repetidos cuando se registran asientos en paralelo', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) => accounting.registerEntry(saleEntry(COMPANY_RUC, { glosa: `Venta ${i}` }))),
      );
      const numbers = (await accounting.getJournalEntries(COMPANY_RUC, '2026-03')).map((e) => e.entryNumber);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('el cierre mensual queda guardado y bloquea nuevos asientos, incluso escribiendo directo al repositorio', async () => {
      await accounting.registerEntry(saleEntry(COMPANY_RUC));
      const closed = await accounting.closePeriod({ companyId: COMPANY_RUC, period: '2026-03', closedBy: 'contador' });
      expect(closed.status).toBe('CLOSED');
      expect(closed.trialBalanceSnapshot?.isBalanced).toBe(true);

      await expect(accounting.registerEntry(saleEntry(COMPANY_RUC))).rejects.toThrow(/Período contable bloqueado/);

      // Saltándose el servicio: la transacción en PostgreSQL vuelve a verificar el bloqueo.
      const draft = new AccountingService().registerEntry(saleEntry(COMPANY_RUC));
      await expect(persistence.ledger.appendEntry(draft)).rejects.toThrow(/Período contable bloqueado/);
    });

    it('la reapertura guarda usuario y motivo y vuelve a permitir asientos', async () => {
      await accounting.registerEntry(saleEntry(COMPANY_RUC));
      await accounting.closePeriod({ companyId: COMPANY_RUC, period: '2026-03' });
      const reopened = await accounting.reopenPeriod({
        companyId: COMPANY_RUC,
        period: '2026-03',
        reopenedBy: 'contador',
        reason: 'Corrección de glosa',
      });
      expect(reopened.status).toBe('OPEN');

      const record = await accounting.getPeriodRecord(COMPANY_RUC, '2026-03');
      expect(record.reopenedBy).toBe('contador');
      expect(record.reopenReason).toBe('Corrección de glosa');
      expect((await accounting.registerEntry(saleEntry(COMPANY_RUC))).entryNumber).toBe(2);
    });

    it('contabiliza borradores y no permite contabilizarlos con el período cerrado', async () => {
      const draft = await accounting.registerDraftEntry(saleEntry(COMPANY_RUC));
      expect(draft.status).toBe('PENDING');
      const posted = await accounting.postEntry(COMPANY_RUC, draft.id);
      expect(posted.status).toBe('POSTED');

      const second = await accounting.registerDraftEntry(saleEntry(COMPANY_RUC, { accountingPeriod: '2026-04', entryDate: '2026-04-02' }));
      await db.pool.query(
        `INSERT INTO private.accounting_periods (company_id, period, status) VALUES ($1, '2026-04', 'CLOSED')`,
        [COMPANY_RUC],
      );
      await expect(persistence.ledger.markEntryPosted(COMPANY_RUC, second.id)).rejects.toThrow(/cerrado/);
    });

    it('detecta un cierre calculado con datos desactualizados', async () => {
      await accounting.registerEntry(saleEntry(COMPANY_RUC));
      const service = await accounting.loadService(COMPANY_RUC, '2026');
      const staleRecord = service.closePeriod({ companyId: COMPANY_RUC, period: '2026-03' });

      await accounting.registerEntry(saleEntry(COMPANY_RUC, { glosa: 'Asiento llegado durante el cierre' }));
      await expect(persistence.ledger.savePeriod(staleRecord, 'OPEN')).rejects.toBeInstanceOf(ConcurrentPeriodChangeError);
      expect((await accounting.getPeriodRecord(COMPANY_RUC, '2026-03')).status).toBe('OPEN');
    });

    it('bloquea asientos cuando el ejercicio anual está cerrado', async () => {
      await db.pool.query(
        `INSERT INTO private.accounting_fiscal_years (company_id, fiscal_year, annual_close_status)
         VALUES ($1, '2025', 'CLOSED')`,
        [COMPANY_RUC],
      );
      await expect(
        accounting.registerEntry(saleEntry(COMPANY_RUC, { accountingPeriod: '2025-12', entryDate: '2025-12-15' })),
      ).rejects.toThrow(/Ejercicio contable bloqueado/);
    });
  });
});
