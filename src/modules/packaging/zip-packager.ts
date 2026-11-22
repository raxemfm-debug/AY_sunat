import JSZip from 'jszip';
import type { CpePackageInfo, UnzippedCpeResult, ZipPackageResult } from './types.js';

/**
 * Valida y formatea el nombre base oficial exigido por SUNAT:
 * {RUC}-{TIPO_CPE}-{SERIE}-{CORRELATIVO}
 * Ejemplo: 20600000001-01-F001-00000001
 */
export function formatCpeFileName(info: CpePackageInfo): string {
  const ruc = String(info.ruc || '').trim();
  if (!/^\d{11}$/.test(ruc)) {
    throw new Error(`RUC inválido para nomenclatura SUNAT: "${ruc}". Debe tener 11 dígitos numéricos.`);
  }

  const cpeType = String(info.cpeType || '').trim().padStart(2, '0');
  if (!/^\d{2}$/.test(cpeType)) {
    throw new Error(`Tipo de comprobante inválido: "${info.cpeType}". Debe tener 2 dígitos (ej. 01, 03, 07).`);
  }

  const series = String(info.series || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(series)) {
    throw new Error(`Serie inválida: "${info.series}". Debe tener exactamente 4 caracteres alfanuméricos (ej. F001, B001).`);
  }

  const correlativeNum = parseInt(String(info.correlative), 10);
  if (isNaN(correlativeNum) || correlativeNum <= 0 || correlativeNum > 99999999) {
    throw new Error(`Correlativo inválido: "${info.correlative}". Debe ser un número entre 1 y 99999999.`);
  }
  const correlative = String(correlativeNum).padStart(8, '0');

  return `${ruc}-${cpeType}-${series}-${correlative}`;
}

/**
 * Empaqueta un XML firmado en un archivo ZIP con la nomenclatura y estructura requerida por SUNAT:
 * Archivo: {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}.zip
 * Contenido interno: {RUC}-{TIPO}-{SERIE}-{CORRELATIVO}.xml (directamente en la raíz del ZIP, sin subcarpetas).
 */
export async function createCpeZip(info: CpePackageInfo, signedXml: string): Promise<ZipPackageResult> {
  if (!signedXml || typeof signedXml !== 'string') {
    throw new Error('El XML a empaquetar no puede estar vacío.');
  }

  const baseName = formatCpeFileName(info);
  const xmlFileName = `${baseName}.xml`;
  const zipFileName = `${baseName}.zip`;

  const zip = new JSZip();
  // Regla estricta SUNAT: exactamente 1 archivo en la raíz del ZIP
  zip.file(xmlFileName, signedXml);

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 6,
    },
  });

  return {
    baseName,
    xmlFileName,
    zipFileName,
    zipBuffer,
    zipBase64: zipBuffer.toString('base64'),
    fileSize: zipBuffer.length,
  };
}

/**
 * Descomprime y extrae el XML de un paquete CPE o de una Constancia de Recepción (CDR) de SUNAT.
 */
export async function extractCpeZip(zipInput: Buffer | Uint8Array | string): Promise<UnzippedCpeResult> {
  const zipBuffer = typeof zipInput === 'string' ? Buffer.from(zipInput, 'base64') : Buffer.from(zipInput);
  const zip = await JSZip.loadAsync(zipBuffer);

  const fileNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  if (!fileNames.length) {
    throw new Error('El archivo ZIP no contiene ningún archivo.');
  }

  // Buscar el archivo XML
  const xmlName = fileNames.find((name) => name.toLowerCase().endsWith('.xml')) || fileNames[0];
  const xmlFile = zip.file(xmlName);
  if (!xmlFile) {
    throw new Error(`No se pudo leer el archivo ${xmlName} dentro del ZIP.`);
  }

  const xmlContent = await xmlFile.async('text');
  return {
    xmlFileName: xmlName,
    xmlContent,
  };
}
