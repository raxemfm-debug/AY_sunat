import type { SoapFaultDetail, SunatCredentials } from './types.js';

export const SUNAT_ENDPOINTS = {
  beta: 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService',
  production: 'https://e-facturacion.sunat.gob.pe/ol-ti-itcpfegem/billService',
} as const;

/**
 * Escapa caracteres especiales XML para valores de texto.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Construye el sobre SOAP 1.1 con WS-Security UsernameToken para la operación sendBill de SUNAT.
 */
export function buildSendBillEnvelope(
  credentials: SunatCredentials,
  fileName: string,
  contentFileBase64: string,
): string {
  const username = `${credentials.ruc.trim()}${credentials.username.trim()}`;
  const password = credentials.password;
  const cleanFileName = fileName.trim();
  const cleanContent = contentFileBase64.replace(/\s+/g, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ser="http://service.sunat.gob.pe"
                  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soapenv:Header>
    <wsse:Security>
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(password)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <ser:sendBill>
      <fileName>${escapeXml(cleanFileName)}</fileName>
      <contentFile>${cleanContent}</contentFile>
    </ser:sendBill>
  </soapenv:Body>
</soapenv:Envelope>`.trim();
}

/**
 * Extrae la respuesta applicationResponse (ZIP de la CDR en Base64) del sobre SOAP devuelto por SUNAT.
 */
export function extractApplicationResponse(soapXml: string): string | null {
  if (!soapXml) return null;
  const match = soapXml.match(/<(?:[a-zA-Z0-9_-]+:)?applicationResponse>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?applicationResponse>/);
  if (!match) return null;
  return match[1].replace(/\s+/g, '');
}

/**
 * Detecta y parsea un SOAP Fault en la respuesta XML devuelta por SUNAT.
 */
export function parseSoapFault(soapXml: string): SoapFaultDetail | null {
  if (!soapXml || !soapXml.includes('Fault')) return null;

  const faultCodeMatch = soapXml.match(/<(?:[a-zA-Z0-9_-]+:)?faultcode>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?faultcode>/);
  const faultStringMatch = soapXml.match(/<(?:[a-zA-Z0-9_-]+:)?faultstring>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?faultstring>/);
  const detailMatch = soapXml.match(/<(?:[a-zA-Z0-9_-]+:)?detail>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?detail>/);

  if (!faultCodeMatch && !faultStringMatch) return null;

  const faultCode = faultCodeMatch ? faultCodeMatch[1].trim() : 'UnknownFault';
  const faultString = faultStringMatch ? faultStringMatch[1].trim() : 'Error en el servicio SOAP de SUNAT';
  const detail = detailMatch ? detailMatch[1].trim() : undefined;

  const codeMatch = faultCode.match(/\.(\d+)$/) || faultString.match(/^(\d{4})\s*-/);
  const sunatErrorCode = codeMatch ? codeMatch[1] : undefined;

  return {
    faultCode,
    faultString,
    detail,
    sunatErrorCode,
  };
}
