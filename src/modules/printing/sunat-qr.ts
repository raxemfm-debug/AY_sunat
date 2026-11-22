import type { CompanyBranding, LogoConfig, PrintableCpe, PrintOptions } from './types.js';
import { resolveAndValidateLogo } from './branding-validator.js';

const DOC_TYPE_LABEL: Record<PrintableCpe['type'], string> = {
  '01': 'FACTURA ELECTRÓNICA',
  '03': 'BOLETA DE VENTA ELECTRÓNICA',
  '07': 'NOTA DE CRÉDITO ELECTRÓNICA',
};

export function documentTypeLabel(type: PrintableCpe['type']): string {
  return DOC_TYPE_LABEL[type];
}

export function buildSunatQrPayload(cpe: PrintableCpe): string {
  if (cpe.qrPayload?.trim()) return cpe.qrPayload.trim();
  if (!cpe.hashCpe?.trim()) throw new Error('hashCpe es obligatorio para el QR.');
  const fields = [
    cpe.issuer.ruc,
    cpe.type,
    cpe.series,
    cpe.number,
    money(cpe.totals.igv),
    money(cpe.totals.total),
    cpe.issueDate,
    cpe.customer.documentType,
    cpe.customer.documentNumber,
    cpe.hashCpe,
  ];
  if (fields.some((field) => !String(field).trim())) {
    throw new Error('Faltan datos requeridos para construir el QR tributario.');
  }
  return fields.join('|') + '|';
}

export function money(value: number, currency: PrintableCpe['totals']['currency']): string;
export function money(value: number): string;
export function money(value: number, currency?: PrintableCpe['totals']['currency']): string {
  if (!Number.isFinite(value)) throw new Error('Importe inválido para impresión.');
  return `${currency === 'USD' ? 'US$' : currency === 'PEN' ? 'S/' : ''} ${value.toFixed(2)}`.trim();
}

export function mergeBranding(cpe: PrintableCpe, options?: PrintOptions): CompanyBranding {
  const base = cpe.branding || {};
  const override = options?.branding || {};
  return {
    ...base,
    ...override,
    tradeName: override.tradeName ?? base.tradeName ?? cpe.issuer.tradeName,
    commercialAddress: override.commercialAddress ?? base.commercialAddress ?? cpe.issuer.address,
    phone: override.phone ?? base.phone ?? cpe.issuer.phone,
    email: override.email ?? base.email ?? cpe.issuer.email,
    bankAccounts: override.bankAccounts ?? base.bankAccounts,
  };
}

export function resolveLogoBuffer(logoSource: LogoConfig | string | Buffer | undefined): Buffer | null {
  return resolveAndValidateLogo(logoSource).buffer;
}
