-- Datos ficticios para comprobar la vista previa de cierre anual en local.
-- Aplicar con `supabase db query --file supabase/fixtures/annual-close-demo.sql`.
-- No usar como datos contables reales ni ejecutar contra un proyecto alojado.

DO $annual_close_demo$
BEGIN

INSERT INTO private.accounting_fiscal_years (company_id, fiscal_year)
VALUES ('local-demo', '2025')
ON CONFLICT (company_id, fiscal_year) DO NOTHING;

INSERT INTO private.accounting_journal_entries (
    id, company_id, accounting_period, entry_number, entry_date, glosa,
    currency, total_debit, total_credit, is_balanced, status, is_opening,
    is_closing, origin_document
)
VALUES (
    'demo-annual-close-2025-001', 'local-demo', '2025-12', 1,
    DATE '2025-12-15', 'Registro ficticio de venta para probar el cierre anual',
    'PEN', 1000.00, 1000.00, TRUE, 'POSTED', FALSE, FALSE,
    '{"type":"OTHER","documentId":"LOCAL-DEMO-2025-001"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO private.accounting_journal_entry_lines (
    entry_id, line_number, account_code, account_name, debit, credit, glosa
)
VALUES
    ('demo-annual-close-2025-001', 1, '1041', 'Cuentas corrientes operativas',
     1000.00, 0.00, 'Cobro ficticio de venta'),
    ('demo-annual-close-2025-001', 2, '7011', 'Mercaderías',
     0.00, 1000.00, 'Venta ficticia de mercaderías')
ON CONFLICT (entry_id, line_number) DO NOTHING;

INSERT INTO private.accounting_periods (
    company_id, period, status, total_entries, total_debit, total_credit,
    is_balanced, closed_at, closed_by, closing_notes
)
VALUES (
    'local-demo', '2025-12', 'CLOSED', 1, 1000.00, 1000.00,
    TRUE, TIMESTAMPTZ '2025-12-31 23:59:00+00', 'FIXTURE_LOCAL',
    'Periodo ficticio cerrado para prueba local del cierre anual'
)
ON CONFLICT (company_id, period) DO UPDATE SET
    status = EXCLUDED.status,
    total_entries = EXCLUDED.total_entries,
    total_debit = EXCLUDED.total_debit,
    total_credit = EXCLUDED.total_credit,
    is_balanced = EXCLUDED.is_balanced,
    closed_at = EXCLUDED.closed_at,
    closed_by = EXCLUDED.closed_by,
    closing_notes = EXCLUDED.closing_notes;

END
$annual_close_demo$;
