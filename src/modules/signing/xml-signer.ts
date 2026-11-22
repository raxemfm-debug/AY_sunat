import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import type { CertificateData, SignXmlOptions, SignatureResult, VerifySignatureResult } from './types.js';

/**
 * Firma un XML de comprobante electrónico (Factura, Boleta o Nota) según la especificación
 * oficial de SUNAT UBL 2.1 (Enveloped Signature, C14N, RSA-SHA1 o RSA-SHA256).
 *
 * Devuelve el XML firmado y el hash del CPE (DigestValue), esencial para el código QR y la representación impresa.
 */
export function signUblXml(
  xml: string,
  cert: CertificateData,
  options: SignXmlOptions = {},
): SignatureResult {
  if (!xml || typeof xml !== 'string') {
    throw new Error('El XML a firmar no puede estar vacío.');
  }
  if (!cert.privateKeyPem || !cert.certificatePem) {
    throw new Error('Se requiere la clave privada y el certificado X.509 para firmar el documento.');
  }

  const signatureId = options.signatureId ?? 'SignatureSP';
  const algorithm = options.algorithm ?? 'sha1';

  const digestAlgorithm =
    algorithm === 'sha256'
      ? 'http://www.w3.org/2001/04/xmlenc#sha256'
      : 'http://www.w3.org/2000/09/xmldsig#sha1';

  const signatureAlgorithm =
    algorithm === 'sha256'
      ? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
      : 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';

  // Si el XML ya contenía un placeholder o firma anterior dentro de ExtensionContent, lo limpiamos
  const normalizedXml = xml.replace(
    /<(?:ext:)?ExtensionContent>[\s\S]*?<\/(?:ext:)?ExtensionContent>/,
    '<ext:ExtensionContent/>',
  );

  const sig = new SignedXml();
  sig.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature'],
    digestAlgorithm,
    isEmptyUri: true,
  });

  sig.canonicalizationAlgorithm = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  sig.signatureAlgorithm = signatureAlgorithm;
  sig.privateKey = cert.privateKeyPem;
  sig.publicCert = cert.certificatePem;

  sig.computeSignature(normalizedXml, {
    location: {
      reference: '//*[local-name(.)="ExtensionContent"]',
      action: 'append',
    },
    attrs: {
      Id: signatureId,
    },
  });

  const signedXml = sig.getSignedXml();

  // Extraer DigestValue (Hash del CPE)
  const digestMatch = signedXml.match(/<(?:\w+:)?DigestValue>([^<]+)<\/(?:\w+:)?DigestValue>/);
  if (!digestMatch) {
    throw new Error('No se pudo extraer el DigestValue (Hash del comprobante) tras la firma.');
  }
  const hashCpe = digestMatch[1].trim();

  // Extraer SignatureValue
  const sigMatch = signedXml.match(/<(?:\w+:)?SignatureValue>([^<]+)<\/(?:\w+:)?SignatureValue>/);
  const signatureValue = sigMatch ? sigMatch[1].replace(/\s+/g, '') : '';

  return {
    signedXml,
    hashCpe,
    signatureValue,
    algorithm: `rsa-${algorithm}`,
  };
}

/**
 * Extrae el Hash oficial del comprobante (DigestValue) desde un XML ya firmado.
 */
export function extractHashCpe(signedXml: string): string {
  const match = signedXml.match(/<(?:\w+:)?DigestValue>([^<]+)<\/(?:\w+:)?DigestValue>/);
  if (!match) {
    throw new Error('No se encontró el elemento DigestValue en el XML firmado.');
  }
  return match[1].trim();
}

/**
 * Valida la integridad criptográfica de un XML firmado.
 * Si no se proporciona un certificado explícito, intenta usar el certificado incrustado en el XML.
 */
export function verifySignedXml(signedXml: string, customCertPem?: string): VerifySignatureResult {
  try {
    const doc = new DOMParser().parseFromString(signedXml, 'text/xml');
    const signatureNodes = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature');
    if (!signatureNodes.length) {
      return { isValid: false, error: 'No se encontró el elemento Signature en el documento XML.' };
    }
    const signatureNode = signatureNodes[0];

    let certPem = customCertPem;
    if (!certPem) {
      const certNodes = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
      if (!certNodes.length || !certNodes[0].textContent) {
        return { isValid: false, error: 'No se encontró el certificado X.509 en la firma.' };
      }
      certPem = `-----BEGIN CERTIFICATE-----\n${certNodes[0].textContent.trim()}\n-----END CERTIFICATE-----`;
    }

    const verifier = new SignedXml();
    verifier.publicCert = certPem;
    verifier.loadSignature(signatureNode);
    const isValid = verifier.checkSignature(signedXml);

    return {
      isValid,
      error: isValid ? undefined : (verifier as any).validationErrors?.join(', ') || 'La firma criptográfica no es válida.',
    };
  } catch (err: any) {
    return {
      isValid: false,
      error: err.message ?? 'Error desconocido durante la verificación de la firma.',
    };
  }
}
