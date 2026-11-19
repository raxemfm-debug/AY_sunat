export interface AuditLogEntry {
  id: string;
  companyId: string;
  action: 'EMISION_CPE' | 'ANULACION_CPE' | 'CAMBIO_CONFIGURACION' | 'CONSULTA_SUNAT';
  entityType: 'CPE' | 'SERIES' | 'COMPANY' | 'TAX_CONFIG';
  entityId: string;
  payloadHash?: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export class AuditLogger {
  private logs: AuditLogEntry[] = [];

  public log(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const record: AuditLogEntry = {
      ...entry,
      id: `aud_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    this.logs.push(record);
    return record;
  }

  public getLogsByCompany(companyId: string): AuditLogEntry[] {
    return this.logs.filter((l) => l.companyId === companyId);
  }
}
