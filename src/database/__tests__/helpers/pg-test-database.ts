import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations');

export interface TestDatabase {
  pool: pg.Pool;
  drop(): Promise<void>;
}

/**
 * Crea una base de datos temporal en el servidor de TEST_DATABASE_URL, le aplica todas
 * las migraciones de supabase/migrations y la elimina al terminar. Nunca toca otras bases.
 */
export async function createTestDatabase(adminUrl: string): Promise<TestDatabase> {
  const name = `aysunat_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    // Roles que las migraciones de Supabase referencian en sus REVOKE.
    await admin.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 10 });

  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }

  return {
    pool,
    async drop() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

/** Vacía todas las tablas de datos entre pruebas. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE
    private.user_sessions, private.company_membership_events, private.company_memberships, private.app_users,
    private.purchase_items, private.purchase_documents, private.purchase_suppliers,
    private.accounting_annual_closes, private.accounting_journal_entry_lines,
    private.accounting_journal_entries, private.accounting_periods, private.accounting_fiscal_years,
    cpe_items, cpe_documents, audit_logs, document_series, companies
    RESTART IDENTITY CASCADE`);
}
