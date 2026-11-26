-- PostgreSQL 14+: persistencia del libro contable y cierres anuales.
-- El adapter de AnnualCloseRepository debe escribir el cierre dentro de una
-- transacción y bloquear accounting_fiscal_years antes de comparar revision.

CREATE SCHEMA IF NOT EXISTS private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS private.accounting_fiscal_years (
    company_id VARCHAR(64) NOT NULL,
    fiscal_year CHAR(4) NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    annual_close_status VARCHAR(10) NOT NULL DEFAULT 'OPEN'
        CHECK (annual_close_status IN ('OPEN', 'CLOSED')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, fiscal_year)
);

CREATE TABLE IF NOT EXISTS private.accounting_periods (
    company_id VARCHAR(64) NOT NULL,
    period CHAR(7) NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    status VARCHAR(10) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
    total_entries INTEGER NOT NULL DEFAULT 0 CHECK (total_entries >= 0),
    total_debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (total_debit >= 0),
    total_credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (total_credit >= 0),
    is_balanced BOOLEAN NOT NULL DEFAULT false,
    closed_at TIMESTAMPTZ,
    closed_by VARCHAR(200),
    closing_notes TEXT,
    trial_balance_snapshot JSONB,
    PRIMARY KEY (company_id, period)
);

CREATE TABLE IF NOT EXISTS private.accounting_journal_entries (
    id VARCHAR(160) PRIMARY KEY,
    company_id VARCHAR(64) NOT NULL,
    accounting_period CHAR(7) NOT NULL CHECK (accounting_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    entry_number INTEGER NOT NULL CHECK (entry_number > 0),
    entry_date DATE NOT NULL,
    glosa TEXT NOT NULL,
    currency CHAR(3) NOT NULL CHECK (currency IN ('PEN', 'USD')),
    exchange_rate NUMERIC(12, 6),
    total_debit NUMERIC(18, 2) NOT NULL CHECK (total_debit >= 0),
    total_credit NUMERIC(18, 2) NOT NULL CHECK (total_credit >= 0),
    is_balanced BOOLEAN NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'POSTED'
        CHECK (status IN ('POSTED', 'PENDING', 'DRAFT')),
    is_opening BOOLEAN NOT NULL DEFAULT false,
    is_closing BOOLEAN NOT NULL DEFAULT false,
    origin_document JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_accounting_entry_number UNIQUE (company_id, accounting_period, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_accounting_entries_company_period
    ON private.accounting_journal_entries(company_id, accounting_period, entry_date);

CREATE TABLE IF NOT EXISTS private.accounting_journal_entry_lines (
    entry_id VARCHAR(160) NOT NULL REFERENCES private.accounting_journal_entries(id) ON DELETE RESTRICT,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    account_code VARCHAR(20) NOT NULL,
    account_name VARCHAR(255) NOT NULL,
    debit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
    credit NUMERIC(18, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
    glosa TEXT NOT NULL,
    cost_center VARCHAR(100),
    reference_doc VARCHAR(255),
    PRIMARY KEY (entry_id, line_number),
    CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE INDEX IF NOT EXISTS idx_accounting_lines_account
    ON private.accounting_journal_entry_lines(account_code, entry_id);

CREATE TABLE IF NOT EXISTS private.accounting_annual_closes (
    company_id VARCHAR(64) NOT NULL,
    fiscal_year CHAR(4) NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),
    status VARCHAR(10) NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
    closed_at TIMESTAMPTZ NOT NULL,
    closed_by VARCHAR(200) NOT NULL,
    closing_notes TEXT,
    net_income NUMERIC(18, 2) NOT NULL,
    net_expense NUMERIC(18, 2) NOT NULL,
    accounting_result NUMERIC(18, 2) NOT NULL,
    result_type VARCHAR(10) NOT NULL CHECK (result_type IN ('PROFIT', 'LOSS', 'ZERO')),
    close_record JSONB NOT NULL,
    PRIMARY KEY (company_id, fiscal_year),
    FOREIGN KEY (company_id, fiscal_year)
        REFERENCES private.accounting_fiscal_years(company_id, fiscal_year) ON DELETE RESTRICT
);

-- Any ledger or monthly-close change advances the year revision, including
-- writes made outside this API, so previews cannot confirm stale data.
CREATE OR REPLACE FUNCTION private.bump_accounting_year_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, private
AS $$
DECLARE
    affected_company VARCHAR(64);
    affected_period CHAR(7);
BEGIN
    IF TG_TABLE_NAME = 'accounting_journal_entries'
       AND TG_OP = 'UPDATE'
       AND (NEW.company_id IS DISTINCT FROM OLD.company_id
            OR NEW.accounting_period IS DISTINCT FROM OLD.accounting_period) THEN
        RAISE EXCEPTION 'Journal entry company and accounting period are immutable';
    END IF;
    IF TG_TABLE_NAME = 'accounting_journal_entry_lines'
       AND TG_OP = 'UPDATE'
       AND NEW.entry_id IS DISTINCT FROM OLD.entry_id THEN
        RAISE EXCEPTION 'Journal entry line parent is immutable';
    END IF;

    IF TG_TABLE_NAME = 'accounting_journal_entry_lines' THEN
        IF TG_OP = 'DELETE' THEN
            SELECT company_id, accounting_period
              INTO affected_company, affected_period
              FROM private.accounting_journal_entries
             WHERE id = OLD.entry_id;
        ELSE
            SELECT company_id, accounting_period
              INTO affected_company, affected_period
              FROM private.accounting_journal_entries
             WHERE id = NEW.entry_id;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        affected_company := OLD.company_id;
        affected_period := OLD.accounting_period;
    ELSE
        affected_company := NEW.company_id;
        affected_period := NEW.accounting_period;
    END IF;

    IF affected_company IS NOT NULL AND affected_period IS NOT NULL THEN
        INSERT INTO private.accounting_fiscal_years (company_id, fiscal_year)
        VALUES (affected_company, left(affected_period, 4))
        ON CONFLICT (company_id, fiscal_year)
        DO UPDATE SET revision = private.accounting_fiscal_years.revision + 1,
                      updated_at = NOW();
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.bump_revision_for_accounting_period()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, private
AS $$
DECLARE
    affected_company VARCHAR(64);
    affected_period CHAR(7);
BEGIN
    IF TG_OP = 'UPDATE'
       AND (NEW.company_id IS DISTINCT FROM OLD.company_id
            OR NEW.period IS DISTINCT FROM OLD.period) THEN
        RAISE EXCEPTION 'Accounting period identity is immutable';
    END IF;

    IF TG_OP = 'DELETE' THEN
        affected_company := OLD.company_id;
        affected_period := OLD.period;
    ELSE
        affected_company := NEW.company_id;
        affected_period := NEW.period;
    END IF;

    INSERT INTO private.accounting_fiscal_years (company_id, fiscal_year)
    VALUES (affected_company, left(affected_period, 4))
    ON CONFLICT (company_id, fiscal_year)
    DO UPDATE SET revision = private.accounting_fiscal_years.revision + 1,
                  updated_at = NOW();
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_accounting_entry_revision
AFTER INSERT OR UPDATE OR DELETE ON private.accounting_journal_entries
FOR EACH ROW EXECUTE FUNCTION private.bump_accounting_year_revision();

CREATE TRIGGER trg_accounting_line_revision
AFTER INSERT OR UPDATE OR DELETE ON private.accounting_journal_entry_lines
FOR EACH ROW EXECUTE FUNCTION private.bump_accounting_year_revision();

CREATE TRIGGER trg_accounting_period_revision
AFTER INSERT OR UPDATE OR DELETE ON private.accounting_periods
FOR EACH ROW EXECUTE FUNCTION private.bump_revision_for_accounting_period();

ALTER TABLE private.accounting_fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.accounting_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.accounting_journal_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.accounting_annual_closes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.accounting_fiscal_years,
    private.accounting_periods,
    private.accounting_journal_entries,
    private.accounting_journal_entry_lines,
    private.accounting_annual_closes
FROM anon, authenticated, service_role;

REVOKE ALL ON FUNCTION private.bump_accounting_year_revision() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.bump_revision_for_accounting_period() FROM PUBLIC, anon, authenticated, service_role;
