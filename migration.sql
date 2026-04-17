-- ════════════════════════════════════════════════════════════
-- DompetKu Migration — Jalankan di Supabase SQL Editor
-- ════════════════════════════════════════════════════════════

-- Tabel users (sudah ada, pastikan kolom lengkap)
ALTER TABLE users ADD COLUMN IF NOT EXISTS upgrade_package TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS upgrade_notified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_upgrading BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('demo', 'pro', 'unlimited'));

-- WA Session (untuk backup session WhatsApp)
CREATE TABLE IF NOT EXISTS wa_sessions (
    id         TEXT PRIMARY KEY DEFAULT 'main',
    data       TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity logs (non-fatal, opsional)
CREATE TABLE IF NOT EXISTS activity_logs (
    id         BIGSERIAL PRIMARY KEY,
    user_id    TEXT,
    action     TEXT,
    details    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upgrades
ALTER TABLE upgrades ADD COLUMN IF NOT EXISTS package TEXT DEFAULT 'pro';

-- Settings
INSERT INTO settings (key, value) VALUES
    ('maintenance_mode',      'false'),
    ('maintenance_message',   '🔧 Bot Sedang Perbaikan. Harap tunggu sebentar. 🙏'),
    ('broadcast_pending',     'null'),
    ('broadcast_last_result', 'null')
ON CONFLICT (key) DO NOTHING;

-- Index performa
CREATE INDEX IF NOT EXISTS idx_trx_user_date ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_status  ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_notif   ON users(status, upgrade_notified);
CREATE INDEX IF NOT EXISTS idx_activity_uid  ON activity_logs(user_id, created_at);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE users;
ALTER PUBLICATION supabase_realtime ADD TABLE settings;

-- Fix user pro yang sudah ada agar tidak double notif
UPDATE users SET upgrade_notified = true
WHERE status IN ('pro','unlimited') AND upgrade_notified = false;
