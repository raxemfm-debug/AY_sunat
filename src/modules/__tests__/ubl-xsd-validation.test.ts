import { describe, expect, it } from 'vitest';
import { calculateCpe } from '../../core/tax-engine/cpe-calculator.js';
import type { CpeDocumentInput } from '../../core/tax-engine/types.js';
import { generateUblXml } from '../ubl/ubl-builder.js';
import { validateUblXmlAgainstXsd } from '../ubl/xsd-validator.js';

const company = {
  ruc: '10445533811',
  legalName: 'JOSE BARRIENTOS',
  taxRegime: 'RMT' as const,
  address: {
    ubigeo: '150101',
    department: 'LIMA',
    province: 'LIMA',
    district: 'LIMA',
    addressLine: 'AV. AREQUIPA 1234',
  },
};

function createSampleDoc(cpeType: '01' | '03' | '07'): CpeDocumentInput {
  return {
    company,
    client: {
      docType: cpeType === '03' ? ('1' as const) : ('6' as const),
      docNumber: cpeType === '03' ? '44556677' : '20123456789',
      name: cpeType === '03' ? 'JUAN PEREZ' : 'EMPRESA CLIENTE S.A.C.',
    },
    cpeType,
    series: cpeType === '03' ? 'B001' : cpeType === '07' ? 'FC01' : 'F001',
    correlative: 1,
    issueDate: '2026-11-20',
    currency: 'PEN',
    paymentMethod: 'CONTADO',
    ...(cpeType === '07'
      ? {
          creditNoteInfo: {
            discrepancyCode: '01' as const,
            discrepancyReason: 'Anulación de la operación',
            modifiedDocType: '01' as const,
            modifiedDocSeries: 'F001',
            modifiedDocCorrelative: 1,
          },
        }
      : {}),
    items: [
      {
        description: 'Servicio de desarrollo de software',
        quantity: '1',
        unitPrice: '118.00',
        priceIncludesIgv: true,
        affectationType: '10',
      },
    ],
  };
}

describe('Validación XSD UBL 2.1 (SUNAT)', () => {
  it('valida exitosamente una Factura electrónica (01) contra UBL-Invoice-2.1.xsd', async () => {
    const doc = createSampleDoc('01');
    const xml = generateUblXml(calculateCpe(doc), doc);

    const result = await validateUblXmlAgainstXsd(xml, '01');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.schemaUsed).toBe('maindoc/UBL-Invoice-2.1.xsd');
  });

  it('valida exitosamente una Boleta de venta electrónica (03) contra UBL-Invoice-2.1.xsd', async () => {
    const doc = createSampleDoc('03');
    const xml = generateUblXml(calculateCpe(doc), doc);

    const result = await validateUblXmlAgainstXsd(xml, '03');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('valida exitosamente una Nota de Crédito (07) contra UBL-CreditNote-2.1.xsd', async () => {
    const doc = createSampleDoc('07');
    const xml = generateUblXml(calculateCpe(doc), doc);

    const result = await validateUblXmlAgainstXsd(xml, '07');
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.schemaUsed).toBe('maindoc/UBL-CreditNote-2.1.xsd');
  });

  describe('Detección de errores de esquema XSD', () => {
    it('detecta error cuando falta un elemento obligatorio requerido por el XSD (LegalMonetaryTotal)', async () => {
      const doc = createSampleDoc('01');
      const xml = generateUblXml(calculateCpe(doc), doc);
      // Removemos el bloque obligatorio LegalMonetaryTotal
      const invalidXml = xml.replace(/<cac:LegalMonetaryTotal>[\s\S]*?<\/cac:LegalMonetaryTotal>/, '');

      const result = await validateUblXmlAgainstXsd(invalidXml, '01');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      const hasExpectedError = result.errors.some(
        (e) => e.message.includes('LegalMonetaryTotal') || e.message.includes('Missing child element'),
      );
      expect(hasExpectedError).toBe(true);
    });

    it('detecta error de sintaxis XML (etiqueta mal cerrada o rota)', async () => {
      const doc = createSampleDoc('01');
      const xml = generateUblXml(calculateCpe(doc), doc);
      const malformedXml = xml.replace('</Invoice>', '</BrokenInvoice>');

      const result = await validateUblXmlAgainstXsd(malformedXml, '01');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('parser error') || e.message.includes('mismatch'))).toBe(true);
    });

    it('detecta error de tipo de dato o formato de fecha inválido en el XSD', async () => {
      const doc = createSampleDoc('01');
      const xml = generateUblXml(calculateCpe(doc), doc);
      // Reemplazamos la fecha con un valor inválido que viola xs:date
      const invalidDateXml = xml.replace(/<cbc:IssueDate>[\s\S]*?<\/cbc:IssueDate>/, '<cbc:IssueDate>2026-99-99</cbc:IssueDate>');

      const result = await validateUblXmlAgainstXsd(invalidDateXml, '01');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('IssueDate') || e.message.includes('valid value'))).toBe(true);
    });

    it('detecta error de elemento inesperado o en secuencia incorrecta', async () => {
      const doc = createSampleDoc('01');
      const xml = generateUblXml(calculateCpe(doc), doc);
      // Inyectamos una etiqueta inventada dentro de Invoice
      const unexpectedXml = xml.replace('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>', '<cbc:ElementoInvalidoNoExiste>123</cbc:ElementoInvalidoNoExiste><cbc:UBLVersionID>2.1</cbc:UBLVersionID>');

      const result = await validateUblXmlAgainstXsd(unexpectedXml, '01');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('ElementoInvalidoNoExiste') || e.message.includes('This element is not expected'))).toBe(true);
    });

    it('detecta error en Nota de Crédito si falta al menos una línea de detalle en Nota de Crédito', async () => {
      const doc = createSampleDoc('07');
      const xml = generateUblXml(calculateCpe(doc), doc);
      // Removemos BillingReference en la Nota de Crédito
      const missingRefXml = xml.replace(/<cac:CreditNoteLine>[\s\S]*?<\/cac:CreditNoteLine>/, '');

      const result = await validateUblXmlAgainstXsd(missingRefXml, '07');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
