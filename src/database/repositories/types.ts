import { TaxRegimeCode } from '../../core/tax-engine/types.js';

export interface CompanyEntity {
  id: string;
  ruc: string;
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  addressLine: string;
  isActive: boolean;
  isHabido: boolean;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSeriesEntity {
  id: string;
  companyId: string;
  cpeType: '01' | '03' | '07' | '08' | '09';
  series: string;
  currentCorrelative: number;
  isActive: boolean;
  description?: string;
  createdAt: string;
}

export type CpeDatabaseStatus =
  | 'BORRADOR'
  | 'CALCULADO'
  | 'FIRMADO_XML'
  | 'ENVIADO_SUNAT'
  | 'ACEPTADO'
  | 'ACEPTADO_CON_OBSERVACIONES'
  | 'RECHAZADO'
  | 'DE_BAJA';

export interface CpeDocumentEntity {
  id: string;
  companyId: string;
  cpeType: string;
  series: string;
  correlative: number;
  fullNumber: string; // ej: F001-00000001
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  currency: 'PEN' | 'USD';
  exchangeRate?: string;
  paymentMethod: 'CONTADO' | 'CREDITO';

  // Datos del cliente / receptor
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  clientAddress?: string;
  clientEmail?: string;

  // Totales
  operacionesGravadas: string;
  operacionesExoneradas: string;
  operacionesInafectas: string;
  operacionesGratuitas: string;
  totalDescuentos: string;
  montoIgv: string;
  subtotal: string;
  totalPagar: string;
  totalLetras: string;

  // Estado SUNAT y trazabilidad
  status: CpeDatabaseStatus;
  sunatResponseCode?: string;
  sunatDescription?: string;
  xmlHash?: string;
  cdrReceivedAt?: string;

  rawPayload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CpeItemEntity {
  id: string;
  cpeId: string;
  lineNumber: number;
  itemCode?: string;
  description: string;
  unitCode: string;
  quantity: string;
  unitValue: string;
  unitPrice: string;
  affectationType: string;
  discountAmount: string;
  igvAmount: string;
  totalAmount: string;
}

export interface CreateCompanyDto {
  ruc: string;
  legalName: string;
  tradeName?: string;
  taxRegime: TaxRegimeCode;
  ubigeo: string;
  department: string;
  province: string;
  district: string;
  addressLine: string;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
}

export interface UpdateCompanyDto {
  legalName?: string;
  tradeName?: string;
  taxRegime?: TaxRegimeCode;
  ubigeo?: string;
  department?: string;
  province?: string;
  district?: string;
  addressLine?: string;
  isActive?: boolean;
  isHabido?: boolean;
  solUserEncrypted?: string;
  solPassEncrypted?: string;
  certAlias?: string;
}

export interface CreateSeriesDto {
  companyId: string;
  cpeType: '01' | '03' | '07' | '08' | '09';
  series: string;
  initialCorrelative?: number;
  description?: string;
}

export interface CreateCpeDocumentDto {
  companyId: string;
  cpeType: string;
  series: string;
  correlative: number;
  fullNumber: string;
  issueDate: string;
  issueTime?: string;
  currency: 'PEN' | 'USD';
  exchangeRate?: string;
  paymentMethod: 'CONTADO' | 'CREDITO';
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  clientAddress?: string;
  clientEmail?: string;
  operacionesGravadas: string;
  operacionesExoneradas?: string;
  operacionesInafectas?: string;
  operacionesGratuitas?: string;
  totalDescuentos?: string;
  montoIgv: string;
  subtotal: string;
  totalPagar: string;
  totalLetras: string;
  status?: CpeDatabaseStatus;
  xmlHash?: string;
  rawPayload: Record<string, unknown>;
}

export interface CreateCpeItemDto {
  lineNumber: number;
  itemCode?: string;
  description: string;
  unitCode?: string;
  quantity: string;
  unitValue: string;
  unitPrice: string;
  affectationType: string;
  discountAmount?: string;
  igvAmount: string;
  totalAmount: string;
}

export interface CpeStatusUpdateDto {
  status: CpeDatabaseStatus;
  sunatResponseCode?: string;
  sunatDescription?: string;
  xmlHash?: string;
  cdrReceivedAt?: string;
}

export interface CpeQueryFilter {
  cpeType?: string;
  series?: string;
  status?: CpeDatabaseStatus;
  startDate?: string;
  endDate?: string;
  clientDocNumber?: string;
  limit?: number;
  offset?: number;
}
