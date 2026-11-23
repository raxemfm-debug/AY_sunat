import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  SUNAT_ENDPOINTS,
  SunatSoapClient,
  buildSendBillEnvelope,
  extractApplicationResponse,
  parseCdrFromZip,
  parseCdrXml,
  parseSoapFault,
  type SunatCredentials,
} from '../sunat-soap/index.js';
import {
  generateSelfSignedCertificate,
  signUblXml,
} from '../signing/index.js';
import { generateUblXml } from '../ubl/ubl-builder.js';
import type { CpeDocumentCalculationResult, CpeDocumentInput } from '../../core/tax-engine/types.js';

// XML de CDR de prueba: Comprobante Aceptado
function createSampleCdrXml(options: {
  id?: string;
  referenceId?: string;
  responseCode?: string;
  description?: string;
  notes?: string[];
} = {}): string {
  const id = options.id ?? 'R-20600000001-01-F001-00000001';
  const referenceId = options.referenceId ?? 'F001-00000001';
  const responseCode = options.responseCode ?? '0';
  const description = options.description ?? `La Factura numero ${referenceId}, ha sido aceptada`;
  const notesXml = (options.notes || []).map((n) => `<cbc:Note>${n}</cbc:Note>`).join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ar:ApplicationResponse xmlns:ar="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"
                        xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
                        xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
                        xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <cbc:UBLVersionID>2.0</cbc:UBLVersionID>
  <cbc:CustomizationID>1.0</cbc:CustomizationID>
  <cbc:ID>${id}</cbc:ID>
  <cbc:IssueDate>2026-11-20</cbc:IssueDate>
  <cbc:IssueTime>14:30:00</cbc:IssueTime>
  <cbc:ResponseDate>2026-11-20</cbc:ResponseDate>
  <cbc:ResponseTime>14:30:02</cbc:ResponseTime>
  <cac:Signature>
    <cbc:ID>SignSUNAT</cbc:ID>
    <ds:Signature>
      <ds:SignedInfo>
        <ds:Reference>
          <ds:DigestValue>SUNAT_HASH_DIGEST_ABC123==</ds:DigestValue>
        </ds:Reference>
      </ds:SignedInfo>
      <ds:SignatureValue>SUNAT_SIGNATURE_VALUE_XYZ==</ds:SignatureValue>
    </ds:Signature>
  </cac:Signature>
  <cac:SenderParty>
    <cac:PartyIdentification>
      <cbc:ID schemeID="6">20131312955</cbc:ID>
    </cac:PartyIdentification>
    <cac:PartyLegalEntity>
      <cbc:RegistrationName>SUPERINTENDENCIA NACIONAL DE ADUANAS Y DE ADMINISTRACION TRIBUTARIA</cbc:RegistrationName>
    </cac:PartyLegalEntity>
  </cac:SenderParty>
  <cac:ReceiverParty>
    <cac:PartyIdentification>
      <cbc:ID schemeID="6">20600000001</cbc:ID>
    </cac:PartyIdentification>
  </cac:ReceiverParty>
  <cac:DocumentResponse>
    <cac:Response>
      <cbc:ReferenceID>${referenceId}</cbc:ReferenceID>
      <cbc:ResponseCode>${responseCode}</cbc:ResponseCode>
      <cbc:Description>${description}</cbc:Description>
    </cac:Response>
    <cac:DocumentReference>
      <cbc:ID>${referenceId}</cbc:ID>
      <cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>
    </cac:DocumentReference>
  </cac:DocumentResponse>
  ${notesXml}
</ar:ApplicationResponse>`.trim();
}

async function createSampleCdrZipBase64(cdrXml: string, fileName = 'R-20600000001-01-F001-00000001.xml'): Promise<string> {
  const zip = new JSZip();
  zip.file(fileName, cdrXml);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return buffer.toString('base64');
}

function createSendBillSoapResponse(applicationResponseBase64: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ser="http://service.sunat.gob.pe">
  <soapenv:Body>
    <ser:sendBillResponse>
      <applicationResponse>${applicationResponseBase64}</applicationResponse>
    </ser:sendBillResponse>
  </soapenv:Body>
</soapenv:Envelope>`.trim();
}

describe('Cliente SOAP sendBill y Procesamiento de CDR SUNAT', () => {
  const testCredentials: SunatCredentials = {
    ruc: '20600000001',
    username: 'MODDATOS',
    password: 'moddatos_password',
  };

  describe('1. Construcción del sobre SOAP 1.1 y WS-Security', () => {
    it('construye el sobre SOAP sendBill con UsernameToken conforme a SUNAT', () => {
      const envelope = buildSendBillEnvelope(
        testCredentials,
        '20600000001-01-F001-00000001.zip',
        'UEsDBBQAAAAIA...',
      );

      // Verificación de namespaces
      expect(envelope).toContain('xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"');
      expect(envelope).toContain('xmlns:ser="http://service.sunat.gob.pe"');
      expect(envelope).toContain('xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"');

      // Verificación de credenciales concatenadas {RUC}{USUARIO}
      expect(envelope).toContain('<wsse:Username>20600000001MODDATOS</wsse:Username>');
      expect(envelope).toContain('<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">moddatos_password</wsse:Password>');

      // Verificación de parámetros de la operación sendBill
      expect(envelope).toContain('<fileName>20600000001-01-F001-00000001.zip</fileName>');
      expect(envelope).toContain('<contentFile>UEsDBBQAAAAIA...</contentFile>');
    });

    it('escapa caracteres especiales en las credenciales o nombre de archivo', () => {
      const envelope = buildSendBillEnvelope(
        { ruc: '20600000001', username: 'USER&<1>', password: 'pass"word\'' },
        'test&file.zip',
        'BASE64',
      );
      expect(envelope).toContain('USER&amp;&lt;1&gt;');
      expect(envelope).toContain('pass&quot;word&apos;');
      expect(envelope).toContain('test&amp;file.zip');
    });
  });

  describe('2. Detección y parseo de SOAP Faults', () => {
    it('extrae el código de error y mensaje de un SOAP Fault de SUNAT', () => {
      const faultXml = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Body>
          <soapenv:Fault>
            <faultcode>soap-env:Client.1033</faultcode>
            <faultstring>El comprobante fue registrado previamente con otros datos</faultstring>
            <detail>Validacion rechazada por sistema de recepcion</detail>
          </soapenv:Fault>
        </soapenv:Body>
      </soapenv:Envelope>`;

      const fault = parseSoapFault(faultXml);
      expect(fault).not.toBeNull();
      expect(fault?.faultCode).toBe('soap-env:Client.1033');
      expect(fault?.faultString).toContain('registrado previamente');
      expect(fault?.sunatErrorCode).toBe('1033');
      expect(fault?.detail).toBe('Validacion rechazada por sistema de recepcion');
    });

    it('detecta código de error numérico al inicio de faultstring', () => {
      const faultXml = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Body>
          <soapenv:Fault>
            <faultcode>soap-env:Client</faultcode>
            <faultstring>0156 - El archivo ZIP esta corrupto</faultstring>
          </soapenv:Fault>
        </soapenv:Body>
      </soapenv:Envelope>`;

      const fault = parseSoapFault(faultXml);
      expect(fault?.sunatErrorCode).toBe('0156');
    });

    it('retorna null si la respuesta no es un Fault', () => {
      expect(parseSoapFault('<response>OK</response>')).toBeNull();
    });
  });

  describe('3. Parseo de Constancia de Recepción (CDR) XML y ZIP', () => {
    it('parsea exitosamente un CDR de comprobante ACEPTADO (ResponseCode = 0)', () => {
      const xml = createSampleCdrXml({
        id: 'R-20600000001-01-F001-00000001',
        referenceId: 'F001-00000001',
        responseCode: '0',
        description: 'La Factura numero F001-00000001, ha sido aceptada',
      });

      const cdr = parseCdrXml(xml);

      expect(cdr.id).toBe('R-20600000001-01-F001-00000001');
      expect(cdr.referenceId).toBe('F001-00000001');
      expect(cdr.documentTypeCode).toBe('01');
      expect(cdr.responseCode).toBe('0');
      expect(cdr.isAccepted).toBe(true);
      expect(cdr.hasObservations).toBe(false);
      expect(cdr.description).toContain('ha sido aceptada');
      expect(cdr.senderRuc).toBe('20131312955');
      expect(cdr.receiverRuc).toBe('20600000001');
      expect(cdr.cdrHash).toBe('SUNAT_HASH_DIGEST_ABC123==');
      expect(cdr.signatureValue).toBe('SUNAT_SIGNATURE_VALUE_XYZ==');
    });

    it('parsea un CDR ACEPTADO CON OBSERVACIONES (ResponseCode = 0 con notas 4000+)', () => {
      const xml = createSampleCdrXml({
        responseCode: '0',
        description: 'El comprobante ha sido aceptado con observaciones',
        notes: [
          '4010 - El numero de RUC no coincide con el padron de contribuyentes activos.',
          '4012 - La fecha de emision difiere de la fecha actual.',
        ],
      });

      const cdr = parseCdrXml(xml);

      expect(cdr.isAccepted).toBe(true);
      expect(cdr.hasObservations).toBe(true);
      expect(cdr.notes).toHaveLength(2);
      expect(cdr.observations).toHaveLength(2);
      expect(cdr.observations[0].code).toBe('4010');
      expect(cdr.observations[0].message).toContain('padron de contribuyentes');
      expect(cdr.observations[1].code).toBe('4012');
    });

    it('parsea un CDR RECHAZADO por SUNAT (ResponseCode != 0)', () => {
      const xml = createSampleCdrXml({
        responseCode: '2017',
        description: 'El RUC del receptor no se encuentra en estado ACTIVO.',
      });

      const cdr = parseCdrXml(xml);

      expect(cdr.isAccepted).toBe(false);
      expect(cdr.responseCode).toBe('2017');
      expect(cdr.hasObservations).toBe(false);
      expect(cdr.description).toContain('no se encuentra en estado ACTIVO');
    });

    it('descomprime y parsea directamente desde el ZIP de la CDR', async () => {
      const cdrXml = createSampleCdrXml({ referenceId: 'F001-00000009' });
      const zipBase64 = await createSampleCdrZipBase64(cdrXml, 'R-20600000001-01-F001-00000009.xml');

      const cdr = await parseCdrFromZip(zipBase64);
      expect(cdr.referenceId).toBe('F001-00000009');
      expect(cdr.isAccepted).toBe(true);
      expect(cdr.zipBase64).toBe(zipBase64);
    });
  });

  describe('4. Cliente SunatSoapClient con simulación HTTP', () => {
    it('configura correctamente endpoints de Beta y Producción', () => {
      const betaClient = new SunatSoapClient({ credentials: testCredentials, environment: 'beta' });
      expect(betaClient.getEndpointUrl()).toBe(SUNAT_ENDPOINTS.beta);

      const prodClient = new SunatSoapClient({ credentials: testCredentials, environment: 'production' });
      expect(prodClient.getEndpointUrl()).toBe(SUNAT_ENDPOINTS.production);

      const customClient = new SunatSoapClient({
        credentials: testCredentials,
        customUrl: 'http://localhost:8080/sunat/mock',
      });
      expect(customClient.getEndpointUrl()).toBe('http://localhost:8080/sunat/mock');
    });

    it('procesa respuesta HTTP 200 exitosa y devuelve estado ACCEPTED con CDR', async () => {
      const cdrXml = createSampleCdrXml({ referenceId: 'F001-00000001' });
      const zipBase64 = await createSampleCdrZipBase64(cdrXml);
      const soapResponse = createSendBillSoapResponse(zipBase64);

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        text: async () => soapResponse,
      });

      const client = new SunatSoapClient({
        credentials: testCredentials,
        fetchFn: mockFetch as any,
      });

      const result = await client.sendBillZip('20600000001-01-F001-00000001.zip', 'BASE64_ZIP_CPE');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('ACCEPTED');
      expect(result.httpStatusCode).toBe(200);
      expect(result.cdr).toBeDefined();
      expect(result.cdr?.isAccepted).toBe(true);
      expect(result.cdr?.referenceId).toBe('F001-00000001');
    });

    it('procesa respuesta HTTP 500 con SOAP Fault de SUNAT', async () => {
      const soapFaultResponse = `
      <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
        <soapenv:Body>
          <soapenv:Fault>
            <faultcode>soap-env:Client.0156</faultcode>
            <faultstring>El archivo ZIP esta corrupto</faultstring>
          </soapenv:Fault>
        </soapenv:Body>
      </soapenv:Envelope>`;

      const mockFetch = vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
        text: async () => soapFaultResponse,
      });

      const client = new SunatSoapClient({
        credentials: testCredentials,
        fetchFn: mockFetch as any,
      });

      const result = await client.sendBillZip('20600000001-01-F001-00000001.zip', 'BAD_BASE64');

      expect(result.status).toBe('SOAP_FAULT');
      expect(result.httpStatusCode).toBe(500);
      expect(result.fault?.sunatErrorCode).toBe('0156');
      expect(result.fault?.faultString).toBe('El archivo ZIP esta corrupto');
      expect(result.cdr).toBeUndefined();
    });

    it('maneja errores de red o conexión caída de manera limpia', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused to e-beta.sunat.gob.pe'));

      const client = new SunatSoapClient({
        credentials: testCredentials,
        fetchFn: mockFetch as any,
      });

      const result = await client.sendBillZip('20600000001-01-F001-00000001.zip', 'DUMMY');

      expect(result.status).toBe('NETWORK_ERROR');
      expect(result.httpStatusCode).toBe(0);
      expect(result.message).toContain('Connection refused');
    });
  });

  describe('5. Flujo integral sendCpe (UBL -> Firma -> ZIP -> SOAP -> CDR)', () => {
    it('ejecuta el ciclo de vida completo de emisión y recepción', async () => {
      // 1. Datos del comprobante
      const input: CpeDocumentInput = {
        cpeType: '01',
        series: 'F001',
        correlative: 10,
        issueDate: '2026-11-20',
        issueTime: '12:00:00',
        currency: 'PEN',
        company: {
          ruc: '20600000001',
          legalName: 'AYSunat Soluciones SAC',
          taxRegime: 'RMT' as const,
          tradeName: 'AYSunat',
          address: {
            ubigeo: '150101',
            department: 'LIMA',
            province: 'LIMA',
            district: 'LIMA',
            addressLine: 'Av. Javier Prado 123',
          },
        },
        client: {
          docType: '6' as const,
          docNumber: '20123456789',
          name: 'CLIENTE PRUEBA SAC',
        },
        paymentMethod: 'CONTADO',
        items: [
          {
            code: 'PROD01',
            description: 'Licencia de Software',
            quantity: 1,
            unitPrice: '118.00',
            priceIncludesIgv: true,
            affectationType: '10',
            unitCode: 'NIU',
          },
        ],
      };

      const calcResult: CpeDocumentCalculationResult = {
        header: {
          cpeType: '01',
          series: 'F001',
          correlative: 10,
          fullNumber: 'F001-00000010',
          issueDate: '2026-11-20',
          currency: 'PEN',
        },
        items: [
          {
            code: 'PROD01',
            description: 'Licencia de Software',
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
        client: input.client,
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

      // 2. Generar y firmar XML
      const { certData } = generateSelfSignedCertificate('EMPRESA PRUEBA SAC');
      const unsignedXml = generateUblXml(calcResult, input);
      const { signedXml, hashCpe } = signUblXml(unsignedXml, certData);
      expect(hashCpe).toBeTruthy();

      // 3. Simular que SUNAT responde con CDR aceptando F001-00000010
      const cdrXml = createSampleCdrXml({
        id: 'R-20600000001-01-F001-00000010',
        referenceId: 'F001-00000010',
        responseCode: '0',
        description: 'La Factura numero F001-00000010, ha sido aceptada',
      });
      const cdrZipBase64 = await createSampleCdrZipBase64(cdrXml, 'R-20600000001-01-F001-00000010.xml');
      const soapResponse = createSendBillSoapResponse(cdrZipBase64);

      let capturedRequestBody = '';
      const mockFetch = vi.fn().mockImplementation(async (url, init) => {
        capturedRequestBody = init.body;
        return {
          status: 200,
          ok: true,
          text: async () => soapResponse,
        };
      });

      const client = new SunatSoapClient({
        credentials: testCredentials,
        fetchFn: mockFetch as any,
      });

      // 4. Enviar mediante sendCpe
      const sendResult = await client.sendCpe(
        {
          ruc: '20600000001',
          cpeType: '01',
          series: 'F001',
          correlative: 10,
        },
        signedXml,
      );

      // Verificaciones
      expect(capturedRequestBody).toContain('<fileName>20600000001-01-F001-00000010.zip</fileName>');
      expect(sendResult.status).toBe('ACCEPTED');
      expect(sendResult.cdr?.isAccepted).toBe(true);
      expect(sendResult.cdr?.referenceId).toBe('F001-00000010');
      expect(sendResult.cdr?.description).toContain('ha sido aceptada');
      expect(sendResult.cdr?.senderRuc).toBe('20131312955');
    });
  });
});
