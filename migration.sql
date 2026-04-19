-- ════════════════════════════════════════════════════════════
-- DompetKu Migration v2.0 — SAFE MIGRATION
-- Hanya menambah kolom/tabel baru, TIDAK HAPUS data existing
-- ════════════════════════════════════════════════════════════

-- ── Fix kolom users yang mungkin belum ada ──────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS upgrade_package TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upgrade_notified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_upgrading BOOLEAN NOT NULL DEFAULT false;

-- Update constraint status
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('demo', 'pro', 'unlimited'));

-- ── WA Session backup ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_sessions (
    id         TEXT PRIMARY KEY DEFAULT 'main',
    data       TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Activity logs (non-fatal, opsional) ─────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT,
    action     TEXT,
    details    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Upgrades (jika belum ada kolom package) ─────────────────
ALTER TABLE upgrades ADD COLUMN IF NOT EXISTS package TEXT DEFAULT 'pro';

-- ── Settings (hanya insert jika belum ada) ──────────────────
INSERT INTO settings (key, value) VALUES
    ('maintenance_mode',      'false'),
    ('maintenance_message',   '🔧 Bot Sedang Perbaikan. Harap tunggu sebentar. 🙏'),
    ('broadcast_pending',     'null'),
    ('broadcast_last_result', 'null')
ON CONFLICT (key) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- STOCK OPNAME SYSTEM
-- ════════════════════════════════════════════════════════════

-- Products / Inventory
CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    sku             TEXT NOT NULL,
    name            TEXT NOT NULL,
    category        TEXT DEFAULT 'Umum',
    unit            TEXT NOT NULL DEFAULT 'pcs',
    price_buy       NUMERIC(15,2) DEFAULT 0,
    price_sell      NUMERIC(15,2) DEFAULT 0,
    stock_current   NUMERIC(15,3) DEFAULT 0,
    stock_min       NUMERIC(15,3) DEFAULT 0,
    description     TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT products_user_sku_unique UNIQUE (user_id, sku)
);

-- Stock movements (IN/OUT/ADJUSTMENT tracking)
CREATE TABLE IF NOT EXISTS stock_movements (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type            TEXT NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
    quantity        NUMERIC(15,3) NOT NULL,
    stock_before    NUMERIC(15,3) NOT NULL,
    stock_after     NUMERIC(15,3) NOT NULL,
    reference_type  TEXT,
    reference_id    BIGINT,
    note            TEXT,
    created_by      TEXT DEFAULT 'system',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stock alerts (low/out of stock)
CREATE TABLE IF NOT EXISTS stock_alerts (
    id              BIGSERIAL PRIMARY KEY,
    user_id         TEXT NOT NULL,
    product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alert_type      TEXT NOT NULL,
    stock_level     NUMERIC(15,3) NOT NULL,
    alerted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════
-- ANTI-LOOP SYSTEM
-- ════════════════════════════════════════════════════════════

-- Scheduler locks (prevent double execution)
CREATE TABLE IF NOT EXISTS scheduler_locks (
    job_name       TEXT PRIMARY KEY,
    locked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by      TEXT,
    expires_at     TIMESTAMPTZ NOT NULL
);

-- Message deduplication (prevent infinite loop)
CREATE TABLE IF NOT EXISTS message_processed (
    message_id     TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    processed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- INDEXES (Performance)
-- ════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_trx_user_date ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_notif   ON users(status, upgrade_notified);
CREATE INDEX IF NOT EXISTS idx_activity_uid  ON activity_logs(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_products_user     ON products(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_sku      ON products(user_id, sku);
CREATE INDEX IF NOT EXISTS idx_stock_mov_product ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_mov_user    ON stock_movements(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_prod ON stock_alerts(product_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_msg_processed_time ON message_processed(processed_at);

-- ════════════════════════════════════════════════════════════
-- REALTIME (jika belum enabled)
-- ════════════════════════════════════════════════════════════
DO $$ 
BEGIN
    -- Enable realtime for tables
    PERFORM pg_catalog.set_config('search_path', 'public', false);
    
    -- Add tables to publication if not already added
    -- Note: This may error if already exists, that's OK
    ALTER PUBLICATION supabase_realtime ADD TABLE users;
    ALTER PUBLICATION supabase_realtime ADD TABLE settings;
    ALTER PUBLICATION supabase_realtime ADD TABLE products;
    ALTER PUBLICATION supabase_realtime ADD TABLE stock_movements;
EXCEPTION
    WHEN OTHERS THEN NULL; -- Ignore errors
END $$;

-- ════════════════════════════════════════════════════════════
-- FUNCTIONS & TRIGGERS
-- ════════════════════════════════════════════════════════════

-- Auto update updated_at on products
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Cleanup functions
CREATE OR REPLACE FUNCTION cleanup_processed_messages()
RETURNS void AS $$
BEGIN
    DELETE FROM message_processed 
    WHERE processed_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_expired_locks()
RETURNS void AS $$
BEGIN
    DELETE FROM scheduler_locks 
    WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════
-- FIX EXISTING DATA (agar tidak double notif)
-- ════════════════════════════════════════════════════════════
UPDATE users 
SET upgrade_notified = true
WHERE status IN ('pro','unlimited') 
  AND upgrade_notified = false;

-- ════════════════════════════════════════════════════════════
-- DONE ✅
-- ════════════════════════════════════════════════════════════