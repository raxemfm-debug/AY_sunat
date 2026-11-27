import type { PurchaseDocumentRecord, SupplierProfile } from '../../modules/purchases/types.js';

export type PurchaseSireStatus = PurchaseDocumentRecord['sireStatus'];

/** Se lanza cuando el comprobante (mismo CAR) ya existe para la empresa compradora. */
export class DuplicatePurchaseError extends Error {
  constructor(public readonly car: string, fullNumber: string, supplierDocNumber: string) {
    super(
      `El comprobante de compra con CAR ${car} (${fullNumber}) ya está registrado para el proveedor ${supplierDocNumber}.`,
    );
    this.name = 'DuplicatePurchaseError';
  }
}

export interface IPurchaseRepository {
  upsertSupplier(companyRuc: string, supplier: SupplierProfile): Promise<SupplierProfile>;
  getSupplier(companyRuc: string, docNumber: string): Promise<SupplierProfile | null>;
  /** Guarda el comprobante calculado con sus ítems. Lanza DuplicatePurchaseError si el CAR ya existe. */
  save(record: PurchaseDocumentRecord): Promise<PurchaseDocumentRecord>;
  findByCar(companyRuc: string, car: string): Promise<PurchaseDocumentRecord | null>;
  listByPeriod(companyRuc: string, period: string): Promise<PurchaseDocumentRecord[]>;
  updateSireStatus(companyRuc: string, car: string, status: PurchaseSireStatus): Promise<PurchaseDocumentRecord>;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Implementación en memoria: útil para pruebas y desarrollo sin DATABASE_URL. */
export class MemoryPurchaseRepository implements IPurchaseRepository {
  private readonly suppliers = new Map<string, SupplierProfile>();
  private readonly purchases = new Map<string, PurchaseDocumentRecord>();

  async upsertSupplier(companyRuc: string, supplier: SupplierProfile): Promise<SupplierProfile> {
    const record: SupplierProfile = {
      ...supplier,
      id: supplier.id || `prov-${supplier.docNumber}`,
      isHabido: supplier.isHabido ?? true,
      isActive: supplier.isActive ?? true,
    };
    this.suppliers.set(`${companyRuc}:${supplier.docNumber}`, record);
    return clone(record);
  }

  async getSupplier(companyRuc: string, docNumber: string): Promise<SupplierProfile | null> {
    const supplier = this.suppliers.get(`${companyRuc}:${docNumber}`);
    return supplier ? clone(supplier) : null;
  }

  async save(record: PurchaseDocumentRecord): Promise<PurchaseDocumentRecord> {
    const key = `${record.companyRuc}:${record.car}`;
    if (this.purchases.has(key)) {
      throw new DuplicatePurchaseError(record.car, record.fullNumber, record.supplier.docNumber);
    }
    await this.upsertSupplier(record.companyRuc, record.supplier);
    this.purchases.set(key, clone(record));
    return clone(record);
  }

  async findByCar(companyRuc: string, car: string): Promise<PurchaseDocumentRecord | null> {
    const record = this.purchases.get(`${companyRuc}:${car}`);
    return record ? clone(record) : null;
  }

  async listByPeriod(companyRuc: string, period: string): Promise<PurchaseDocumentRecord[]> {
    return Array.from(this.purchases.values())
      .filter((p) => p.companyRuc === companyRuc && p.accountingPeriod === period)
      .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.car.localeCompare(b.car))
      .map(clone);
  }

  async updateSireStatus(companyRuc: string, car: string, status: PurchaseSireStatus): Promise<PurchaseDocumentRecord> {
    const record = this.purchases.get(`${companyRuc}:${car}`);
    if (!record) {
      throw new Error(`Comprobante de compra con CAR ${car} no encontrado.`);
    }
    record.sireStatus = status;
    return clone(record);
  }
}
