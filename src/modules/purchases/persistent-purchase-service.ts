import { DuplicatePurchaseError } from '../../database/repositories/purchase.repository.js';
import type { IPurchaseRepository, PurchaseSireStatus } from '../../database/repositories/purchase.repository.js';
import { buildCarCode, PurchaseService } from './purchase-service.js';
import type { MonthlyPurchasesSummary, PurchaseDocumentInput, PurchaseDocumentRecord } from './types.js';

/**
 * Registro de compras con persistencia. Reutiliza PurchaseService para validar y calcular,
 * y delega el almacenamiento (y el bloqueo definitivo de duplicados) al repositorio.
 */
export class PersistentPurchaseService {
  constructor(private readonly repository: IPurchaseRepository) {}

  async registerPurchase(input: PurchaseDocumentInput): Promise<PurchaseDocumentRecord> {
    const car = buildCarCode(input.supplier.docNumber, input.docType, input.series, input.correlative);
    const existing = await this.repository.findByCar(input.companyRuc, car);
    if (existing) {
      throw new DuplicatePurchaseError(car, existing.fullNumber, input.supplier.docNumber);
    }
    // Cálculo puro: una instancia nueva no conserva estado entre llamadas.
    const record = new PurchaseService().registerPurchase(input);
    // La restricción única en base de datos cubre la carrera entre dos registros simultáneos.
    return this.repository.save(record);
  }

  async hasPurchase(
    companyRuc: string,
    supplierDocNumber: string,
    docType: string,
    series: string,
    correlative: number | string,
  ): Promise<boolean> {
    const car = buildCarCode(supplierDocNumber, docType, series, correlative);
    return (await this.repository.findByCar(companyRuc, car)) !== null;
  }

  findByCar(companyRuc: string, car: string): Promise<PurchaseDocumentRecord | null> {
    return this.repository.findByCar(companyRuc, car);
  }

  listByPeriod(companyRuc: string, period: string): Promise<PurchaseDocumentRecord[]> {
    return this.repository.listByPeriod(companyRuc, period);
  }

  updateSireStatus(companyRuc: string, car: string, status: PurchaseSireStatus): Promise<PurchaseDocumentRecord> {
    return this.repository.updateSireStatus(companyRuc, car, status);
  }

  async getMonthlySummary(companyRuc: string, period: string): Promise<MonthlyPurchasesSummary> {
    const service = new PurchaseService();
    service.loadRecords(await this.repository.listByPeriod(companyRuc, period));
    return service.getMonthlySummary(period, companyRuc);
  }
}
