'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

if (!url || !key) {
    console.error('\n[ERROR] ❌ SUPABASE_URL dan SUPABASE_KEY wajib diisi di file .env\n');
    process.exit(1);
}
if (!url.startsWith('https://')) {
    console.error('\n[ERROR] ❌ SUPABASE_URL tidak valid. Harus diawali https://\n');
    process.exit(1);
}

const supabase = createClient(url, key, {
    auth    : { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
    db      : { schema: 'public' },
});

console.log('[CONFIG] ✅ Supabase client siap.');
module.exports = supabase;