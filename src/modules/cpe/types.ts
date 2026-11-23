import {
  CpeDocumentCalculationResult,
  CpeDocumentInput,
  CurrencyCode,
  ClientProfile,
  ItemCalculationInput,
  CreditNoteSpecificData,
} from "../../core/tax-engine/types.js";
import { CompanyBranding } from "../printing/types.js";
import { CertificateData } from "../signing/types.js";
import { SendBillStatus } from "../sunat-soap/types.js";

export type CpeLifecycleStatus =
  | "BORRADOR"
  | "CALCULADO"
  | "FIRMADO"
  | "FIRMADO_XML"
  | "ENVIADO_SUNAT"
  | "ACEPTADO"
  | "ACEPTADO_CON_OBSERVACIONES"
  | "RECHAZADO"
  | "ERROR_COMUNICACION"
  | "DE_BAJA";

export interface CpeRecord {
  id: string;
  companyId: string;
  fullNumber: string; // F001-00000001
  cpeType: string;
  series: string;
  correlative: number;
  issueDate: string;
  currency: "PEN" | "USD";
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
  cpeType: "01" | "03" | "07";
  series: string;
  client: CpeDocumentInput["client"];
  items: CpeDocumentInput["items"];
  paymentMethod: "CONTADO" | "CREDITO";
  currency?: "PEN" | "USD";
  exchangeRate?: number | string;
  globalDiscountAmount?: number | string;
  creditNoteInfo?: CpeDocumentInput["creditNoteInfo"];
}

export interface EmitCpeRequest {
  companyId: string;
  cpeType: "01" | "03" | "07";
  series: string;
  client: ClientProfile;
  items: ItemCalculationInput[];
  paymentMethod: "CONTADO" | "CREDITO";
  issueDate?: string; // YYYY-MM-DD (default: fecha actual UTC-5 Lima)
  issueTime?: string; // HH:mm:ss
  currency?: CurrencyCode; // default: "PEN"
  exchangeRate?: number | string;
  globalDiscountAmount?: number | string;
  creditNoteInfo?: CreditNoteSpecificData;
}

export interface EmitCpeOptions {
  sendToSunat?: boolean; // default true; en false no invoca SOAP
  validateXsd?: boolean; // default false
  generatePdf?: boolean; // default true (A4)
  generateTicket?: boolean; // default true (80mm)
  branding?: CompanyBranding;
  customFetchFn?: typeof fetch;
  sunatEnvironment?: "beta" | "production";
  certificateData?: CertificateData;
  solCredentials?: {
    usuarioSol: string;
    claveSol: string;
  };
}

export interface EmitCpeResult {
  cpeId: string;
  fullNumber: string;
  status: CpeLifecycleStatus;
  xmlSigned: string;
  hashCpe: string;
  zipBuffer: Buffer;
  zipFileName: string;
  calculation: CpeDocumentCalculationResult;
  sunatResponse?: {
    status: SendBillStatus;
    httpStatusCode: number;
    cdrResponseCode?: string;
    cdrDescription?: string;
    notes?: string[];
    cdrRawXml?: string;
    faultMessage?: string;
  };
  pdfA4?: Buffer;
  ticket80mm?: Buffer;
  qrPayload: string;
}
