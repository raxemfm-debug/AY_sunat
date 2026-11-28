import type { Pool } from 'pg';
import { createPostgresPool } from '../api/accounting/postgres-annual-close.repository.js';
import { CompanyRepository, ICompanyRepository } from './repositories/company.repository.js';
import { CpeRepository, ICpeRepository } from './repositories/cpe.repository.js';
import { IPurchaseRepository, MemoryPurchaseRepository } from './repositories/purchase.repository.js';
import {
  IAccountingLedgerRepository,
  MemoryAccountingLedgerRepository,
} from './repositories/accounting-ledger.repository.js';
import { PostgresCompanyRepository } from './postgres/postgres-company.repository.js';
import { PostgresCpeRepository } from './postgres/postgres-cpe.repository.js';
import { PostgresPurchaseRepository } from './postgres/postgres-purchase.repository.js';
import { PostgresAccountingLedgerRepository } from './postgres/postgres-accounting-ledger.repository.js';
import { IUserRepository, MemoryUserRepository } from './repositories/user.repository.js';
import { PostgresUserRepository } from './postgres/postgres-user.repository.js';
import { ISessionRepository, MemorySessionRepository } from './repositories/session.repository.js';
import { PostgresSessionRepository } from './postgres/postgres-session.repository.js';

export interface Persistence {
  kind: 'postgres' | 'memory';
  pool?: Pool;
  companies: ICompanyRepository;
  cpe: ICpeRepository;
  purchases: IPurchaseRepository;
  ledger: IAccountingLedgerRepository;
  users: IUserRepository;
  sessions: ISessionRepository;
  close(): Promise<void>;
}

export interface PersistenceOptions {
  /** Cadena de conexión de servidor (DATABASE_URL). Nunca debe llegar al navegador. */
  databaseUrl?: string;
  /** Pool existente; tiene prioridad sobre databaseUrl y no se cierra con close(). */
  pool?: Pool;
  /** Permite memoria cuando falta DATABASE_URL. Por defecto: true salvo en producción. */
  allowMemory?: boolean;
}

/** Crea todos los repositorios sobre PostgreSQL o, solo si se permite, en memoria. */
export function createPersistence(options: PersistenceOptions = {}): Persistence {
  if (options.pool) {
    return postgresPersistence(options.pool, async () => undefined);
  }
  const databaseUrl = options.databaseUrl?.trim();
  if (databaseUrl) {
    const pool = createPostgresPool(databaseUrl);
    return postgresPersistence(pool, () => pool.end());
  }

  const allowMemory = options.allowMemory ?? process.env.NODE_ENV !== 'production';
  if (!allowMemory) {
    throw new Error('DATABASE_URL es obligatoria en producción; no se permite iniciar con almacenamiento en memoria.');
  }
  const companies = new CompanyRepository();
  return {
    kind: 'memory',
    companies,
    cpe: new CpeRepository(),
    purchases: new MemoryPurchaseRepository(),
    ledger: new MemoryAccountingLedgerRepository(),
    users: new MemoryUserRepository(async (id) => (await companies.findById(id)) !== null),
    sessions: new MemorySessionRepository(),
    close: async () => undefined,
  };
}

function postgresPersistence(pool: Pool, close: () => Promise<void>): Persistence {
  return {
    kind: 'postgres',
    pool,
    companies: new PostgresCompanyRepository(pool),
    cpe: new PostgresCpeRepository(pool),
    purchases: new PostgresPurchaseRepository(pool),
    ledger: new PostgresAccountingLedgerRepository(pool),
    users: new PostgresUserRepository(pool),
    sessions: new PostgresSessionRepository(pool),
    close,
  };
}
