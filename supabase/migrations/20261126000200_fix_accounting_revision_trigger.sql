-- ============================================================================
-- CORRECCIÓN: trigger de revisión del ejercicio contable
-- La versión anterior evaluaba NEW.entry_id / NEW.company_id en una sola condición
-- para dos tablas distintas. PL/pgSQL resuelve todos los campos de la expresión, por lo que
-- cualquier INSERT en accounting_journal_entries fallaba con:
--   record "new" has no field "entry_id"
-- Se separa la lógica por tabla para que cada rama solo lea campos que existen.
-- ============================================================================

CREATE OR REPLACE FUNCTION private.bump_accounting_year_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, private
AS $$
DECLARE
    affected_company VARCHAR(64);
    affected_period CHAR(7);
    parent_entry_id VARCHAR(160);
BEGIN
    IF TG_TABLE_NAME = 'accounting_journal_entries' THEN
        IF TG_OP = 'UPDATE' THEN
            IF NEW.company_id IS DISTINCT FROM OLD.company_id
               OR NEW.accounting_period IS DISTINCT FROM OLD.accounting_period THEN
                RAISE EXCEPTION 'Journal entry company and accounting period are immutable';
            END IF;
        END IF;

        IF TG_OP = 'DELETE' THEN
            affected_company := OLD.company_id;
            affected_period := OLD.accounting_period;
        ELSE
            affected_company := NEW.company_id;
            affected_period := NEW.accounting_period;
        END IF;

    ELSIF TG_TABLE_NAME = 'accounting_journal_entry_lines' THEN
        IF TG_OP = 'UPDATE' THEN
            IF NEW.entry_id IS DISTINCT FROM OLD.entry_id THEN
                RAISE EXCEPTION 'Journal entry line parent is immutable';
            END IF;
        END IF;

        IF TG_OP = 'DELETE' THEN
            parent_entry_id := OLD.entry_id;
        ELSE
            parent_entry_id := NEW.entry_id;
        END IF;

        SELECT company_id, accounting_period
          INTO affected_company, affected_period
          FROM private.accounting_journal_entries
         WHERE id = parent_entry_id;
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

REVOKE ALL ON FUNCTION private.bump_accounting_year_revision() FROM PUBLIC, anon, authenticated, service_role;
