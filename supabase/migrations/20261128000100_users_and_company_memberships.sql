-- ============================================================================
-- MIGRACIÓN: USUARIOS Y PERMISOS POR EMPRESA
-- Los roles viven en company_memberships (por empresa), nunca en la tabla de usuarios.
-- Todo queda en el esquema private: solo el servidor (DATABASE_URL) accede.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private.app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(254) NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_app_users_email_normalized CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
    CONSTRAINT chk_app_users_password_hash CHECK (password_hash LIKE 'scrypt$%')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_email ON private.app_users (email);

CREATE TABLE IF NOT EXISTS private.company_memberships (
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES private.app_users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'ACCOUNTANT', 'BILLING', 'VIEWER')),
    granted_by UUID REFERENCES private.app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_memberships_user ON private.company_memberships (user_id);

-- Historial inmutable de altas, cambios de rol y bajas.
CREATE TABLE IF NOT EXISTS private.company_membership_events (
    id BIGSERIAL PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    actor_user_id UUID,
    previous_role VARCHAR(20),
    new_role VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_membership_event_change CHECK (previous_role IS DISTINCT FROM new_role)
);

CREATE INDEX IF NOT EXISTS idx_membership_events_company ON private.company_membership_events (company_id, created_at);

ALTER TABLE private.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.company_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.company_membership_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.app_users,
    private.company_memberships,
    private.company_membership_events
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE private.company_membership_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
