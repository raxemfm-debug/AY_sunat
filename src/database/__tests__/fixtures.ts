import type { CreateCompanyDto, CreateCpeDocumentDto, CreateCpeItemDto } from '../repositories/types.js';
import type { PurchaseDocumentInput } from '../../modules/purchases/types.js';
import type { CreateJournalEntryInput } from '../../modules/accounting/types.js';

export const COMPANY_RUC = '10445533811';
export const SUPPLIER_RUC = '20123456786';

export const companyDto = (over: Partial<CreateCompanyDto> = {}): CreateCompanyDto => ({
  ruc: COMPANY_RUC,
  legalName: 'Jose Barrientos Negocios',
  tradeName: 'AYSUNAT',
  taxRegime: 'RMT',
  ubigeo: '150101',
  department: 'LIMA',
  province: 'LIMA',
  district: 'LIMA',
  addressLine: 'Av. Las Begonias 456',
  ...over,
});

export const cpeDto = (companyId: string, over: Partial<CreateCpeDocumentDto> = {}): CreateCpeDocumentDto => ({
  companyId,
  cpeType: '01',
  series: 'F001',
  correlative: 1,
  fullNumber: 'F001-00000001',
  issueDate: '2026-03-05',
  issueTime: '10:15:00',
  currency: 'PEN',
  paymentMethod: 'CONTADO',
  clientDocType: '6',
  clientDocNumber: '20123456789',
  clientName: 'CORPORACION INDUSTRIAL S.A.C.',
  operacionesGravadas: '2000.00',
  montoIgv: '360.00',
  subtotal: '2000.00',
  totalPagar: '2360.00',
  totalLetras: 'DOS MIL TRESCIENTOS SESENTA CON 00/100 SOLES',
  rawPayload: { origen: 'prueba' },
  ...over,
});

export const cpeItems = (): CreateCpeItemDto[] => [
  {
    lineNumber: 1,
    itemCode: 'SERV-001',
    description: 'Servicio de consultoría',
    quantity: '1',
    unitValue: '2000.00',
    unitPrice: '2360.00',
    affectationType: '10',
    igvAmount: '360.00',
    totalAmount: '2360.00',
  },
];

export const purchaseInput = (over: Partial<PurchaseDocumentInput> = {}): PurchaseDocumentInput => ({
  companyRuc: COMPANY_RUC,
  supplier: { docType: '6', docNumber: SUPPLIER_RUC, name: 'PROVEEDOR CENTRAL S.A.C.' },
  docType: '01',
  series: 'F001',
  correlative: 1234,
  issueDate: '2026-03-05',
  accountingPeriod: '2026-03',
  currency: 'PEN',
  paymentMethod: 'CONTADO',
  isBancarizado: true,
  items: [{ description: 'Mercadería', quantity: 10, unitValue: 100, taxDestination: 'GRAVADO_EXCLUSIVO' }],
  ...over,
});

export const saleEntry = (companyId: string, over: Partial<CreateJournalEntryInput> = {}): CreateJournalEntryInput => ({
  companyId,
  accountingPeriod: '2026-03',
  entryDate: '2026-03-05',
  glosa: 'Venta F001-00000001',
  lines: [
    { accountCode: '1212', debit: '1180.00' },
    { accountCode: '40111', credit: '180.00' },
    { accountCode: '70121', credit: '1000.00' },
  ],
  ...over,
});
