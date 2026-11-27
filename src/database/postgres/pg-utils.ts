import type { Pool, PoolClient, QueryResultRow } from 'pg';

/** Cualquier objeto capaz de ejecutar consultas: Pool o un cliente dentro de una transacción. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Ejecuta `work` dentro de BEGIN/COMMIT y hace ROLLBACK ante cualquier error. */
export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface PgError {
  code?: string;
  constraint?: string;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as PgError;
  return pgError?.code === '23505' && (!constraint || pgError.constraint === constraint);
}

export function isForeignKeyViolation(error: unknown): boolean {
  return (error as PgError)?.code === '23503';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Evita enviar a PostgreSQL identificadores que romperían el cast a UUID. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Expresión SQL que devuelve un TIMESTAMPTZ como texto ISO 8601 en UTC. */
export function isoTimestamp(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);
