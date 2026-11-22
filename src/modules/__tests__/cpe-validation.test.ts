import { describe, expect, it } from 'vitest';
import {
  CpePrintService,
  CpeValidationError,
  validateAndSanitizeCpe,
  type PrintableCpe,
} from '../printing/index.js';

function validInvoice(): PrintableCpe {
  return {
    type: '01',
    series: 'F001',
    number: '42',
    issueDate: '2026-05-15',
    issuer: { ruc: '20123456789', legalName: 'Empresa de prueba SAC' },
    customer: { documentType: '6', documentNumber: '20987654321', name: 'Cliente SAC' },
    lines: [{
      quantity: 1,
      unitCode: 'NIU',
      description: 'Servicio de prueba',
      unitValue: 100,
      unitPrice: 118,
      lineExtensionAmount: 100,
      igvAmount: 18,
      totalAmount: 118,
    }],
    totals: { taxable: 100, exempt: 0, unaffected: 0, free: 0, igv: 18, total: 118, currency: 'PEN' },
    hashCpe: 'hash-de-prueba',
  };
}

describe('validación de CPE previa a la representación impresa', () => {
  it('normaliza serie y correlativo sin modificar el objeto original', () => {
    const cpe = { ...validInvoice(), series: 'f001', number: '42' };
    const result = validateAndSanitizeCpe(cpe);
    expect(result.isValid).toBe(true);
    expect(result.sanitizedCpe.series).toBe('F001');
    expect(result.sanitizedCpe.number).toBe('00000042');
    expect(cpe.number).toBe('42');
  });

  it('rechaza serie, RUC, fecha y moneda malformados', () => {
    const cpe = validInvoice();
    cpe.series = 'B001';
    cpe.issueDate = '2026-02-30';
    cpe.customer.documentNumber = 'abc';
    cpe.totals.currency = 'PEN';
    (cpe.totals as { currency: string }).currency = 'EUR';
    const result = validateAndSanitizeCpe(cpe);
    expect(result.isValid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Serie/);
    expect(result.errors.join(' ')).toMatch(/RUC/);
    expect(result.errors.join(' ')).toMatch(/Fecha de emisión/);
    expect(result.errors.join(' ')).toMatch(/Moneda/);
  });

  it('bloquea el PDF si el comprobante no pasa la validación', async () => {
    const cpe = { ...validInvoice(), number: '0' };
    await expect(new CpePrintService().render(cpe, 'a4')).rejects.toBeInstanceOf(CpeValidationError);
  });

  it('rechaza cantidades negativas y montos no finitos antes del ticket', async () => {
    const cpe = validInvoice();
    cpe.type = '03';
    cpe.series = 'B001';
    cpe.customer.documentType = '1';
    cpe.customer.documentNumber = '12345678';
    cpe.lines[0].quantity = -1;
    cpe.lines[0].totalAmount = Number.NaN;
    await expect(new CpePrintService().render(cpe, 'ticket-80mm')).rejects.toThrow(/Cantidad inválida/);
  });

  it('exige referencia y motivo coherentes para una nota de crédito', () => {
    const cpe = validInvoice();
    cpe.type = '07';
    cpe.series = 'FC01';
    cpe.modifiedDocument = {
      documentType: '03', series: 'B001', number: '', reasonCode: '', reasonDescription: '',
    };
    const result = validateAndSanitizeCpe(cpe);
    expect(result.isValid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/comprobante modificado|motivo|Nota de Crédito/);
  });
});
