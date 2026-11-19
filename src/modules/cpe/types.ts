import { CpeDocumentCalculationResult, CpeDocumentInput } from '../../core/tax-engine/types.js';

export type CpeLifecycleStatus =
  | 'BORRADOR'
  | 'CALCULADO'
  | 'FIRMADO_XML'
  | 'ENVIADO_SUNAT'
  | 'ACEPTADO'
  | 'ACEPTADO_CON_OBSERVACIONES'
  | 'RECHAZADO'
  | 'DE_BAJA';

export interface CpeRecord {
  id: string;
  companyId: string;
  fullNumber: string; // F001-00000001
  cpeType: string;
  series: string;
  correlative: number;
  issueDate: string;
  currency: 'PEN' | 'USD';
  clientDocType: string;
  clientDocNumber: string;
  clientName: string;
  subTotal: string;
  montoIgv: string;
  totalPagar: string;
  status: CpeLifecycleStatus;
  sunatResponseCode?: string;
  sunatDescription?: string;
  cdrReceivedAt?: string;
  calculationDetails: CpeDocumentCalculationResult;
  createdAt: string;
  updatedAt: string;
}

export interface IssueCpeRequest {
  companyId: string;
  cpeType: '01' | '03' | '07';
  series: string;
  client: CpeDocumentInput['client'];
  items: CpeDocumentInput['items'];
  paymentMethod: 'CONTADO' | 'CREDITO';
  currency?: 'PEN' | 'USD';
  exchangeRate?: number | string;
  globalDiscountAmount?: number | string;
  creditNoteInfo?: CpeDocumentInput['creditNoteInfo'];
}
