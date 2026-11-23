import { describe, it, expect, beforeEach } from 'vitest';
import { CompanyService } from '../company/company.service.js';
import { AuditLogger } from '../audit/audit-logger.js';
import { CpeService } from '../cpe/cpe.service.js';

describe('Arquitectura Modular: Gestión Empresarial y Emisión de CPE', () => {
  let companyService: CompanyService;
  let auditLogger: AuditLogger;
  let cpeService: CpeService;

  beforeEach(() => {
    companyService = new CompanyService();
    auditLogger = new AuditLogger();
    cpeService = new CpeService(companyService, auditLogger);
  });

  it('registra una Persona Natural con Negocio y genera sus series por defecto', () => {
    const company = companyService.registerCompany({
      ruc: '10445533811',
      legalName: 'Jose Barrientos',
      tradeName: 'Servicios de TI',
      taxRegime: 'RMT',
      address: {
        ubigeo: '150101',
        department: 'Lima',
        province: 'Lima',
        district: 'Lima',
        addressLine: 'Av. Arequipa 1234',
      },
    });

    expect(company.id).toBeDefined();
    expect(company.isActive).toBe(true);

    const series = companyService.getSeries(company.id);
    expect(series.length).toBe(4); // F001, FC01, B001, BC01
    expect(series.find((s) => s.series === 'F001')?.currentCorrelative).toBe(0);
  });

  it('emite una factura electrónica y avanza el correlativo de forma secuencial', () => {
    const company = companyService.registerCompany({
      ruc: '10445533811',
      legalName: 'Jose Barrientos',
      taxRegime: 'RMT',
      address: {
        ubigeo: '150101',
        department: 'Lima',
        province: 'Lima',
        district: 'Lima',
        addressLine: 'Av. Arequipa 1234',
      },
    });

    const cpe1 = cpeService.issueDocument({
      companyId: company.id,
      cpeType: '01',
      series: 'F001',
      client: {
        docType: '6',
        docNumber: '20123456789',
        name: 'EMPRESA CLIENTE S.A.C.',
      },
      paymentMethod: 'CONTADO',
      items: [
        {
          description: 'Servicio de consultoría de sistemas',
          quantity: '1',
          unitPrice: '1180.00',
          priceIncludesIgv: true,
          affectationType: '10',
        },
      ],
    });

    expect(cpe1.fullNumber).toBe('F001-00000001');
    expect(cpe1.subTotal).toBe('1000.00');
    expect(cpe1.montoIgv).toBe('180.00');
    expect(cpe1.totalPagar).toBe('1180.00');
    expect(cpe1.status).toBe('CALCULADO');

    // Emisión subsiguiente
    const cpe2 = cpeService.issueDocument({
      companyId: company.id,
      cpeType: '01',
      series: 'F001',
      client: {
        docType: '6',
        docNumber: '20123456789',
        name: 'EMPRESA CLIENTE S.A.C.',
      },
      paymentMethod: 'CONTADO',
      items: [
        {
          description: 'Mantenimiento mensual',
          quantity: '2',
          unitPrice: '500.00',
          priceIncludesIgv: false,
          affectationType: '10',
        },
      ],
    });

    expect(cpe2.fullNumber).toBe('F001-00000002');
    expect(cpe2.subTotal).toBe('1000.00');
    expect(cpe2.montoIgv).toBe('180.00');
    expect(cpe2.totalPagar).toBe('1180.00');

    // Comprobamos la bitácora de auditoría
    const logs = auditLogger.getLogsByCompany(company.id);
    expect(logs.length).toBe(2);
    expect(logs[0].action).toBe('EMISION_CPE');
    expect(logs[1].action).toBe('EMISION_CPE');
  });

  it('impide emitir facturas en el Nuevo RUS (NRUS)', () => {
    const nrusCompany = companyService.registerCompany({
      ruc: '10445533811',
      legalName: 'Jose Barrientos',
      taxRegime: 'NRUS',
      address: {
        ubigeo: '150101',
        department: 'Lima',
        province: 'Lima',
        district: 'Lima',
        addressLine: 'Av. Arequipa 1234',
      },
    });

    expect(() =>
      cpeService.issueDocument({
        companyId: nrusCompany.id,
        cpeType: '01',
        series: 'F001',
        client: {
          docType: '6',
          docNumber: '20123456789',
          name: 'EMPRESA CLIENTE S.A.C.',
        },
        paymentMethod: 'CONTADO',
        items: [
          {
            description: 'Venta menor',
            quantity: '1',
            unitPrice: '50.00',
            priceIncludesIgv: true,
            affectationType: '10',
          },
        ],
      }),
    ).toThrow(/Serie 'F001' no autorizada/);
  });
});
