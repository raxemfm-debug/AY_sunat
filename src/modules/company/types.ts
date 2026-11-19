import { TaxRegimeCode } from '../../core/tax-engine/types.js';

export interface CompanyAddress {
  ubigeo: string; // 6 dígitos INEI
  department: string;
  province: string;
  district: string;
  urbanization?: string;
  addressLine: string;
}

export interface SolCredentials {
  usuarioSol: string;
  claveSol: string;
}

export interface CertificateConfig {
  certAlias: string;
  hasPrivateKey: boolean;
  expiresAt: string; // ISO date
}

export interface Company {
  id: string; // UUID
  ruc: string; // 11 dígitos, inicia con 10 para persona natural con negocio
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  address: CompanyAddress;
  solCredentials?: SolCredentials;
  certificateConfig?: CertificateConfig;
  isActive: boolean;
  isHabido: boolean; // Condición domiciliaria SUNAT
  createdAt: string;
  updatedAt: string;
}

export type CpeTypeSupported = '01' | '03' | '07';

export interface DocumentSeries {
  id: string;
  companyId: string;
  cpeType: CpeTypeSupported;
  series: string; // F001, B001, FC01, BC01
  currentCorrelative: number;
  isActive: boolean;
  description?: string;
  createdAt: string;
}
