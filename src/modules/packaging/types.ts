export interface CpePackageInfo {
  /** RUC del emisor (11 dígitos) */
  ruc: string;
  /** Código de tipo de comprobante SUNAT: '01' (Factura), '03' (Boleta), '07' (NC) */
  cpeType: string;
  /** Serie del comprobante (4 caracteres, ej. F001, B001, FC01) */
  series: string;
  /** Número correlativo (número entero o cadena, se rellena a 8 dígitos) */
  correlative: number | string;
}

export interface ZipPackageResult {
  /** Nombre base oficial del comprobante: {RUC}-{TIPO}-{SERIE}-{NUMERO} */
  baseName: string;
  /** Nombre del archivo XML dentro del ZIP */
  xmlFileName: string;
  /** Nombre oficial del archivo ZIP */
  zipFileName: string;
  /** Buffer binario del archivo ZIP comprimido */
  zipBuffer: Buffer;
  /** Archivo ZIP codificado en Base64 para envío SOAP (sendBill) */
  zipBase64: string;
  /** Tamaño del archivo ZIP en bytes */
  fileSize: number;
}

export interface UnzippedCpeResult {
  xmlFileName: string;
  xmlContent: string;
}
