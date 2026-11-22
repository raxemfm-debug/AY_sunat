import type {
  CalculatedItem,
  CpeDocumentCalculationResult,
  CpeDocumentInput,
} from '../../core/tax-engine/types.js';
import { SUPPORTED_CPE_TYPES, UBL_NAMESPACES, type UblXmlOptions } from './types.js';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const CATALOG = {
  documentType: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01',
  identityType: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo06',
  igvAffectation: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo07',
  creditNoteReason: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo09',
  operationType: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo51',
  priceType: 'urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo16',
} as const;

export function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: unknown, attrs = ''): string {
  return `<${name}${attrs}>${escapeXml(value)}</${name}>`;
}

function amount(value: string): string {
  if (!/^-?\d+\.\d{2}$/.test(value)) {
    throw new Error(`Importe monetario no tiene formato de 2 decimales: ${value}`);
  }
  return value;
}

function validateDocument(input: CpeDocumentInput, result: CpeDocumentCalculationResult): void {
  if (!SUPPORTED_CPE_TYPES.includes(input.cpeType)) {
    throw new Error(`Tipo de CPE no soportado: ${input.cpeType}`);
  }
  if (input.cpeType !== result.header.cpeType) {
    throw new Error('El tipo de documento de entrada no coincide con el resultado calculado.');
  }
  if (input.cpeType === '07' && !input.creditNoteInfo) {
    throw new Error('La Nota de Crédito requiere creditNoteInfo.');
  }
  if (!result.items.length) throw new Error('El comprobante debe contener al menos un ítem.');
  const unsupported = result.items.find((item) => item.affectationType !== '10');
  if (unsupported) {
    throw new Error(`Afectación IGV ${unsupported.affectationType} aún no está implementada; no se generó XML.`);
  }
  if (
    result.totals.operacionesExoneradas !== '0.00' ||
    result.totals.operacionesInafectas !== '0.00' ||
    result.totals.operacionesGratuitas !== '0.00'
  ) {
    throw new Error('Este generador inicial solo soporta operaciones gravadas con IGV 10.');
  }
}

function placeholderSignature(signatureId: string): string {
  // Estructura XMLDSig mínima válida requerida por el esquema UBL / xmldsig-core
  return `  <ext:UBLExtensions>
    <ext:UBLExtension>
      <ext:ExtensionContent>
        <ds:Signature Id="${escapeXml(signatureId)}">
          <ds:SignedInfo>
            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
            <ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>
            <ds:Reference URI="">
              <ds:Transforms>
                <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
              </ds:Transforms>
              <ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>
              <ds:DigestValue>eHl6</ds:DigestValue>
            </ds:Reference>
          </ds:SignedInfo>
          <ds:SignatureValue>eHl6</ds:SignatureValue>
        </ds:Signature>
      </ext:ExtensionContent>
    </ext:UBLExtension>
  </ext:UBLExtensions>`;
}

function signatureDeclaration(companyRuc: string, signatureId: string): string {
  return `  <cac:Signature>
    ${tag('cbc:ID', companyRuc)}
    <cac:SignatoryParty><cac:PartyIdentification>${tag('cbc:ID', companyRuc)}</cac:PartyIdentification><cac:PartyName>${tag('cbc:Name', companyRuc)}</cac:PartyName></cac:SignatoryParty>
    <cac:DigitalSignatureAttachment><cac:ExternalReference>${tag('cbc:URI', `#${signatureId}`)}</cac:ExternalReference></cac:DigitalSignatureAttachment>
  </cac:Signature>`;
}

function supplierParty(input: CpeDocumentInput): string {
  const c = input.company;
  return `  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification>${tag('cbc:ID', c.ruc, ` schemeID="6" schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="${CATALOG.identityType}"`)}</cac:PartyIdentification>
    <cac:PartyName>${tag('cbc:Name', c.tradeName || c.legalName)}</cac:PartyName>
    <cac:PartyLegalEntity>${tag('cbc:RegistrationName', c.legalName)}
      <cac:RegistrationAddress>
        ${tag('cbc:ID', c.address.ubigeo)}${tag('cbc:CityName', c.address.province)}${tag('cbc:CountrySubentity', c.address.department)}${tag('cbc:District', c.address.district)}
        <cac:AddressLine>${tag('cbc:Line', c.address.addressLine)}</cac:AddressLine>
        <cac:Country>${tag('cbc:IdentificationCode', 'PE', ' listID="ISO 3166-1" listAgencyName="United Nations Economic Commission for Europe"')}</cac:Country>
      </cac:RegistrationAddress>
    </cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>`;
}

function customerParty(input: CpeDocumentInput): string {
  const c = input.client;
  return `  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyIdentification>${tag('cbc:ID', c.docNumber, ` schemeID="${escapeXml(c.docType)}" schemeName="Documento de Identidad" schemeAgencyName="PE:SUNAT" schemeURI="${CATALOG.identityType}"`)}</cac:PartyIdentification>
    <cac:PartyLegalEntity>${tag('cbc:RegistrationName', c.name)}</cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>`;
}

function commonMetadata(input: CpeDocumentInput, result: CpeDocumentCalculationResult, profileId: string): string {
  const { header, totals } = result;
  return `  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID schemeAgencyName="PE:SUNAT">2.0</cbc:CustomizationID>
  ${tag('cbc:ProfileID', profileId, ` schemeName="Tipo de Operacion" schemeAgencyName="PE:SUNAT" schemeURI="${CATALOG.operationType}"`)}
  ${tag('cbc:ID', header.fullNumber)}
  ${tag('cbc:IssueDate', header.issueDate)}
  ${tag('cbc:IssueTime', input.issueTime ?? '00:00:00')}
  ${tag('cbc:InvoiceTypeCode', header.cpeType, ` listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="${CATALOG.documentType}" listID="${profileId}" name="Tipo de Operacion"`)}
  ${tag('cbc:Note', totals.totalEnLetras, ' languageLocaleID="1000"')}
  ${tag('cbc:DocumentCurrencyCode', header.currency, ' listID="ISO 4217 Alpha" listName="Currency" listAgencyName="United Nations Economic Commission for Europe"')}`;
}

function taxTotal(result: CpeDocumentCalculationResult): string {
  const currency = result.header.currency;
  const base = amount(result.totals.operacionesGravadas);
  const tax = amount(result.totals.montoIgv);
  return `  <cac:TaxTotal>${tag('cbc:TaxAmount', tax, ` currencyID="${currency}"`)}
    <cac:TaxSubtotal>${tag('cbc:TaxableAmount', base, ` currencyID="${currency}"`)}${tag('cbc:TaxAmount', tax, ` currencyID="${currency}"`)}
      <cac:TaxCategory><cac:TaxScheme>${tag('cbc:ID', '1000', ' schemeID="UN/ECE 5153" schemeAgencyID="6"')}${tag('cbc:Name', 'IGV')}${tag('cbc:TaxTypeCode', 'VAT')}</cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>`;
}

function legalMonetaryTotal(result: CpeDocumentCalculationResult): string {
  const currency = result.header.currency;
  const subtotal = amount(result.totals.subTotal);
  const total = amount(result.totals.totalPagar);
  return `  <cac:LegalMonetaryTotal>
    ${tag('cbc:LineExtensionAmount', subtotal, ` currencyID="${currency}"`)}
    ${tag('cbc:TaxExclusiveAmount', subtotal, ` currencyID="${currency}"`)}
    ${tag('cbc:TaxInclusiveAmount', total, ` currencyID="${currency}"`)}
    ${tag('cbc:PayableAmount', total, ` currencyID="${currency}"`)}
  </cac:LegalMonetaryTotal>`;
}

function lineTax(item: CalculatedItem, currency: string): string {
  return `    <cac:TaxTotal>${tag('cbc:TaxAmount', amount(item.igvAmount), ` currencyID="${currency}"`)}
      <cac:TaxSubtotal>${tag('cbc:TaxableAmount', amount(item.baseAmount), ` currencyID="${currency}"`)}${tag('cbc:TaxAmount', amount(item.igvAmount), ` currencyID="${currency}"`)}
        <cac:TaxCategory>${tag('cbc:Percent', '18.00')}${tag('cbc:TaxExemptionReasonCode', item.affectationType, ` listAgencyName="PE:SUNAT" listName="Afectacion del IGV" listURI="${CATALOG.igvAffectation}"`)}
          <cac:TaxScheme>${tag('cbc:ID', '1000', ' schemeID="UN/ECE 5153" schemeAgencyID="6"')}${tag('cbc:Name', 'IGV')}${tag('cbc:TaxTypeCode', 'VAT')}</cac:TaxScheme>
        </cac:TaxCategory></cac:TaxSubtotal>
    </cac:TaxTotal>`;
}

function lineItem(item: CalculatedItem): string {
  const sellerCode = item.code
    ? `<cac:SellersItemIdentification>${tag('cbc:ID', item.code)}</cac:SellersItemIdentification>`
    : '';
  return `    <cac:Item>${tag('cbc:Description', item.description)}${sellerCode}</cac:Item>`;
}

function invoiceLine(item: CalculatedItem, index: number, currency: string): string {
  return `  <cac:InvoiceLine>
    ${tag('cbc:ID', index)}
    ${tag('cbc:InvoicedQuantity', item.quantity, ` unitCode="${escapeXml(item.unitCode)}"`)}
    ${tag('cbc:LineExtensionAmount', amount(item.baseAmount), ` currencyID="${currency}"`)}
    <cac:PricingReference><cac:AlternativeConditionPrice>${tag('cbc:PriceAmount', amount(item.unitPrice), ` currencyID="${currency}"`)}${tag('cbc:PriceTypeCode', '01', ` listName="Tipo de Precio" listAgencyName="PE:SUNAT" listURI="${CATALOG.priceType}"`)}</cac:AlternativeConditionPrice></cac:PricingReference>
${lineTax(item, currency)}
${lineItem(item)}
    <cac:Price>${tag('cbc:PriceAmount', amount(item.unitValue), ` currencyID="${currency}"`)}</cac:Price>
  </cac:InvoiceLine>`;
}

function creditNoteLine(item: CalculatedItem, index: number, currency: string): string {
  return invoiceLine(item, index, currency)
    .replace('<cac:InvoiceLine>', '<cac:CreditNoteLine>')
    .replace('</cac:InvoiceLine>', '</cac:CreditNoteLine>')
    .replaceAll("cbc:InvoicedQuantity", "cbc:CreditedQuantity");
}

function xmlPrefix(options: UblXmlOptions): string {
  return options.includeXmlDeclaration === false ? '' : `${XML_DECLARATION}\n`;
}

/** Generates an unsigned UBL 2.1 XML draft for invoice (01), receipt (03), or credit note (07). */
export function generateUblXml(
  result: CpeDocumentCalculationResult,
  input: CpeDocumentInput,
  options: UblXmlOptions = {},
): string {
  validateDocument(input, result);
  const currency = result.header.currency;
  const prefix = xmlPrefix(options);
  const signatureId = options.signatureId ?? 'SignatureSP';

  if (input.cpeType === '07') {
    return generateCreditNote(result, input, signatureId, prefix, currency);
  }

  const profileId = options.profileId ?? '0101';
  const lines = result.items.map((item, i) => invoiceLine(item, i + 1, currency)).join('\n');
  const payment = `  <cac:PaymentTerms>${tag('cbc:ID', 'FormaPago')}${tag('cbc:PaymentMeansID', input.paymentMethod === 'CONTADO' ? 'Contado' : 'Credito')}</cac:PaymentTerms>`;
  return `${prefix}<Invoice ${UBL_NAMESPACES.invoice}>\n${placeholderSignature(signatureId)}\n${commonMetadata(input, result, profileId)}\n${signatureDeclaration(input.company.ruc, signatureId)}\n${supplierParty(input)}\n${customerParty(input)}\n${payment}\n${taxTotal(result)}\n${legalMonetaryTotal(result)}\n${lines}\n</Invoice>`;
}

function generateCreditNote(
  result: CpeDocumentCalculationResult,
  input: CpeDocumentInput,
  signatureId: string,
  prefix: string,
  currency: string,
): string {
  const info = input.creditNoteInfo!;
  const modifiedNumber = `${info.modifiedDocSeries}-${String(info.modifiedDocCorrelative).padStart(8, '0')}`;
  const header = `  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID schemeAgencyName="PE:SUNAT">2.0</cbc:CustomizationID>
  ${tag('cbc:ID', result.header.fullNumber)}
  ${tag('cbc:IssueDate', result.header.issueDate)}
  ${tag('cbc:IssueTime', input.issueTime ?? '00:00:00')}
  ${tag('cbc:Note', result.totals.totalEnLetras, ' languageLocaleID="1000"')}
  ${tag('cbc:DocumentCurrencyCode', currency, ' listID="ISO 4217 Alpha" listName="Currency" listAgencyName="United Nations Economic Commission for Europe"')}`;
  const discrepancy = `  <cac:DiscrepancyResponse>${tag('cbc:ReferenceID', modifiedNumber)}${tag('cbc:ResponseCode', info.discrepancyCode, ` listAgencyName="PE:SUNAT" listName="Tipo de nota de credito" listURI="${CATALOG.creditNoteReason}"`)}${tag('cbc:Description', info.discrepancyReason)}</cac:DiscrepancyResponse>`;
  const billing = `  <cac:BillingReference><cac:InvoiceDocumentReference>${tag('cbc:ID', modifiedNumber)}${tag('cbc:DocumentTypeCode', info.modifiedDocType, ` listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="${CATALOG.documentType}"`)}</cac:InvoiceDocumentReference></cac:BillingReference>`;
  const lines = result.items.map((item, i) => creditNoteLine(item, i + 1, currency)).join('\n');
  return `${prefix}<CreditNote ${UBL_NAMESPACES.creditNote}>\n${placeholderSignature(signatureId)}\n${header}\n${discrepancy}\n${billing}\n${signatureDeclaration(input.company.ruc, signatureId)}\n${supplierParty(input)}\n${customerParty(input)}\n${taxTotal(result)}\n${legalMonetaryTotal(result)}\n${lines}\n</CreditNote>`;
}
