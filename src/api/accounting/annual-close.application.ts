import {
  AccountingService,
  AnnualCloseRecord,
  AnnualClosingPreview,
  ExecuteAnnualCloseInput,
  PreviewAnnualCloseInput,
} from "../../modules/accounting/index.js";
import {
  AnnualCloseRepository,
  ConcurrentAnnualCloseError,
} from "./annual-close.repository.js";

export type AnnualClosePreviewResponse = Omit<AnnualClosingPreview, "plannedEntries"> & {
  revision: number;
};

export interface ConfirmAnnualCloseInput extends ExecuteAnnualCloseInput {
  expectedRevision: number;
}

export class AnnualCloseApplicationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnnualCloseApplicationError";
  }
}

export class AnnualCloseApplication {
  constructor(private readonly repository: AnnualCloseRepository) {}

  async preview(input: PreviewAnnualCloseInput): Promise<AnnualClosePreviewResponse> {
    const fiscalYear = String(input.fiscalYear);
    const snapshot = await this.repository.loadSnapshot(input.companyId, fiscalYear);
    if (snapshot.fiscalYearStatus === "CLOSED") {
      throw new AnnualCloseApplicationError(409, "ALREADY_CLOSED", `El ejercicio ${fiscalYear} ya está cerrado.`);
    }
    const accounting = new AccountingService(snapshot.entries, snapshot.periods);

    let preview: AnnualClosingPreview;
    try {
      preview = accounting.previewAnnualClose(input);
    } catch (error) {
      throw this.mapDomainError(error);
    }

    // Internal planned inputs are not part of the HTTP contract.
    const { plannedEntries: _plannedEntries, ...publicPreview } = preview;
    return { ...publicPreview, revision: snapshot.revision };
  }

  async confirm(input: ConfirmAnnualCloseInput): Promise<AnnualCloseRecord> {
    const fiscalYear = String(input.fiscalYear);
    const snapshot = await this.repository.loadSnapshot(input.companyId, fiscalYear);
    if (snapshot.fiscalYearStatus === "CLOSED") {
      throw new AnnualCloseApplicationError(409, "ALREADY_CLOSED", `El ejercicio ${fiscalYear} ya está cerrado.`);
    }
    if (snapshot.revision !== input.expectedRevision) {
      throw new AnnualCloseApplicationError(
        409,
        "STALE_PREVIEW",
        "El libro cambió desde la vista previa; vuelve a generarla antes de confirmar.",
      );
    }

    const accounting = new AccountingService(snapshot.entries, snapshot.periods);
    let record: AnnualCloseRecord;
    try {
      // Rebuild and validate at confirmation time; never trust the browser preview.
      record = accounting.closeFiscalYear(input);
    } catch (error) {
      throw this.mapDomainError(error);
    }

    try {
      await this.repository.commitAnnualClose({
        companyId: input.companyId,
        fiscalYear,
        expectedRevision: snapshot.revision,
        record,
      });
    } catch (error) {
      if (error instanceof ConcurrentAnnualCloseError) {
        throw new AnnualCloseApplicationError(409, "CONCURRENT_CLOSE", error.message);
      }
      throw error;
    }
    return record;
  }

  private mapDomainError(error: unknown): AnnualCloseApplicationError {
    const message = error instanceof Error ? error.message : "Error al procesar el cierre anual.";
    if (/ya se encuentra cerrado/i.test(message)) {
      return new AnnualCloseApplicationError(409, "ALREADY_CLOSED", message);
    }
    if (/formato|debe pertenecer/i.test(message)) {
      return new AnnualCloseApplicationError(400, "INVALID_INPUT", message);
    }
    return new AnnualCloseApplicationError(422, "ANNUAL_CLOSE_REJECTED", message);
  }
}
