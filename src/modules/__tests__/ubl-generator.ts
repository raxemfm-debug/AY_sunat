import { describe, it, expect } from 'vitest';
import { calculateCpe } from '../../core/tax-engine/cpe-calculator.js';
import { CpeDocumentInput } from '../../core/tax-engine/types.js';
import { generateUblXml } from '../ubl/ubl-builder.js';

describe('Generador UBL 2.1', () => {
  it('genera factura y boleta como Invoice y nota de crédito como CreditNote', () => {
    const company = {
      ruc: '10445533811', legalName: 'JOSE BARRIENTOS', taxRegime: 'RMT' as const,
      address: { ubigeo: '150101', department: 'LIMA', province: 'LIMA', district: 'LIMA', addressLine: 'AV. AREQUIPA 1234' },
    };
    const makeInput = (cpeType: '01' | '03' | '07'): CpeDocumentInput => ({
      company,
      client: { docType: '6', docNumber: '20123456789', name: 'CLIENTE S.A.C.' },
      cpeType, series: cpeType === '03' ? 'B001' : cpeType === '07' ? 'FC01' : 'F001',
      correlative: 1, issueDate: '2026-11-20', currency: 'PEN', paymentMethod: 'CONTADO',
      ...(cpeType === '07' ? { creditNoteInfo: {
        discrepancyCode: '01', discrepancyReason: 'Anulación', modifiedDocType: '01', modifiedDocSeries: 'F001', modifiedDocCorrelative: 1,
      }} : {}),
      items: [{ description: 'Servicio', quantity: '1', unitPrice: '118.00', priceIncludesIgv: true, affectationType: '10' }],
    });

    for (const type of ['01', '03'] as const) {
      const input = makeInput(type);
      const xml = generateUblXml(calculateCpe(input), input);
      expect(xml).toContain('<Invoice');
      expect(xml).toContain(`<cbc:InvoiceTypeCode`);
      expect(xml).toContain(`<cbc:ID>${type === '03' ? 'B001' : 'F001'}-00000001</cbc:ID>`);
    }

    const creditNote = makeInput('07');
    const xml = generateUblXml(calculateCpe(creditNote), creditNote);
    expect(xml).toContain('<CreditNote');
    expect(xml).toContain('<cac:DiscrepancyResponse>');
    expect(xml).toContain('<cbc:ReferenceID>F001-00000001</cbc:ReferenceID>');
  });
});
