import { DOMParser } from '@xmldom/xmldom';
import { extractCpeZip } from '../packaging/index.js';
import type { SunatCdr, SunatCdrObservation } from './types.js';

/**
 * Obtiene el texto del primer elemento coincidente ignorando prefijos de namespace.
 */
function getElementText(doc: any, localName: string): string {
  const elements = doc.getElementsByTagNameNS('*', localName);
  if (elements.length > 0 && elements[0].textContent) {
    return elements[0].textContent.trim();
  }
  // Fallback sin namespace por si acaso
  const fallback = doc.getElementsByTagName(localName);
  if (fallback.length > 0 && fallback[0].textContent) {
    return fallback[0].textContent.trim();
  }
  return '';
}

/**
 * Parsea el XML de la Constancia de Recepción (ApplicationResponse) oficial de SUNAT.
 *
 * @param cdrXml Contenido XML del comprobante ApplicationResponse emitido por SUNAT
 * @param zipBase64 Archivo ZIP original en Base64 (opcional, para trazabilidad y guardado en BD)
 */
export function parseCdrXml(cdrXml: string, zipBase64?: string): SunatCdr {
  if (!cdrXml || typeof cdrXml !== 'string') {
    throw new Error('El XML de la CDR no puede estar vacío.');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(cdrXml, 'text/xml');

  // Identificador propio de la CDR (ej. R-20600000001-01-F001-00000001)
  const id = getElementText(doc, 'ID');
  const issueDate = getElementText(doc, 'IssueDate');
  const issueTime = getElementText(doc, 'IssueTime');
  const responseDate = getElementText(doc, 'ResponseDate') || issueDate;
  const responseTime = getElementText(doc, 'ResponseTime') || issueTime;

  // Extraer información del emisor y receptor
  let senderRuc = '';
  const senderParty = doc.getElementsByTagNameNS('*', 'SenderParty');
  if (senderParty.length > 0) {
    senderRuc = getElementText(senderParty[0], 'ID');
  }

  let receiverRuc = '';
  const receiverParty = doc.getElementsByTagNameNS('*', 'ReceiverParty');
  if (receiverParty.length > 0) {
    receiverRuc = getElementText(receiverParty[0], 'ID');
  }

  // DocumentResponse principal
  let referenceId = '';
  let responseCode = '';
  let description = '';
  let documentTypeCode = '';

  const docResponses = doc.getElementsByTagNameNS('*', 'DocumentResponse');
  if (docResponses.length > 0) {
    const docResp = docResponses[0];

    const responses = docResp.getElementsByTagNameNS('*', 'Response');
    if (responses.length > 0) {
      referenceId = getElementText(responses[0], 'ReferenceID');
      responseCode = getElementText(responses[0], 'ResponseCode');
      description = getElementText(responses[0], 'Description');
    }

    const docRefs = docResp.getElementsByTagNameNS('*', 'DocumentReference');
    if (docRefs.length > 0) {
      if (!referenceId) {
        referenceId = getElementText(docRefs[0], 'ID');
      }
      documentTypeCode = getElementText(docRefs[0], 'DocumentTypeCode');
    }
  }

  // Si no se ubicó dentro de DocumentResponse, buscar a nivel raíz
  if (!referenceId) referenceId = getElementText(doc, 'ReferenceID');
  if (!responseCode) responseCode = getElementText(doc, 'ResponseCode');
  if (!description) description = getElementText(doc, 'Description');

  // Extraer notas u observaciones (cbc:Note)
  const notes: string[] = [];
  const noteElements = doc.getElementsByTagNameNS('*', 'Note');
  for (let i = 0; i < noteElements.length; i++) {
    const noteText = noteElements[i].textContent?.trim();
    if (noteText) {
      notes.push(noteText);
    }
  }

  // Extraer observaciones estructuradas
  const observations: SunatCdrObservation[] = [];
  const statusElements = doc.getElementsByTagNameNS('*', 'StatusReasonCode');
  for (let i = 0; i < statusElements.length; i++) {
    const code = statusElements[i].textContent?.trim() || '';
    if (code) {
      observations.push({
        code,
        message: notes.find((n) => n.startsWith(code)) || `Observación SUNAT código ${code}`,
      });
    }
  }

  // Si no vinieron StatusReasonCode pero hay Notes con códigos (ej. "4010 - ...")
  if (observations.length === 0) {
    for (const note of notes) {
      const match = note.match(/^(\d{4})\s*[-:]\s*(.*)$/);
      if (match) {
        observations.push({
          code: match[1],
          message: match[2].trim(),
        });
      }
    }
  }

  // Hash y firma de SUNAT
  const cdrHash = getElementText(doc, 'DigestValue') || undefined;
  const signatureValue = getElementText(doc, 'SignatureValue')?.replace(/\s+/g, '') || undefined;

  const isAccepted = responseCode === '0';
  const hasObservations = isAccepted && (observations.length > 0 || notes.length > 0);

  return {
    id,
    referenceId,
    documentTypeCode,
    responseCode,
    description,
    isAccepted,
    hasObservations,
    observations,
    notes,
    issueDate,
    issueTime,
    responseDate,
    responseTime,
    senderRuc: senderRuc || undefined,
    receiverRuc: receiverRuc || undefined,
    cdrHash,
    signatureValue,
    xmlContent: cdrXml,
    zipBase64,
  };
}

/**
 * Descomprime un archivo ZIP de Constancia de Recepción (CDR) devuelto por SUNAT y parsea su XML.
 *
 * @param zipInput Buffer binario o cadena Base64 del ZIP de la CDR devuelto por sendBill
 */
export async function parseCdrFromZip(zipInput: Buffer | Uint8Array | string): Promise<SunatCdr> {
  const zipBase64 = typeof zipInput === 'string' ? zipInput.replace(/\s+/g, '') : Buffer.from(zipInput).toString('base64');
  const unzipped = await extractCpeZip(zipInput);
  return parseCdrXml(unzipped.xmlContent, zipBase64);
}
