import type { CpePackageInfo } from '../packaging/types.js';
import { createCpeZip } from '../packaging/zip-packager.js';
import { parseCdrFromZip } from './cdr-parser.js';
import {
  SUNAT_ENDPOINTS,
  buildSendBillEnvelope,
  extractApplicationResponse,
  parseSoapFault,
} from './soap-envelope.js';
import type {
  SendBillResult,
  SendBillStatus,
  SunatClientConfig,
} from './types.js';

export class SunatSoapClient {
  private config: SunatClientConfig;
  private endpointUrl: string;
  private fetchFn: typeof fetch;

  constructor(config: SunatClientConfig) {
    if (!config.credentials?.ruc || !config.credentials?.username || !config.credentials?.password) {
      throw new Error('Credenciales SUNAT incompletas: se requiere ruc, username y password.');
    }

    this.config = config;
    this.endpointUrl =
      config.customUrl ||
      (config.environment === 'production' ? SUNAT_ENDPOINTS.production : SUNAT_ENDPOINTS.beta);
    this.fetchFn = config.fetchFn || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : fetch);
  }

  /**
   * Obtiene la URL configurada del servicio SOAP de SUNAT.
   */
  public getEndpointUrl(): string {
    return this.endpointUrl;
  }

  /**
   * Envía un archivo ZIP (CPE ya empaquetado) directamente a SUNAT mediante sendBill.
   *
   * @param fileName Nombre oficial del archivo (ej. 20600000001-01-F001-00000001.zip)
   * @param zipBufferOrBase64 Buffer binario o cadena Base64 del archivo ZIP
   */
  public async sendBillZip(
    fileName: string,
    zipBufferOrBase64: Buffer | Uint8Array | string,
  ): Promise<SendBillResult> {
    const zipBase64 =
      typeof zipBufferOrBase64 === 'string'
        ? zipBufferOrBase64.replace(/\s+/g, '')
        : Buffer.from(zipBufferOrBase64).toString('base64');

    const soapRequestXml = buildSendBillEnvelope(
      this.config.credentials,
      fileName,
      zipBase64,
    );

    const timeoutMs = this.config.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'SOAPAction': '""',
          'Accept': 'text/xml, multipart/related, */*',
          'User-Agent': 'AYSunat/1.0',
        },
        body: soapRequestXml,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();

      // 1. Verificar si la respuesta es un SOAP Fault (puede venir con HTTP 500 o 200)
      const fault = parseSoapFault(responseText);
      if (fault) {
        return {
          status: 'SOAP_FAULT',
          httpStatusCode: response.status,
          message: fault.faultString,
          fault,
          rawSoapResponse: responseText,
        };
      }

      // 2. Extraer applicationResponse (Base64 del ZIP de la CDR)
      const cdrZipBase64 = extractApplicationResponse(responseText);
      if (!cdrZipBase64) {
        return {
          status: 'SOAP_FAULT',
          httpStatusCode: response.status,
          message: `Respuesta de SUNAT sin Constancia de Recepción (HTTP ${response.status}).`,
          rawSoapResponse: responseText,
        };
      }

      // 3. Descomprimir y parsear la CDR
      const cdr = await parseCdrFromZip(cdrZipBase64);

      let status: SendBillStatus = 'REJECTED';
      if (cdr.isAccepted) {
        status = cdr.hasObservations ? 'ACCEPTED_WITH_OBSERVATIONS' : 'ACCEPTED';
      }

      return {
        status,
        httpStatusCode: response.status,
        message: cdr.description || (cdr.isAccepted ? 'Comprobante aceptado' : 'Comprobante rechazado'),
        cdr,
        rawSoapResponse: responseText,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        return {
          status: 'NETWORK_ERROR',
          httpStatusCode: 0,
          message: `Tiempo de espera agotado (${timeoutMs}ms) al conectar con SUNAT.`,
        };
      }

      return {
        status: 'NETWORK_ERROR',
        httpStatusCode: 0,
        message: `Error de red al conectar con SUNAT: ${err.message || String(err)}`,
      };
    }
  }

  /**
   * Método de alto nivel: toma el XML firmado del comprobante, lo empaqueta en ZIP con la
   * nomenclatura oficial y lo transmite a SUNAT mediante sendBill, retornando la CDR procesada.
   */
  public async sendCpe(
    packageInfo: CpePackageInfo,
    signedXml: string,
  ): Promise<SendBillResult> {
    // 1. Crear el ZIP oficial {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}.zip
    const zipPackage = await createCpeZip(packageInfo, signedXml);

    // 2. Transmitir por SOAP
    return this.sendBillZip(zipPackage.zipFileName, zipPackage.zipBuffer);
  }
}
