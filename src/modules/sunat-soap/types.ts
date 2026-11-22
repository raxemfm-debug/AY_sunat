export type SunatEnvironment = 'beta' | 'production' | 'custom';

export interface SunatCredentials {
  /** RUC del emisor (11 dígitos) */
  ruc: string;
  /** Usuario secundario SOL (ej. MODDATOS) */
  username: string;
  /** Clave SOL del usuario secundario */
  password: string;
}

export interface SunatClientConfig {
  credentials: SunatCredentials;
  /** 'beta' (homologación/pruebas) o 'production'. Por defecto 'beta' */
  environment?: SunatEnvironment;
  /** URL personalizada para pruebas de integración o mocks locales */
  customUrl?: string;
  /** Tiempo de espera máximo en milisegundos (por defecto 30000 ms = 30s) */
  timeoutMs?: number;
  /** Función fetch inyectable (útil para pruebas unitarias sin llamadas a red) */
  fetchFn?: typeof fetch;
}

export interface SoapFaultDetail {
  faultCode: string;
  faultString: string;
  detail?: string;
  sunatErrorCode?: string;
}

export interface SunatCdrObservation {
  code: string;
  message: string;
}

export interface SunatCdr {
  /** Identificador de la CDR (ej. R-20600000001-01-F001-00000001) */
  id: string;
  /** Serie y correlativo del comprobante referenciado (ej. F001-00000001) */
  referenceId: string;
  /** Tipo de comprobante (ej. '01', '03', '07') */
  documentTypeCode: string;
  /** Código numérico de respuesta SUNAT: '0' (Aceptado), '0100'-'3999' (Rechazo), '4000'+ (Observación) */
  responseCode: string;
  /** Descripción textual devuelta por SUNAT */
  description: string;
  /** Indica si SUNAT aceptó formalmente el comprobante (responseCode === '0') */
  isAccepted: boolean;
  /** Indica si el comprobante fue aceptado pero cuenta con observaciones técnicas */
  hasObservations: boolean;
  /** Observaciones y advertencias devueltas por SUNAT */
  observations: SunatCdrObservation[];
  /** Notas textuales devueltas en cbc:Note */
  notes: string[];
  /** Fecha de emisión de la CDR por SUNAT (YYYY-MM-DD) */
  issueDate: string;
  /** Hora de emisión de la CDR (HH:mm:ss) */
  issueTime: string;
  /** Fecha y hora de recepción si están presentes */
  responseDate?: string;
  responseTime?: string;
  /** RUC de SUNAT (habitualmente 20131312955) */
  senderRuc?: string;
  /** RUC del contribuyente receptor de la CDR */
  receiverRuc?: string;
  /** Hash criptográfico del CDR firmado por SUNAT (DigestValue) */
  cdrHash?: string;
  /** Firma de SUNAT (SignatureValue) */
  signatureValue?: string;
  /** Contenido XML íntegro de la CDR */
  xmlContent: string;
  /** Archivo ZIP original en Base64 devuelto por SUNAT (para almacenar en BD) */
  zipBase64?: string;
}

export type SendBillStatus =
  | 'ACCEPTED'
  | 'ACCEPTED_WITH_OBSERVATIONS'
  | 'REJECTED'
  | 'SOAP_FAULT'
  | 'NETWORK_ERROR';

export interface SendBillResult {
  /** Estado consolidado de la operación */
  status: SendBillStatus;
  /** Resumen del resultado */
  message: string;
  /** Código de estado HTTP retornado */
  httpStatusCode: number;
  /** Información parseada de la Constancia de Recepción (si SUNAT devolvió CDR) */
  cdr?: SunatCdr;
  /** Detalle del fallo si ocurrió un SOAP Fault */
  fault?: SoapFaultDetail;
  /** XML SOAP crudo devuelto por el servidor */
  rawSoapResponse?: string;
}
