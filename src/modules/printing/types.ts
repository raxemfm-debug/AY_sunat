export type PrintableCpeType = '01' | '03' | '07';
export type CurrencyCode = 'PEN' | 'USD';

export interface PrintableIssuer {
  ruc: string;
  legalName: string;
  tradeName?: string;
  address?: string;
  phone?: string;
  email?: string;
}

export interface PrintableCustomer {
  documentType: string;
  documentNumber: string;
  name: string;
  address?: string;
}

/** Amounts come from the tax/CPE engine. This module never recalculates tax. */
export interface PrintableLine {
  quantity: number;
  unitCode: string;
  description: string;
  unitValue: number;
  unitPrice: number;
  lineExtensionAmount: number;
  igvAmount: number;
  totalAmount: number;
}

export interface PrintableTotals {
  taxable: number;
  exempt: number;
  unaffected: number;
  free: number;
  igv: number;
  total: number;
  currency: CurrencyCode;
  amountInWords?: string;
}

export interface ModifiedDocumentReference {
  documentType: string;
  series: string;
  number: string;
  reasonCode: string;
  reasonDescription: string;
}

export interface BankAccountInfo {
  bank: string;
  currency: CurrencyCode;
  accountType?: 'Corriente' | 'Ahorros' | 'Detracciones';
  accountNumber: string;
  cci?: string;
}

export interface LogoConfig {
  /** File path, Base64 data URI / raw base64 string, or binary Buffer */
  source: Buffer | string;
  /** Max width and height for proportional fitting [maxWidth, maxHeight] */
  fit?: [number, number];
  width?: number;
  height?: number;
}

export interface CompanyBranding {
  logo?: LogoConfig | string | Buffer;
  /** Primary corporate color in hex, e.g. '#17365D' */
  primaryColor?: string;
  /** Accent or secondary color in hex, e.g. '#2563EB' */
  accentColor?: string;
  tradeName?: string;
  slogan?: string;
  commercialAddress?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  socialMedia?: string;
  bankAccounts?: BankAccountInfo[];
  commercialFooter?: string;
}

export type SupportedLogoFormat = 'png' | 'jpeg';

export interface SanitizedBranding {
  logo: Buffer | null;
  logoFit: [number, number];
  primaryColor: string;
  accentColor: string;
  tradeName?: string;
  legalName: string;
  slogan?: string;
  commercialAddress?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  website?: string;
  socialMedia?: string;
  bankAccounts: BankAccountInfo[];
  commercialFooter?: string;
}

export interface BrandingValidationResult {
  isValid: boolean;
  warnings: string[];
  sanitized: SanitizedBranding;
}

export interface PrintableCpe {
  type: PrintableCpeType;
  series: string;
  number: string;
  issueDate: string; // YYYY-MM-DD
  issueTime?: string;
  dueDate?: string;
  paymentMethod?: string;
  issuer: PrintableIssuer;
  customer: PrintableCustomer;
  lines: PrintableLine[];
  totals: PrintableTotals;
  /** DigestValue/hash from the signed XML. Do not generate a placeholder. */
  hashCpe: string;
  /** Optional exact QR string from the verified CPE/signing flow. */
  qrPayload?: string;
  /** Required for a credit note (type 07). */
  modifiedDocument?: ModifiedDocumentReference;
  /** Optional company branding and commercial data */
  branding?: CompanyBranding;
}

export type PrintFormat = 'a4' | 'ticket-80mm';

export interface PrintOptions {
  /** Optional branding override at print time */
  branding?: CompanyBranding;
}
