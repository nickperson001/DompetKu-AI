-- ════════════════════════════════════════════════════════════
-- DompetKu Migration v2.1 — IDEMPOTENT & SAFE
-- Bisa dijalankan berulang tanpa error
-- ════════════════════════════════════════════════════════════

-- ── USERS PATCH ─────────────────────────────────────────────
ALTER TABLE IF EXISTS users
    ADD COLUMN IF NOT EXISTS upgrade_package TEXT,
    ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS upgrade_notified BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_upgrading BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'users_status_check'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT users_status_check;
    END IF;

    ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK (status IN ('demo', 'pro', 'unlimited'));
END $$;

-- ── WA SESSION ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_sessions (
    id TEXT PRIMARY KEY DEFAULT 'main',
    data TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── ACTIVITY LOGS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT,
    action TEXT,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── UPGRADES PATCH ─────────────────────────────────────────
ALTER TABLE IF EXISTS upgrades
    ADD COLUMN IF NOT EXISTS package TEXT DEFAULT 'pro';

-- ── SETTINGS UPSERT ────────────────────────────────────────
INSERT INTO settings (key, value) VALUES
    ('maintenance_mode', 'false'),
    ('maintenance_message', '🔧 Bot Sedang Perbaikan. Harap tunggu sebentar. 🙏'),
    ('broadcast_pending', 'null'),
    ('broadcast_last_result', 'null')
ON CONFLICT (key) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- INVENTORY SYSTEM
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS products (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT DEFAULT 'Umum',
    unit TEXT NOT NULL DEFAULT 'pcs',
    price_buy NUMERIC(15,2) DEFAULT 0,
    price_sell NUMERIC(15,2) DEFAULT 0,
    stock_current NUMERIC(15,3) DEFAULT 0,
    stock_min NUMERIC(15,3) DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT products_user_sku_unique UNIQUE (user_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('in','out','adjustment')),
    quantity NUMERIC(15,3) NOT NULL,
    stock_before NUMERIC(15,3) NOT NULL,
    stock_after NUMERIC(15,3) NOT NULL,
    reference_type TEXT,
    reference_id BIGINT,
    note TEXT,
    created_by TEXT DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_alerts (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL,
    stock_level NUMERIC(15,3) NOT NULL,
    alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- ════════════════════════════════════════════════════════════
-- ANTI LOOP
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS scheduler_locks (
    job_name TEXT PRIMARY KEY,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by TEXT,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS message_processed (
    message_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════════════════
-- INDEXES
-- ════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_trx_user_date ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_notif ON users(status, upgrade_notified);
CREATE INDEX IF NOT EXISTS idx_activity_uid ON activity_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(user_id, sku);
CREATE INDEX IF NOT EXISTS idx_stock_mov_product ON stock_movements(product_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_mov_user ON stock_movements(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_prod ON stock_alerts(product_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_msg_processed_time ON message_processed(processed_at);

-- ════════════════════════════════════════════════════════════
-- REALTIME SAFE
-- ════════════════════════════════════════════════════════════
DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE users;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE settings;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE products;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE stock_movements;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
END $$;

-- ════════════════════════════════════════════════════════════
-- FUNCTIONS (DROP + CREATE = CLEAN)
-- ════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.update_updated_at() CASCADE;

CREATE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── CLEANUP FUNCTIONS ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_processed_messages()
RETURNS void AS $$
BEGIN
    DELETE FROM message_processed
    WHERE processed_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.cleanup_expired_locks()
RETURNS void AS $$
BEGIN
    DELETE FROM scheduler_locks
    WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- ── STOCK ATOMIC (DROP FIRST) ──────────────────────────────
DROP FUNCTION IF EXISTS public.adjust_stock_atomic(
    BIGINT, TEXT, TEXT, NUMERIC, TEXT, TEXT
);

CREATE FUNCTION public.adjust_stock_atomic(
    p_product_id BIGINT,
    p_user_id TEXT,
    p_type TEXT,
    p_quantity NUMERIC,
    p_reference_type TEXT DEFAULT 'manual',
    p_note TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    v_product products%ROWTYPE;
    v_stock_before NUMERIC(15,3);
    v_stock_after NUMERIC(15,3);
BEGIN
    SELECT * INTO v_product
    FROM products
    WHERE id = p_product_id
      AND user_id = p_user_id
      AND is_active = true
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'Produk tidak ditemukan');
    END IF;

    v_stock_before := COALESCE(v_product.stock_current, 0);

    IF p_type = 'in' THEN
        v_stock_after := v_stock_before + ABS(p_quantity);
    ELSIF p_type = 'out' THEN
        v_stock_after := v_stock_before - ABS(p_quantity);
        IF v_stock_after < 0 THEN
            RETURN json_build_object('success', false, 'error', 'Stock tidak cukup');
        END IF;
    ELSIF p_type = 'adjustment' THEN
        v_stock_after := p_quantity;
    ELSE
        RETURN json_build_object('success', false, 'error', 'Tipe tidak valid');
    END IF;

    UPDATE products
    SET stock_current = v_stock_after, updated_at = NOW()
    WHERE id = p_product_id;

    INSERT INTO stock_movements (
        user_id, product_id, type, quantity,
        stock_before, stock_after, reference_type, note
    ) VALUES (
        p_user_id, p_product_id, p_type, ABS(p_quantity),
        v_stock_before, v_stock_after,
        p_reference_type, p_note
    );

    RETURN json_build_object('success', true, 'stock_after', v_stock_after);
END;
$$;

GRANT EXECUTE ON FUNCTION public.adjust_stock_atomic(
    BIGINT, TEXT, TEXT, NUMERIC, TEXT, TEXT
) TO service_role, authenticated;

-- ── LOCK FUNCTION ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.try_acquire_lock(TEXT, TEXT, BIGINT);

CREATE FUNCTION public.try_acquire_lock(
    p_job_name TEXT,
    p_locked_by TEXT,
    p_duration_ms BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_expires_at TIMESTAMPTZ;
BEGIN
    v_expires_at := NOW() + (p_duration_ms || ' milliseconds')::INTERVAL;

    DELETE FROM scheduler_locks
    WHERE job_name = p_job_name
      AND expires_at < NOW();

    BEGIN
        INSERT INTO scheduler_locks (job_name, locked_at, locked_by, expires_at)
        VALUES (p_job_name, NOW(), p_locked_by, v_expires_at);
        RETURN true;
    EXCEPTION WHEN unique_violation THEN
        RETURN false;
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.try_acquire_lock(
    TEXT, TEXT, BIGINT
) TO service_role;

-- ════════════════════════════════════════════════════════════
-- DATA FIX
-- ════════════════════════════════════════════════════════════
UPDATE users
SET upgrade_notified = true
WHERE status IN ('pro','unlimited')
  AND upgrade_notified = false;

-- ════════════════════════════════════════════════════════════
-- DONE
-- ════════════════════════════════════════════════════════════