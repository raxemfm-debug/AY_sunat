import forge from 'node-forge';
import type { CertificateData } from './types.js';

/**
 * Carga un certificado digital desde un archivo PKCS#12 (.pfx / .p12) y su contraseña.
 * Extrae la clave privada RSA en formato PEM y el certificado X.509.
 */
export function loadCertificateFromPfx(pfxBuffer: Buffer | Uint8Array, password = ''): CertificateData {
  try {
    const binaryStr = Buffer.from(pfxBuffer).toString('binary');
    const p12Asn1 = forge.asn1.fromDer(binaryStr);
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

    let keyPem = '';
    let certPem = '';
    let certObj: forge.pki.Certificate | null = null;

    for (const safeContent of p12.safeContents) {
      for (const safeBag of safeContent.safeBags) {
        if (safeBag.key) {
          keyPem = forge.pki.privateKeyToPem(safeBag.key);
        }
        if (safeBag.cert) {
          certPem = forge.pki.certificateToPem(safeBag.cert);
          certObj = safeBag.cert;
        }
      }
    }

    if (!keyPem) {
      throw new Error('No se encontró la clave privada RSA en el archivo PFX proporcionado.');
    }
    if (!certPem) {
      throw new Error('No se encontró el certificado X.509 en el archivo PFX proporcionado.');
    }

    const subjectAttrs = certObj?.subject?.attributes?.map((a: any) => `${a.shortName || a.name}=${a.value}`).join(', ');
    const issuerAttrs = certObj?.issuer?.attributes?.map((a: any) => `${a.shortName || a.name}=${a.value}`).join(', ');

    return {
      privateKeyPem: keyPem,
      certificatePem: certPem,
      subject: subjectAttrs,
      issuer: issuerAttrs,
      serialNumber: certObj?.serialNumber,
      validFrom: certObj?.validity?.notBefore,
      validTo: certObj?.validity?.notAfter,
    };
  } catch (err: any) {
    if (err.message && err.message.includes('No se encontró')) {
      throw err;
    }
    throw new Error(`Error al procesar el archivo PFX/P12: Contraseña incorrecta o formato inválido (${err.message})`);
  }
}

/**
 * Carga directamente un par de clave privada y certificado ya convertidos a PEM.
 */
export function loadCertificateFromPem(privateKeyPem: string, certificatePem: string): CertificateData {
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error('La clave privada no contiene el encabezado PEM válido (PRIVATE KEY).');
  }
  if (!certificatePem.includes('CERTIFICATE')) {
    throw new Error('El certificado no contiene el encabezado PEM válido (CERTIFICATE).');
  }

  let certObj: forge.pki.Certificate | null = null;
  try {
    certObj = forge.pki.certificateFromPem(certificatePem);
  } catch {
    // Si no se puede parsear metadatos opcionales, igual dejamos pasar los PEM
  }

  const subjectAttrs = certObj?.subject?.attributes?.map((a: any) => `${a.shortName || a.name}=${a.value}`).join(', ');
  const issuerAttrs = certObj?.issuer?.attributes?.map((a: any) => `${a.shortName || a.name}=${a.value}`).join(', ');

  return {
    privateKeyPem,
    certificatePem,
    subject: subjectAttrs,
    issuer: issuerAttrs,
    serialNumber: certObj?.serialNumber,
    validFrom: certObj?.validity?.notBefore,
    validTo: certObj?.validity?.notAfter,
  };
}

/**
 * Genera un certificado autofirmado en memoria para pruebas de desarrollo sin depender de archivos externos.
 */
export function generateSelfSignedCertificate(commonName = 'CERTIFICADO DE PRUEBA SUNAT', password = 'sunat'): {
  pfxBuffer: Buffer;
  password: string;
  certData: CertificateData;
} {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'organizationName', value: 'EMPRESA DE PRUEBA SUNAT' },
    { name: 'countryName', value: 'PE' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const pfxBuffer = Buffer.from(p12Der, 'binary');

  const certData: CertificateData = {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    subject: `CN=${commonName}`,
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };

  return {
    pfxBuffer,
    password,
    certData,
  };
}
