-- ============================================================================
-- MIGRACIÓN 001: ARQUITECTURA BASE PARA GESTIÓN EMPRESARIAL Y CPE (SUNAT PERÚ)
-- Diseñado para PostgreSQL 14+ / Supabase con Row Level Security (RLS)
-- Tipos monetarios: NUMERIC(14, 2) | Cantidades: NUMERIC(16, 4)
-- ============================================================================

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. TABLA: EMPRESAS / CONTRIBUYENTES
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ruc VARCHAR(11) NOT NULL UNIQUE,
    legal_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    tax_regime VARCHAR(10) NOT NULL CHECK (tax_regime IN ('RMT', 'RER', 'RG', 'NRUS')),
    ubigeo VARCHAR(6) NOT NULL,
    department VARCHAR(100) NOT NULL,
    province VARCHAR(100) NOT NULL,
    district VARCHAR(100) NOT NULL,
    address_line TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_habido BOOLEAN NOT NULL DEFAULT true,
    sol_user_encrypted TEXT,
    sol_pass_encrypted TEXT,
    cert_alias VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ruc_format CHECK (ruc ~ '^[0-9]{11}$')
);

CREATE INDEX IF NOT EXISTS idx_companies_ruc ON companies(ruc);

-- 2. TABLA: SERIES DE COMPROBANTES AUTORIZADAS
CREATE TABLE IF NOT EXISTS document_series (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    cpe_type VARCHAR(2) NOT NULL CHECK (cpe_type IN ('01', '03', '07', '08', '09')),
    series VARCHAR(4) NOT NULL,
    current_correlative INTEGER NOT NULL DEFAULT 0 CHECK (current_correlative >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_cpe_series UNIQUE (company_id, cpe_type, series)
);

CREATE INDEX IF NOT EXISTS idx_series_company ON document_series(company_id);

-- 3. TABLA: CABECERA DE COMPROBANTES DE PAGO ELECTRÓNICOS (CPE)
CREATE TABLE IF NOT EXISTS cpe_documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    cpe_type VARCHAR(2) NOT NULL,
    series VARCHAR(4) NOT NULL,
    correlative INTEGER NOT NULL,
    full_number VARCHAR(13) NOT NULL, -- Ej: F001-00000001
    issue_date DATE NOT NULL,
    issue_time TIME NOT NULL DEFAULT '00:00:00',
    currency VARCHAR(3) NOT NULL CHECK (currency IN ('PEN', 'USD')),
    exchange_rate NUMERIC(8, 4),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('CONTADO', 'CREDITO')),
    
    -- Datos del Receptor / Cliente
    client_doc_type VARCHAR(2) NOT NULL,
    client_doc_number VARCHAR(15) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    client_address TEXT,
    client_email VARCHAR(255),

    -- Totales y Cuadres Tributarios
    operaciones_gravadas NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    operaciones_exoneradas NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    operaciones_inafectas NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    operaciones_gratuitas NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_descuentos NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    monto_igv NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    subtotal NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_pagar NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_letras TEXT NOT NULL,

    -- Estado de Transmisión SUNAT
    status VARCHAR(30) NOT NULL DEFAULT 'CALCULADO' 
        CHECK (status IN ('BORRADOR', 'CALCULADO', 'FIRMADO_XML', 'ENVIADO_SUNAT', 'ACEPTADO', 'ACEPTADO_CON_OBSERVACIONES', 'RECHAZADO', 'DE_BAJA')),
    sunat_response_code VARCHAR(10),
    sunat_description TEXT,
    xml_hash VARCHAR(100),
    cdr_received_at TIMESTAMPTZ,
    
    raw_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_company_full_number UNIQUE (company_id, full_number)
);

CREATE INDEX IF NOT EXISTS idx_cpe_company_date ON cpe_documents(company_id, issue_date);
CREATE INDEX IF NOT EXISTS idx_cpe_status ON cpe_documents(company_id, status);

-- 4. TABLA: DETALLE DE ITEMS DEL COMPROBANTE
CREATE TABLE IF NOT EXISTS cpe_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    cpe_id UUID NOT NULL REFERENCES cpe_documents(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    item_code VARCHAR(50),
    description TEXT NOT NULL,
    unit_code VARCHAR(10) NOT NULL DEFAULT 'NIU',
    quantity NUMERIC(16, 4) NOT NULL CHECK (quantity > 0),
    unit_value NUMERIC(14, 2) NOT NULL,
    unit_price NUMERIC(14, 2) NOT NULL,
    affectation_type VARCHAR(4) NOT NULL,
    discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    igv_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    total_amount NUMERIC(14, 2) NOT NULL DEFAULT 0.00,
    CONSTRAINT uq_cpe_line UNIQUE (cpe_id, line_number)
);

-- 5. TABLA: BITÁCORA DE AUDITORÍA INMUTABLE
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100) NOT NULL,
    details JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at DESC);

-- ============================================================================
-- POLÍTICAS DE ROW LEVEL SECURITY (RLS)
-- ============================================================================
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpe_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cpe_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
