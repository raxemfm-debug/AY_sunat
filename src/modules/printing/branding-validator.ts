import fs from 'node:fs';
import type {
  BankAccountInfo,
  CompanyBranding,
  CurrencyCode,
  LogoConfig,
  PrintableIssuer,
  SupportedLogoFormat,
  SanitizedBranding,
  BrandingValidationResult,
} from './types.js';

export const DEFAULT_PRIMARY_COLOR = '#17365D';
export const DEFAULT_ACCENT_COLOR = '#2563EB';
export const DEFAULT_A4_LOGO_FIT: [number, number] = [110, 58];
export const DEFAULT_TICKET_LOGO_FIT: [number, number] = [90, 40];

const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const PHONE_REGEX = /^[\d\s+\-().]{6,30}$/;
const URL_REGEX = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/i;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Valida y normaliza un color hexadecimal.
 * Si es inválido, devuelve el fallback seguro (#17365D o #2563EB).
 */
export function sanitizeColor(color: unknown, defaultColor: string): { color: string; isFallback: boolean } {
  if (typeof color === 'string') {
    const trimmed = color.trim();
    if (HEX_COLOR_REGEX.test(trimmed)) {
      if (trimmed.length === 4) {
        // Expandir #RGB a #RRGGBB
        const r = trimmed[1];
        const g = trimmed[2];
        const b = trimmed[3];
        return { color: `#${r}${r}${g}${g}${b}${b}`.toUpperCase(), isFallback: false };
      }
      return { color: trimmed.toUpperCase(), isFallback: false };
    }
  }
  return { color: defaultColor.toUpperCase(), isFallback: true };
}

/**
 * Detecta si un buffer corresponde a una imagen PNG o JPEG examinando sus magic bytes.
 */
export function detectLogoFormat(buffer: Buffer): SupportedLogoFormat | null {
  if (!buffer || buffer.length < 4) return null;
  // PNG magic bytes: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'png';
  }
  // JPEG magic bytes: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

/**
 * Valida y resuelve el Buffer de un logo, garantizando formato compatible (PNG o JPEG).
 * Si el formato es inválido, corrupto o inexistente, retorna null y un mensaje de advertencia.
 */
export function resolveAndValidateLogo(
  logoSource: LogoConfig | string | Buffer | undefined
): { buffer: Buffer | null; format: SupportedLogoFormat | null; warning?: string } {
  if (!logoSource) return { buffer: null, format: null };

  let rawBuffer: Buffer | null = null;
  let sourceDesc = 'buffer directo';
  let isFilePath = false;

  if (Buffer.isBuffer(logoSource)) {
    rawBuffer = logoSource;
  } else if (typeof logoSource === 'string') {
    sourceDesc = logoSource.length > 60 ? `${logoSource.slice(0, 30)}...` : logoSource;
    const parsed = parseRawLogoString(logoSource);
    rawBuffer = parsed.buffer;
    isFilePath = parsed.isFilePath;
  } else if (typeof logoSource === 'object' && logoSource !== null && 'source' in logoSource) {
    const src = logoSource.source;
    if (Buffer.isBuffer(src)) {
      rawBuffer = src;
    } else if (typeof src === 'string') {
      sourceDesc = src.length > 60 ? `${src.slice(0, 30)}...` : src;
      const parsed = parseRawLogoString(src);
      rawBuffer = parsed.buffer;
      isFilePath = parsed.isFilePath;
    }
  }

  if (isFilePath && !rawBuffer) {
    return {
      buffer: null,
      format: null,
      warning: `No se pudo leer el archivo de logo en la ruta especificada (${sourceDesc}). Se omitirá el logo de forma segura.`,
    };
  }

  if (!rawBuffer || rawBuffer.length === 0) {
    return {
      buffer: null,
      format: null,
      warning: `No se pudo leer la fuente del logo (${sourceDesc}). Se omitirá el logo de forma segura.`,
    };
  }

  const format = detectLogoFormat(rawBuffer);
  if (!format) {
    return {
      buffer: null,
      format: null,
      warning: `Formato de imagen no soportado para el logo (${sourceDesc}). Se requiere PNG o JPEG. Se omitirá el logo.`,
    };
  }

  return { buffer: rawBuffer, format };
}

function parseRawLogoString(str: string): { buffer: Buffer | null; isFilePath: boolean } {
  const trimmed = str.trim();

  // XML/SVG como contenido directo: se marca como formato no soportado, nunca se interpreta como ruta.
  if (trimmed.startsWith('<')) return { buffer: Buffer.from(trimmed, 'utf8'), isFilePath: false };

  // 1. Data URI: data:image/...;base64,...
  if (trimmed.startsWith('data:image/')) {
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex !== -1) {
      try {
        return { buffer: Buffer.from(trimmed.slice(commaIndex + 1), 'base64'), isFilePath: false };
      } catch {
        return { buffer: null, isFilePath: false };
      }
    }
  }

  // 2. Ruta de archivo en disco
  const looksLikePath = !trimmed.startsWith('<') && (trimmed.includes('/') || trimmed.includes('\\') || /\.(png|jpe?g|webp|svg|gif|bmp)$/i.test(trimmed));
  if (looksLikePath) {
    try {
      if (fs.existsSync(trimmed)) {
        return { buffer: fs.readFileSync(trimmed), isFilePath: true };
      }
    } catch {
      // error leyendo archivo
    }
    return { buffer: null, isFilePath: true };
  }

  // 3. Cadena Base64 directa
  if (trimmed.length >= 16 && BASE64_REGEX.test(trimmed.replace(/\s+/g, ''))) {
    try {
      const decoded = Buffer.from(trimmed, 'base64');
      if (decoded.length > 4) {
        return { buffer: decoded, isFilePath: false };
      }
    } catch {
      // not base64
    }
  }

  return { buffer: null, isFilePath: false };
}

/**
 * Valida dimensiones de ajuste del logo [ancho, alto].
 */
export function sanitizeLogoFit(
  fit: unknown,
  defaultFit: [number, number] = DEFAULT_A4_LOGO_FIT
): [number, number] {
  if (Array.isArray(fit) && fit.length >= 2) {
    const w = Number(fit[0]);
    const h = Number(fit[1]);
    if (Number.isFinite(w) && w > 0 && w <= 500 && Number.isFinite(h) && h > 0 && h <= 500) {
      return [Math.round(w), Math.round(h)];
    }
  }
  return defaultFit;
}

/**
 * Valida y depura una cuenta bancaria comercial.
 * Si faltan datos críticos (banco o número), retorna null.
 */
export function sanitizeBankAccount(account: unknown): BankAccountInfo | null {
  if (!account || typeof account !== 'object') return null;
  const acc = account as Partial<BankAccountInfo>;
  const bank = typeof acc.bank === 'string' ? acc.bank.trim() : '';
  const accountNumber = typeof acc.accountNumber === 'string' ? acc.accountNumber.trim() : '';
  if (!bank || !accountNumber) return null;

  const currency: CurrencyCode = acc.currency === 'USD' ? 'USD' : 'PEN';
  let accountType: BankAccountInfo['accountType'] | undefined = undefined;
  if (acc.accountType && ['Corriente', 'Ahorros', 'Detracciones'].includes(acc.accountType)) {
    accountType = acc.accountType;
  }

  const cci = typeof acc.cci === 'string' && acc.cci.trim() ? acc.cci.trim() : undefined;

  return {
    bank: bank.slice(0, 50),
    currency,
    accountType,
    accountNumber: accountNumber.slice(0, 50),
    cci: cci ? cci.slice(0, 40) : undefined,
  };
}

/**
 * Valida todos los parámetros de branding, aplicando valores seguros para cualquier opción inválida.
 * Genera advertencias detalladas sin interrumpir la emisión ni el renderizado.
 */
export function validateAndSanitizeBranding(
  branding?: CompanyBranding,
  issuer?: PrintableIssuer
): BrandingValidationResult {
  const warnings: string[] = [];
  const raw = branding || {};

  // 1. Colores corporativos con fallbacks
  const primaryCheck = sanitizeColor(raw.primaryColor, DEFAULT_PRIMARY_COLOR);
  if (primaryCheck.isFallback && raw.primaryColor !== undefined) {
    warnings.push(`primaryColor inválido ("${raw.primaryColor}"). Se usó el valor seguro "${DEFAULT_PRIMARY_COLOR}".`);
  }
  const accentCheck = sanitizeColor(raw.accentColor, DEFAULT_ACCENT_COLOR);
  if (accentCheck.isFallback && raw.accentColor !== undefined) {
    warnings.push(`accentColor inválido ("${raw.accentColor}"). Se usó el valor seguro "${DEFAULT_ACCENT_COLOR}".`);
  }

  // 2. Logo con validación de magic bytes y fit seguro
  const logoCheck = resolveAndValidateLogo(raw.logo);
  if (logoCheck.warning) {
    warnings.push(logoCheck.warning);
  }
  const logoConfig = typeof raw.logo === 'object' && !Buffer.isBuffer(raw.logo) ? raw.logo : undefined;
  const logoFit = sanitizeLogoFit(logoConfig?.fit, DEFAULT_A4_LOGO_FIT);
  if (logoConfig?.fit && (logoFit[0] !== logoConfig.fit[0] || logoFit[1] !== logoConfig.fit[1])) {
    warnings.push(`Dimensiones de logo (fit) inválidas. Se usaron valores seguros [${logoFit[0]}, ${logoFit[1]}].`);
  }

  // 3. Datos comerciales con sanitización y fallbacks
  const cleanStr = (val: unknown, maxLen: number): string | undefined => {
    if (typeof val !== 'string') return undefined;
    const trimmed = val.trim();
    return trimmed ? trimmed.slice(0, maxLen) : undefined;
  };

  const tradeName = cleanStr(raw.tradeName, 150) || cleanStr(issuer?.tradeName, 150);
  const legalName = cleanStr(issuer?.legalName, 200) || 'EMISOR ELECTRÓNICO';
  const slogan = cleanStr(raw.slogan, 200);
  const commercialAddress = cleanStr(raw.commercialAddress, 250) || cleanStr(issuer?.address, 250);

  // Teléfono
  let phone: string | undefined = undefined;
  const rawPhone = cleanStr(raw.phone, 30);
  if (rawPhone) {
    if (PHONE_REGEX.test(rawPhone)) {
      phone = rawPhone;
    } else {
      warnings.push(`phone inválido ("${rawPhone}"). Se omite o se usa el teléfono del emisor.`);
      phone = cleanStr(issuer?.phone, 30);
    }
  } else {
    phone = cleanStr(issuer?.phone, 30);
  }

  // WhatsApp
  let whatsapp: string | undefined = undefined;
  const rawWsp = cleanStr(raw.whatsapp, 30);
  if (rawWsp) {
    if (PHONE_REGEX.test(rawWsp)) {
      whatsapp = rawWsp;
    } else {
      warnings.push(`whatsapp inválido ("${rawWsp}"). Se omite.`);
    }
  }

  // Email
  let email: string | undefined = undefined;
  const rawEmail = cleanStr(raw.email, 100);
  if (rawEmail) {
    if (EMAIL_REGEX.test(rawEmail)) {
      email = rawEmail;
    } else {
      warnings.push(`email comercial inválido ("${rawEmail}"). Se usará el email fiscal del emisor si es válido.`);
      email = issuer?.email && EMAIL_REGEX.test(issuer.email) ? issuer.email : undefined;
    }
  } else {
    email = issuer?.email && EMAIL_REGEX.test(issuer.email) ? issuer.email : undefined;
  }

  // Sitio Web
  let website: string | undefined = undefined;
  const rawWebsite = cleanStr(raw.website, 120);
  if (rawWebsite) {
    if (URL_REGEX.test(rawWebsite)) {
      website = rawWebsite;
    } else {
      warnings.push(`website comercial inválido ("${rawWebsite}"). Se omite.`);
    }
  }

  const socialMedia = cleanStr(raw.socialMedia, 100);
  const commercialFooter = cleanStr(raw.commercialFooter, 350);

  // Cuentas bancarias depuradas
  const bankAccounts: BankAccountInfo[] = [];
  if (Array.isArray(raw.bankAccounts)) {
    raw.bankAccounts.forEach((acc, idx) => {
      const cleanAcc = sanitizeBankAccount(acc);
      if (cleanAcc) {
        bankAccounts.push(cleanAcc);
      } else {
        warnings.push(`Cuenta bancaria #${idx + 1} inválida (falta banco o número de cuenta). Se omite.`);
      }
    });
  }

  const sanitized: SanitizedBranding = {
    logo: logoCheck.buffer,
    logoFit,
    primaryColor: primaryCheck.color,
    accentColor: accentCheck.color,
    tradeName,
    legalName,
    slogan,
    commercialAddress,
    phone,
    whatsapp,
    email,
    website,
    socialMedia,
    bankAccounts,
    commercialFooter,
  };

  return {
    isValid: warnings.length === 0,
    warnings,
    sanitized,
  };
}
