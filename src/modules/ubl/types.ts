import { CpeTypeCode } from '../../core/tax-engine/types.js';

export interface UblXmlOptions {
  /** Código de tipo de operación SUNAT. Venta interna: 0101. */
  profileId?: string;
  /** URI de referencia que deberá usar el firmador XMLDSig. */
  signatureId?: string;
  includeXmlDeclaration?: boolean;
}

export const UBL_NAMESPACES = {
  invoice: [
    'xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"',
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
  ].join(' '),
  creditNote: [
    'xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
  ].join(' '),
} satisfies Record<'invoice' | 'creditNote', string>;

export const SUPPORTED_CPE_TYPES: readonly CpeTypeCode[] = ['01', '03', '07'];
