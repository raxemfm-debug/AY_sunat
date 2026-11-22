import { describe, expect, it } from 'vitest';
import {
  generateSelfSignedCertificate,
  loadCertificateFromPfx,
  loadCertificateFromPem,
  signUblXml,
  extractHashCpe,
  verifySignedXml,
  type CertificateData,
} from '../signing/index.js';
import {
  formatCpeFileName,
  createCpeZip,
  extractCpeZip,
} from '../packaging/index.js';
import { generateUblXml } from '../ubl/ubl-builder.js';
import { validateUblXmlAgainstXsd } from '../ubl/xsd-validator.js';
import type { CpeDocumentCalculationResult, CpeDocumentInput } from '../../core/tax-engine/types.js';

// Empresa y cliente base para pruebas
const testCompany = {
  ruc: '20600000001',
  legalName: 'AYSunat Soluciones Tributarias SAC',
  taxRegime: 'RMT' as const,
  tradeName: 'AYSunat',
  address: {
    ubigeo: '150101',
    department: 'LIMA',
    province: 'LIMA',
    district: 'LIMA',
    addressLine: 'Av. Javier Prado Este 1234',
  },
};

const testClient = {
  docType: '6' as const,
  docNumber: '20123456789',
  name: 'CLIENTE PRUEBA SAC',
};

function sampleCalculation(cpeType: '01' | '03' | '07', fullNumber: string): {
  input: CpeDocumentInput;
  calcResult: CpeDocumentCalculationResult;
} {
  const [series, correlativeStr] = fullNumber.split('-');
  const correlative = parseInt(correlativeStr, 10);

  const input: CpeDocumentInput = {
    cpeType,
    series,
    correlative,
    issueDate: '2026-11-20',
    issueTime: '12:00:00',
    currency: 'PEN',
    company: testCompany,
    client: testClient,
    paymentMethod: 'CONTADO',
    items: [
      {
        code: 'SERV01',
        description: 'Servicio de desarrollo de software',
        quantity: 1,
        unitPrice: '118.00',
        priceIncludesIgv: true,
        affectationType: '10',
        unitCode: 'NIU',
      },
    ],
    creditNoteInfo:
      cpeType === '07'
        ? {
            modifiedDocType: '01',
            modifiedDocSeries: 'F001',
            modifiedDocCorrelative: 1,
            discrepancyCode: '01',
            discrepancyReason: 'Anulacion de la operacion',
          }
        : undefined,
  };

  const calcResult: CpeDocumentCalculationResult = {
    header: {
      cpeType,
      series,
      correlative,
      fullNumber,
      issueDate: '2026-11-20',
      currency: 'PEN',
    },
    items: [
      {
        code: 'SERV01',
        description: 'Servicio de desarrollo de software',
        unitCode: 'NIU',
        quantity: '1',
        unitValue: '100.00',
        unitPrice: '118.00',
        affectationType: '10',
        baseAmount: '100.00',
        discountAmount: '0.00',
        igvAmount: '18.00',
        totalAmount: '118.00',
        isGratuitous: false,
      },
    ],
    client: testClient,
    sunatXmlReadyPayload: {} as any,
    totals: {
      operacionesGravadas: '100.00',
      operacionesExoneradas: '0.00',
      operacionesInafectas: '0.00',
      operacionesGratuitas: '0.00',
      totalDescuentos: '0.00',
      descuentoGlobal: '0.00',
      subTotal: '100.00',
      montoIgv: '18.00',
      totalPagar: '118.00',
      totalEnLetras: 'CIENTO DIECIOCHO CON 00/100 SOLES',
    },
  };

  return { input, calcResult };
}

describe('Firma Digital XMLDSig y Empaquetado ZIP para SUNAT', () => {
  // Generar un certificado de prueba en memoria para la suite
  const { pfxBuffer, password, certData } = generateSelfSignedCertificate('CERTIFICADO EMISOR SUNAT PRUEBA', 'test1234');

  describe('1. Carga y gestión de Certificados Digitales', () => {
    it('carga un certificado desde buffer PKCS#12 (.pfx)', () => {
      const loaded = loadCertificateFromPfx(pfxBuffer, password);
      expect(loaded.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY');
      expect(loaded.certificatePem).toContain('BEGIN CERTIFICATE');
      expect(loaded.subject).toContain('CERTIFICADO EMISOR SUNAT PRUEBA');
      expect(loaded.validTo).toBeInstanceOf(Date);
    });

    it('falla si la contraseña del PFX es incorrecta', () => {
      expect(() => loadCertificateFromPfx(pfxBuffer, 'clave_invalida')).toThrow();
    });

    it('carga un certificado desde cadenas PEM', () => {
      const loaded = loadCertificateFromPem(certData.privateKeyPem, certData.certificatePem);
      expect(loaded.privateKeyPem).toBe(certData.privateKeyPem);
      expect(loaded.certificatePem).toBe(certData.certificatePem);
    });
  });

  describe('2. Firma Digital de Factura (01) y validación XSD', () => {
    it('firma una Factura, extrae el Hash CPE y valida contra XSD oficial', async () => {
      const { input, calcResult } = sampleCalculation('01', 'F001-00000001');
      const unsignedXml = generateUblXml(calcResult, input);

      const signResult = signUblXml(unsignedXml, certData, { signatureId: 'SignatureSP' });

      expect(signResult.signedXml).toContain('<Signature Id="SignatureSP"');
      expect(signResult.signedXml).toContain('<DigestValue>');
      expect(signResult.signedXml).toContain('<SignatureValue>');
      expect(signResult.hashCpe).toBeTruthy();
      expect(signResult.hashCpe.length).toBeGreaterThan(10);

      // Verificación de extracción de hash
      const extractedHash = extractHashCpe(signResult.signedXml);
      expect(extractedHash).toBe(signResult.hashCpe);

      // Verificación XSD oficial
      const xsdCheck = await validateUblXmlAgainstXsd(signResult.signedXml, '01');
      expect(xsdCheck.valid).toBe(true);
      expect(xsdCheck.errors).toHaveLength(0);
    });
  });

  describe('3. Firma Digital de Boleta (03) y Nota de Crédito (07)', () => {
    it('firma una Boleta de Venta y es válida contra el XSD de SUNAT', async () => {
      const { input, calcResult } = sampleCalculation('03', 'B001-00000001');
      const unsignedXml = generateUblXml(calcResult, input);

      const signResult = signUblXml(unsignedXml, certData);
      expect(signResult.hashCpe).toBeTruthy();

      const xsdCheck = await validateUblXmlAgainstXsd(signResult.signedXml, '03');
      expect(xsdCheck.valid).toBe(true);
    });

    it('firma una Nota de Crédito y es válida contra UBL-CreditNote-2.1.xsd', async () => {
      const { input, calcResult } = sampleCalculation('07', 'FC01-00000001');
      const unsignedXml = generateUblXml(calcResult, input);

      const signResult = signUblXml(unsignedXml, certData);
      expect(signResult.hashCpe).toBeTruthy();

      const xsdCheck = await validateUblXmlAgainstXsd(signResult.signedXml, '07');
      expect(xsdCheck.valid).toBe(true);
    });
  });

  describe('4. Integridad criptográfica y detección de alteraciones', () => {
    it('valida exitosamente la firma criptográfica usando el certificado incrustado', () => {
      const { input, calcResult } = sampleCalculation('01', 'F001-00000002');
      const xml = generateUblXml(calcResult, input);
      const { signedXml } = signUblXml(xml, certData);

      const verifyResult = verifySignedXml(signedXml);
      expect(verifyResult.isValid).toBe(true);
      expect(verifyResult.error).toBeUndefined();
    });

    it('detecta si el XML fue alterado después de firmar (tamper detection)', () => {
      const { input, calcResult } = sampleCalculation('01', 'F001-00000003');
      const xml = generateUblXml(calcResult, input);
      const { signedXml } = signUblXml(xml, certData);

      // Intentamos alterar maliciosamente el total a pagar de 118.00 a 999.00
      const tamperedXml = signedXml.replace(
        '<cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>',
        '<cbc:PayableAmount currencyID="PEN">999.00</cbc:PayableAmount>',
      );

      const verifyResult = verifySignedXml(tamperedXml);
      expect(verifyResult.isValid).toBe(false);
      expect(verifyResult.error).toBeDefined();
    });
  });

  describe('5. Nomenclatura y empaquetado ZIP oficial SUNAT', () => {
    it('formatea correctamente el nombre oficial {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}', () => {
      const name = formatCpeFileName({
        ruc: '20600000001',
        cpeType: '01',
        series: 'F001',
        correlative: 42,
      });
      expect(name).toBe('20600000001-01-F001-00000042');
    });

    it('valida datos erróneos en el nombre del comprobante', () => {
      expect(() => formatCpeFileName({ ruc: '123', cpeType: '01', series: 'F001', correlative: 1 })).toThrow(/RUC/);
      expect(() => formatCpeFileName({ ruc: '20600000001', cpeType: '999', series: 'F001', correlative: 1 })).toThrow(/Tipo/);
      expect(() => formatCpeFileName({ ruc: '20600000001', cpeType: '01', series: 'SERIE_MUY_LARGA', correlative: 1 })).toThrow(/Serie/);
    });

    it('crea el archivo ZIP oficial y permite descomprimirlo manteniendo integridad', async () => {
      const { input, calcResult } = sampleCalculation('01', 'F001-00000005');
      const xml = generateUblXml(calcResult, input);
      const { signedXml } = signUblXml(xml, certData);

      const zipResult = await createCpeZip(
        {
          ruc: testCompany.ruc,
          cpeType: '01',
          series: 'F001',
          correlative: 5,
        },
        signedXml,
      );

      expect(zipResult.baseName).toBe('20600000001-01-F001-00000005');
      expect(zipResult.zipFileName).toBe('20600000001-01-F001-00000005.zip');
      expect(zipResult.xmlFileName).toBe('20600000001-01-F001-00000005.xml');
      expect(zipResult.zipBuffer).toBeInstanceOf(Buffer);
      expect(zipResult.fileSize).toBeGreaterThan(200);
      expect(zipResult.zipBase64).toBeTruthy();

      // Descomprimir y verificar contenido
      const unzipped = await extractCpeZip(zipResult.zipBuffer);
      expect(unzipped.xmlFileName).toBe('20600000001-01-F001-00000005.xml');
      expect(unzipped.xmlContent).toBe(signedXml);
    });
  });
});
