import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateXML } from 'xmllint-wasm';
import type { CpeTypeCode } from '../../core/tax-engine/types.js';

export interface XsdValidationError {
  message: string;
  rawMessage: string;
  line?: number;
  fileName?: string;
}

export interface XsdValidationResult {
  valid: boolean;
  cpeType: CpeTypeCode;
  schemaUsed: string;
  errors: XsdValidationError[];
  rawOutput: string;
}

export interface XsdValidationOptions {
  schemasDir?: string;
}

interface LoadedSchemas {
  invoiceSchema: string;
  creditNoteSchema: string;
  preload: Array<{ fileName: string; contents: string }>;
}

let cachedSchemas: LoadedSchemas | null = null;

function resolveSchemasDir(customDir?: string): string {
  if (customDir) return path.resolve(customDir);
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'schemas/ubl-2.1'),
    path.resolve(currentDir, '../../../schemas/ubl-2.1'),
    path.resolve(currentDir, '../../schemas/ubl-2.1'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'maindoc/UBL-Invoice-2.1.xsd'))) {
      return candidate;
    }
  }
  return path.resolve(process.cwd(), 'schemas/ubl-2.1');
}

function loadSchemas(schemasDir: string): LoadedSchemas {
  if (cachedSchemas) return cachedSchemas;

  const invoicePath = path.join(schemasDir, 'maindoc/UBL-Invoice-2.1.xsd');
  const creditNotePath = path.join(schemasDir, 'maindoc/UBL-CreditNote-2.1.xsd');
  const commonDir = path.join(schemasDir, 'common');

  if (!fs.existsSync(invoicePath) || !fs.existsSync(creditNotePath) || !fs.existsSync(commonDir)) {
    throw new Error(
      `Esquemas XSD UBL 2.1 no encontrados en: ${schemasDir}. Verifica que la carpeta 'schemas/ubl-2.1' exista en la raíz del proyecto.`,
    );
  }

  const invoiceSchema = fs.readFileSync(invoicePath, 'utf8');
  const creditNoteSchema = fs.readFileSync(creditNotePath, 'utf8');

  const preload: Array<{ fileName: string; contents: string }> = [];
  const commonFiles = fs.readdirSync(commonDir);
  for (const file of commonFiles) {
    if (file.endsWith('.xsd')) {
      preload.push({
        fileName: `../common/${file}`,
        contents: fs.readFileSync(path.join(commonDir, file), 'utf8'),
      });
    }
  }

  cachedSchemas = { invoiceSchema, creditNoteSchema, preload };
  return cachedSchemas;
}

/**
 * Valida un XML generado contra los esquemas oficiales OASIS UBL 2.1 de SUNAT.
 * Utiliza WebAssembly (xmllint-wasm) sin requerir compiladores o binarios C++ nativos.
 */
export async function validateUblXmlAgainstXsd(
  xml: string,
  cpeType: CpeTypeCode,
  options: XsdValidationOptions = {},
): Promise<XsdValidationResult> {
  const schemasDir = resolveSchemasDir(options.schemasDir);
  const { invoiceSchema, creditNoteSchema, preload } = loadSchemas(schemasDir);

  const isCreditNote = cpeType === '07';
  const mainSchema = isCreditNote ? creditNoteSchema : invoiceSchema;
  const schemaFileName = isCreditNote
    ? 'maindoc/UBL-CreditNote-2.1.xsd'
    : 'maindoc/UBL-Invoice-2.1.xsd';

  const result = await validateXML({
    xml: [{ fileName: 'document.xml', contents: xml }],
    schema: [{ fileName: schemaFileName, contents: mainSchema }],
    preload,
  });

  const errors: XsdValidationError[] = result.errors.map((e) => ({
    message: e.message,
    rawMessage: e.rawMessage,
    line: e.loc?.lineNumber,
    fileName: e.loc?.fileName,
  }));

  return {
    valid: result.valid,
    cpeType,
    schemaUsed: schemaFileName,
    errors,
    rawOutput: result.rawOutput,
  };
}
