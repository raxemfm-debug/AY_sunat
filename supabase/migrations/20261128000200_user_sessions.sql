-- ============================================================================
-- MIGRACIÓN: SESIONES DE USUARIO
-- El token de sesión nunca se guarda: solo su SHA-256. Quien lea la tabla no
-- puede reutilizar las sesiones. Solo el servidor (DATABASE_URL) accede.
-- ============================================================================

CREATE TABLE IF NOT EXISTS private.user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES private.app_users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    CONSTRAINT chk_user_sessions_token_hash CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_user_sessions_expiry CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_token_hash ON private.user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_active_user ON private.user_sessions (user_id) WHERE revoked_at IS NULL;

ALTER TABLE private.user_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.user_sessions FROM PUBLIC, anon, authenticated, service_role;
