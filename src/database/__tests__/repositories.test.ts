import { describe, expect, it, beforeEach } from 'vitest';
import { CompanyRepository } from '../repositories/company.repository.js';
import { CpeRepository } from '../repositories/cpe.repository.js';
import { CreateCompanyDto, CreateCpeDocumentDto, CreateCpeItemDto } from '../repositories/types.js';

describe('Capa de Persistencia: CompanyRepository', () => {
  let companyRepo: CompanyRepository;

  beforeEach(() => {
    companyRepo = new CompanyRepository();
  });

  const validCompanyDto: CreateCompanyDto = {
    ruc: '10445533811',
    legalName: 'Jose Barrientos Negocios',
    taxRegime: 'RMT',
    ubigeo: '150101',
    department: 'LIMA',
    province: 'LIMA',
    district: 'LIMA',
    addressLine: 'Av. Las Begonias 456',
  };

  it('registra una empresa y crea sus series predeterminadas', async () => {
    const company = await companyRepo.create(validCompanyDto);

    expect(company.id).toBeDefined();
    expect(company.ruc).toBe('10445533811');
    expect(company.isActive).toBe(true);

    const series = await companyRepo.listSeriesByCompany(company.id);
    expect(series.length).toBe(4);
    const seriesCodes = series.map((s) => s.series);
    expect(seriesCodes).toContain('F001');
    expect(seriesCodes).toContain('B001');
    expect(seriesCodes).toContain('FC01');
    expect(seriesCodes).toContain('BC01');
  });

  it('rechaza una empresa con RUC inválido', async () => {
    await expect(
      companyRepo.create({
        ...validCompanyDto,
        ruc: '10445533819',
      }),
    ).rejects.toThrow(/RUC inválido/);
  });

  it('evita registrar dos veces el mismo RUC', async () => {
    await companyRepo.create(validCompanyDto);
    await expect(companyRepo.create(validCompanyDto)).rejects.toThrow(/Ya existe una empresa/);
  });

  it('incrementa el correlativo y formatea el número completo (fullNumber)', async () => {
    const company = await companyRepo.create(validCompanyDto);

    const first = await companyRepo.getNextFullNumber(company.id, '01', 'F001');
    expect(first.correlative).toBe(1);
    expect(first.fullNumber).toBe('F001-00000001');

    const second = await companyRepo.getNextFullNumber(company.id, '01', 'F001');
    expect(second.correlative).toBe(2);
    expect(second.fullNumber).toBe('F001-00000002');
  });

  it('busca una empresa por RUC', async () => {
    const created = await companyRepo.create(validCompanyDto);
    const found = await companyRepo.findByRuc('10445533811');
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
  });
});

describe('Capa de Persistencia: CpeRepository', () => {
  let cpeRepo: CpeRepository;
  const companyId = 'comp_test_123';

  beforeEach(() => {
    cpeRepo = new CpeRepository();
  });

  const sampleDocDto: CreateCpeDocumentDto = {
    companyId,
    cpeType: '01',
    series: 'F001',
    correlative: 1,
    fullNumber: 'F001-00000001',
    issueDate: '2026-11-21',
    currency: 'PEN',
    paymentMethod: 'CONTADO',
    clientDocType: '6',
    clientDocNumber: '20600000001',
    clientName: 'EMPRESA CLIENTE SAC',
    operacionesGravadas: '100.00',
    montoIgv: '18.00',
    subtotal: '100.00',
    totalPagar: '118.00',
    totalLetras: 'SON CIENTO DIECIOCHO CON 00/100 SOLES',
    rawPayload: { simulated: true },
  };

  const sampleItemsDto: CreateCpeItemDto[] = [
    {
      lineNumber: 1,
      itemCode: 'SERV-01',
      description: 'Consultoría contable y tributaria',
      unitCode: 'ZZ',
      quantity: '1.0000',
      unitValue: '100.00',
      unitPrice: '118.00',
      affectationType: '10',
      igvAmount: '18.00',
      totalAmount: '118.00',
    },
  ];

  it('crea un comprobante con sus ítems en estado CALCULADO', async () => {
    const aggregate = await cpeRepo.create(sampleDocDto, sampleItemsDto);

    expect(aggregate.document.id).toBeDefined();
    expect(aggregate.document.fullNumber).toBe('F001-00000001');
    expect(aggregate.document.status).toBe('CALCULADO');
    expect(aggregate.items.length).toBe(1);
    expect(aggregate.items[0].description).toBe('Consultoría contable y tributaria');
  });

  it('impide registrar un comprobante duplicado con el mismo fullNumber', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    await expect(cpeRepo.create(sampleDocDto, sampleItemsDto)).rejects.toThrow(/ya se encuentra registrado/);
  });

  it('busca un comprobante por su número completo', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    const found = await cpeRepo.findByFullNumber(companyId, 'f001-00000001');
    expect(found).not.toBeNull();
    expect(found?.document.totalPagar).toBe('118.00');
    expect(found?.items[0].totalAmount).toBe('118.00');
  });

  it('actualiza el ciclo de vida y adjunta la CDR aceptada por SUNAT', async () => {
    const { document } = await cpeRepo.create(sampleDocDto, sampleItemsDto);

    await cpeRepo.updateStatus(document.id, {
      status: 'FIRMADO_XML',
      xmlHash: 'abc123hash==',
    });

    const accepted = await cpeRepo.attachCdr(document.id, {
      cdrReceivedAt: new Date().toISOString(),
      sunatResponseCode: '0',
      sunatDescription: 'La Factura F001-00000001 ha sido aceptada.',
      xmlHash: 'abc123hash==',
    });

    expect(accepted.status).toBe('ACEPTADO');
    expect(accepted.sunatResponseCode).toBe('0');
    expect(accepted.xmlHash).toBe('abc123hash==');
  });

  it('permite filtrar comprobantes por rango de fechas y tipo', async () => {
    await cpeRepo.create(sampleDocDto, sampleItemsDto);
    await cpeRepo.create(
      {
        ...sampleDocDto,
        cpeType: '03',
        series: 'B001',
        correlative: 1,
        fullNumber: 'B001-00000001',
      },
      sampleItemsDto,
    );

    const facturas = await cpeRepo.listByCompany(companyId, { cpeType: '01' });
    expect(facturas.length).toBe(1);
    expect(facturas[0].fullNumber).toBe('F001-00000001');

    const boletas = await cpeRepo.listByCompany(companyId, { cpeType: '03' });
    expect(boletas.length).toBe(1);
    expect(boletas[0].fullNumber).toBe('B001-00000001');
  });
});
