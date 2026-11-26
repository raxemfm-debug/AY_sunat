-- ============================================================================
-- MIGRACIÓN: REGISTRO DE COMPRAS (RCE/SIRE) Y AUDITORÍA DE REAPERTURA DE PERÍODOS
-- Esquema private: solo accesible desde el backend (conexión de servidor).
-- Montos: NUMERIC(14, 2) | Cantidades: NUMERIC(16, 4) | Sin FLOAT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private.purchase_suppliers (
    company_ruc CHAR(11) NOT NULL CHECK (company_ruc ~ '^[0-9]{11}$'),
    doc_type VARCHAR(2) NOT NULL,
    doc_number VARCHAR(15) NOT NULL,
    name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    is_habido BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    address TEXT,
    email VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_ruc, doc_number)
);

CREATE TABLE IF NOT EXISTS private.purchase_documents (
    id VARCHAR(100) PRIMARY KEY,
    company_ruc CHAR(11) NOT NULL CHECK (company_ruc ~ '^[0-9]{11}$'),
    car CHAR(27) NOT NULL,
    accounting_period CHAR(7) NOT NULL CHECK (accounting_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    supplier_doc_type VARCHAR(2) NOT NULL,
    supplier_doc_number VARCHAR(15) NOT NULL,
    supplier_name VARCHAR(255) NOT NULL,
    doc_type VARCHAR(2) NOT NULL CHECK (doc_type IN ('01', '03', '07', '08', '50')),
    series VARCHAR(4) NOT NULL,
    correlative VARCHAR(20) NOT NULL,
    full_number VARCHAR(30) NOT NULL,
    issue_date DATE NOT NULL,
    due_date DATE,
    currency CHAR(3) NOT NULL CHECK (currency IN ('PEN', 'USD')),
    exchange_rate NUMERIC(12, 6),
    payment_method VARCHAR(10) NOT NULL CHECK (payment_method IN ('CONTADO', 'CREDITO')),
    is_bancarizado BOOLEAN NOT NULL DEFAULT false,
    detraction JSONB,
    can_use_fiscal_credit BOOLEAN NOT NULL,
    fiscal_credit_restriction_reason TEXT,
    base_gravada_exclusiva NUMERIC(14, 2) NOT NULL DEFAULT 0,
    igv_gravado_exclusivo NUMERIC(14, 2) NOT NULL DEFAULT 0,
    base_gravada_comun NUMERIC(14, 2) NOT NULL DEFAULT 0,
    igv_gravado_comun NUMERIC(14, 2) NOT NULL DEFAULT 0,
    base_gravada_sin_credito NUMERIC(14, 2) NOT NULL DEFAULT 0,
    igv_gravado_sin_credito NUMERIC(14, 2) NOT NULL DEFAULT 0,
    adquisiciones_no_gravadas NUMERIC(14, 2) NOT NULL DEFAULT 0,
    isc NUMERIC(14, 2) NOT NULL DEFAULT 0,
    icbper NUMERIC(14, 2) NOT NULL DEFAULT 0,
    otros_cargos NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total_adquisicion NUMERIC(14, 2) NOT NULL DEFAULT 0,
    total_credito_fiscal NUMERIC(14, 2) NOT NULL DEFAULT 0,
    sire_status VARCHAR(25) NOT NULL DEFAULT 'PROPUESTA_PENDIENTE'
        CHECK (sire_status IN ('PROPUESTA_PENDIENTE', 'ACEPTADO', 'COMPLEMENTADO', 'EXCLUIDO')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- El CAR combina proveedor + tipo + serie + correlativo normalizado:
    -- impide registrar dos veces el mismo comprobante, en cualquier período.
    CONSTRAINT uq_purchase_company_car UNIQUE (company_ruc, car),
    FOREIGN KEY (company_ruc, supplier_doc_number)
        REFERENCES private.purchase_suppliers(company_ruc, doc_number) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_purchase_documents_period
    ON private.purchase_documents(company_ruc, accounting_period);

CREATE TABLE IF NOT EXISTS private.purchase_items (
    purchase_id VARCHAR(100) NOT NULL REFERENCES private.purchase_documents(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL CHECK (line_number > 0),
    item_ref VARCHAR(100),
    description TEXT NOT NULL,
    quantity NUMERIC(16, 4) NOT NULL CHECK (quantity > 0),
    unit_value NUMERIC(16, 4) NOT NULL,
    net_base NUMERIC(14, 2) NOT NULL,
    igv_amount NUMERIC(14, 2) NOT NULL,
    total_amount NUMERIC(14, 2) NOT NULL,
    tax_destination VARCHAR(25) NOT NULL
        CHECK (tax_destination IN ('GRAVADO_EXCLUSIVO', 'GRAVADO_COMUN', 'GRAVADO_SIN_CREDITO', 'NO_GRAVADO')),
    classification CHAR(1) NOT NULL CHECK (classification IN ('1', '2', '3', '4', '5')),
    has_fiscal_credit BOOLEAN NOT NULL,
    PRIMARY KEY (purchase_id, line_number)
);

-- Trazabilidad de reaperturas de períodos contables mensuales.
ALTER TABLE private.accounting_periods ADD COLUMN IF NOT EXISTS reopened_at TIMESTAMPTZ;
ALTER TABLE private.accounting_periods ADD COLUMN IF NOT EXISTS reopened_by VARCHAR(200);
ALTER TABLE private.accounting_periods ADD COLUMN IF NOT EXISTS reopen_reason TEXT;

ALTER TABLE private.purchase_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.purchase_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.purchase_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.purchase_suppliers,
    private.purchase_documents,
    private.purchase_items
FROM PUBLIC, anon, authenticated, service_role;
