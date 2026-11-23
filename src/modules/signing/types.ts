export interface CertificateData {
  privateKeyPem: string;
  certificatePem: string;
  subject?: string;
  issuer?: string;
  serialNumber?: string;
  validFrom?: Date;
  validTo?: Date;
}

export interface SignXmlOptions {
  /** Id del nodo ds:Signature (por defecto "SignatureSP") */
  signatureId?: string;
  /** Algoritmo de firma RSA: 'sha1' (estándar tradicional SUNAT UBL 2.1) o 'sha256' */
  algorithm?: 'sha1' | 'sha256';
}

export interface SignatureResult {
  /** XML firmado con el elemento ds:Signature insertado dentro de ext:ExtensionContent */
  signedXml: string;
  /** Hash del comprobante (DigestValue en Base64). Obligatorio para QR y PDF */
  hashCpe: string;
  /** Valor de la firma criptográfica (SignatureValue en Base64) */
  signatureValue: string;
  /** Algoritmo utilizado */
  algorithm: string;
}

export interface VerifySignatureResult {
  isValid: boolean;
  error?: string;
}
