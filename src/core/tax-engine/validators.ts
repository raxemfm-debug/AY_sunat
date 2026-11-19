import {
  CpeDocumentInput,
  IdentityDocTypeCode,
  IgvAffectationCode,
  CreditNoteTypeCode,
} from './types.js';

const VALID_IDENTITY_DOC_TYPES: IdentityDocTypeCode[] = ['0', '1', '4', '6', '7'];
const VALID_IGV_AFFECTATION_CODES: IgvAffectationCode[] = [
  '10', '11', '12', '13', '14', '15', '16', '17',
  '20', '21', '30', '31', '32', '33', '34', '35', '36', '40',
];
const VALID_CREDIT_NOTE_TYPES: CreditNoteTypeCode[] = [
  '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13',
];

export function validateRuc(ruc: string): string[] {
  const errors: string[] = [];
  if (!/^\d{11}$/.test(ruc)) {
    errors.push('El RUC debe contener exactamente 11 dígitos.');
    return errors;
  }
  const prefix = ruc.slice(0, 2);
  if (!['10', '15', '17', '20'].includes(prefix)) {
    errors.push('El prefijo del RUC no corresponde a un tipo válido de contribuyente peruano.');
  }
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((acc, weight, i) => acc + Number(ruc[i]) * weight, 0);
  const remainder = 11 - (sum % 11);
  const checkDigit = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder;
  if (checkDigit !== Number(ruc[10])) {
    errors.push('El dígito verificador del RUC no es válido.');
  }
  return errors;
}

export function validateIdentityDocument(docType: IdentityDocTypeCode, docNumber: string): string[] {
  const errors: string[] = [];
  if (!VALID_IDENTITY_DOC_TYPES.includes(docType)) {
    errors.push(`Tipo de documento de identidad no soportado: ${docType}`);
    return errors;
  }
  if (!/^\d+$/.test(docNumber)) {
    errors.push('El número de documento debe contener solo dígitos.');
    return errors;
  }
  if (docType === '1' && docNumber.length !== 8) errors.push('El DNI debe contener exactamente 8 dígitos.');
  if (docType === '6' && docNumber.length !== 11) errors.push('El RUC del cliente debe contener exactamente 11 dígitos.');
  if (docType === '4' && (docNumber.length < 8 || docNumber.length > 12)) errors.push('El Carnet de Extranjería debe contener entre 8 y 12 dígitos.');
  if (docType === '7' && (docNumber.length < 6 || docNumber.length > 12)) errors.push('El pasaporte debe contener entre 6 y 12 dígitos.');
  return errors;
}

export function validateCpeInput(input: CpeDocumentInput): string[] {
  const errors: string[] = [];

  errors.push(...validateRuc(input.company.ruc).map((e) => `Empresa: ${e}`));
  errors.push(...validateIdentityDocument(input.client.docType, input.client.docNumber).map((e) => `Cliente: ${e}`));

  if (!input.company.legalName.trim()) errors.push('La razón social / nombre del emisor es obligatoria.');
  if (!input.client.name.trim()) errors.push('El nombre o razón social del cliente es obligatorio.');
  if (!/^\d{6}$/.test(input.company.address.ubigeo)) errors.push('El ubigeo debe contener exactamente 6 dígitos.');

  const expectedPrefix = input.cpeType === '01' ? 'F' : input.cpeType === '03' ? 'B' : null;
  if (expectedPrefix && !new RegExp(`^${expectedPrefix}[A-Z0-9]{3}$`).test(input.series)) {
    errors.push(`La serie ${input.series} no es válida para el tipo de comprobante ${input.cpeType}.`);
  }
  if (input.cpeType === '07' && !/^[A-Z0-9]{4}$/.test(input.series)) {
    errors.push('La serie de la nota de crédito debe contener cuatro caracteres alfanuméricos.');
  }
  if (!Number.isInteger(input.correlative) || input.correlative <= 0) errors.push('El correlativo debe ser un entero positivo.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.issueDate)) errors.push('La fecha de emisión debe tener formato YYYY-MM-DD.');
  if (!['PEN', 'USD'].includes(input.currency)) errors.push(`Moneda no soportada: ${input.currency}`);
  if (input.currency === 'USD' && (!input.exchangeRate || Number(input.exchangeRate) <= 0)) {
    errors.push('Se requiere un tipo de cambio positivo para comprobantes en USD.');
  }
  if (input.items.length === 0) errors.push('El comprobante debe contener al menos un ítem.');

  input.items.forEach((item, index) => {
    if (!item.description.trim()) errors.push(`Ítem ${index + 1}: la descripción es obligatoria.`);
    if (!VALID_IGV_AFFECTATION_CODES.includes(item.affectationType)) errors.push(`Ítem ${index + 1}: código de afectación IGV inválido (${item.affectationType}).`);
    if (Number(item.quantity) <= 0) errors.push(`Ítem ${index + 1}: la cantidad debe ser mayor a cero.`);
    if (Number(item.unitPrice) < 0) errors.push(`Ítem ${index + 1}: el precio unitario no puede ser negativo.`);
    if (item.discountPercentage && (Number(item.discountPercentage) < 0 || Number(item.discountPercentage) > 100)) {
      errors.push(`Ítem ${index + 1}: el descuento porcentual debe estar entre 0 y 100.`);
    }
  });

  if (input.cpeType === '07') {
    if (!input.creditNoteInfo) {
      errors.push('La nota de crédito requiere información del documento afectado y tipo de nota.');
    } else {
      if (!VALID_CREDIT_NOTE_TYPES.includes(input.creditNoteInfo.discrepancyCode)) {
        errors.push(`Código de tipo de nota de crédito inválido: ${input.creditNoteInfo.discrepancyCode}`);
      }
      if (!input.creditNoteInfo.discrepancyReason.trim()) errors.push('La descripción de la nota de crédito es obligatoria.');
      if (!input.creditNoteInfo.modifiedDocSeries) errors.push('La serie del documento afectado es obligatoria.');
      if (!Number.isInteger(input.creditNoteInfo.modifiedDocCorrelative) || input.creditNoteInfo.modifiedDocCorrelative <= 0) {
        errors.push('El correlativo del documento afectado debe ser un entero positivo.');
      }
    }
  }

  if (input.cpeType !== '07' && input.creditNoteInfo) {
    errors.push('La información de nota de crédito solo puede enviarse para comprobantes tipo 07.');
  }

  return errors;
}
