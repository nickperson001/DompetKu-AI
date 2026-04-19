'use strict';

const cron         = require('node-cron');
const os           = require('os');
const supabase     = require('../config/supabase');
const stockManager = require('../utils/stockManager');

// ════════════════════════════════════════════════════════════
// INSTANCE ID — unik per proses Railway
// ════════════════════════════════════════════════════════════
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
const activeLocks = new Set(); // In-memory guard (fast path)

// ════════════════════════════════════════════════════════════
// MUTEX LOCK — Gunakan RPC SQL agar atomic & aman multi-instance
// ════════════════════════════════════════════════════════════
async function acquireLock(jobName, durationMinutes = 5) {
    const lockKey = `lock:${jobName}`;

    // Fast path: memory Set
    if (activeLocks.has(lockKey)) {
        console.log(`[LOCK] ${jobName} — locked in memory, skip`);
        return false;
    }

    try {
        const durationMs = durationMinutes * 60 * 1000;

        // Gunakan RPC atomic try_acquire_lock
        const { data, error } = await supabase.rpc('try_acquire_lock', {
            p_job_name   : jobName,
            p_locked_by  : INSTANCE_ID,
            p_duration_ms: durationMs,
        });

        if (error) {
            console.error(`[LOCK] RPC error for ${jobName}:`, error.message);
            return false;
        }

        // data = true jika berhasil acquire, false jika sudah locked
        if (data === true) {
            activeLocks.add(lockKey);
            console.log(`[LOCK] ✅ ${jobName} acquired (${durationMinutes}m) by ${INSTANCE_ID}`);
            return true;
        }

        console.log(`[LOCK] ${jobName} — already locked by another instance`);
        return false;
    } catch (err) {
        console.error(`[LOCK] acquireLock error ${jobName}:`, err.message);
        return false;
    }
}

async function releaseLock(jobName) {
    const lockKey = `lock:${jobName}`;
    activeLocks.delete(lockKey);

    try {
        await supabase
            .from('scheduler_locks')
            .delete()
            .eq('job_name', jobName)
            .eq('locked_by', INSTANCE_ID);

        console.log(`[LOCK] ✅ ${jobName} released`);
    } catch (err) {
        console.error(`[LOCK] releaseLock error ${jobName}:`, err.message);
    }
}

async function executeWithLock(jobName, fn, durationMinutes = 5) {
    const acquired = await acquireLock(jobName, durationMinutes);
    if (!acquired) return;

    try {
        await fn();
    } catch (err) {
        console.error(`[JOB] ${jobName} error:`, err.message);
    } finally {
        await releaseLock(jobName);
    }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
const formatRupiah = (amount) => `Rp ${Number(amount).toLocaleString('id-ID')}`;
const sleep        = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// SEND REPORT
// ════════════════════════════════════════════════════════════
async function sendReport(client, userId, storeName, periodStr, timeFilterIso) {
    try {
        const { data: trans, error } = await supabase
            .from('transactions')
            .select('type, amount')
            .eq('user_id', userId)
            .gte('created_at', timeFilterIso);

        if (error) throw new Error(error.message);
        if (!trans || trans.length === 0) return false;

        let masuk = 0, keluar = 0;
        trans.forEach(t => {
            const v = Number(t.amount) || 0;
            if (t.type === 'masuk') masuk += v; else keluar += v;
        });
        const saldo = masuk - keluar;

        await client.sendMessage(userId,
            `📊 *Laporan ${periodStr}*\n` +
            `🏪 ${storeName}\n` +
            `${'─'.repeat(26)}\n` +
            `🟢 Masuk  : ${formatRupiah(masuk)}\n` +
            `🔴 Keluar : ${formatRupiah(keluar)}\n` +
            `${'─'.repeat(26)}\n` +
            (saldo >= 0
                ? `💰 *Saldo: ${formatRupiah(saldo)}*`
                : `🔴 *Defisit: -${formatRupiah(Math.abs(saldo))}*`) + '\n' +
            `📋 Total ${trans.length} transaksi`
        );
        return true;
    } catch (err) {
        console.error(`[ERROR] sendReport [${userId}]: ${err.message}`);
        return false;
    }
}

// ════════════════════════════════════════════════════════════
// UPGRADE NOTIFICATIONS
// ════════════════════════════════════════════════════════════
async function sendUpgradeNotification(client, userId, storeName, status, expiresAt) {
    try {
        let msg = '';
        if (status === 'unlimited') {
            msg =
                `🎉 *Selamat Bos ${storeName}!*\n\n` +
                `Pembayaran *UNLIMITED* telah diverifikasi admin.\n` +
                `Akun Anda kini *UNLIMITED* 💎 *selamanya*!\n\n` +
                `✅ Yang Anda dapatkan:\n` +
                `   • Transaksi tanpa batas per hari\n` +
                `   • Semua laporan otomatis\n` +
                `   • Stock opname enterprise\n` +
                `   • Tidak perlu perpanjang lagi\n\n` +
                `Terima kasih telah mempercayai kami! 🙏`;
        } else {
            const exp = expiresAt
                ? new Date(expiresAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'long', year: 'numeric' })
                : '—';
            msg =
                `🎉 *Selamat Bos ${storeName}!*\n\n` +
                `Pembayaran *PRO Bulanan* telah diverifikasi admin.\n` +
                `Akun kini *PRO* ⭐ aktif hingga *${exp}*!\n\n` +
                `✅ Yang Anda dapatkan:\n` +
                `   • Transaksi tanpa batas per hari\n` +
                `   • Laporan mingguan & bulanan otomatis\n` +
                `   • Stock opname lengkap\n\n` +
                `Ketik *Paket* untuk perpanjang kapan saja.\n` +
                `Terima kasih! 🙏`;
        }
        await client.sendMessage(userId, msg);
        return true;
    } catch (err) {
        console.error(`[ERROR] sendUpgradeNotification [${userId}]: ${err.message}`);
        return false;
    }
}

async function checkAndNotifyUpgrades(client) {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, store_name, status, subscription_expires_at')
            .in('status', ['pro', 'unlimited'])
            .eq('upgrade_notified', false);

        if (error) { console.error(`[NOTIF] Error: ${error.message}`); return; }
        if (!users || users.length === 0) return;

        for (const u of users) {
            const sent = await sendUpgradeNotification(client, u.id, u.store_name, u.status, u.subscription_expires_at);
            if (sent) {
                await supabase.from('users')
                    .update({ upgrade_notified: true })
                    .eq('id', u.id);
            }
            await sleep(300);
        }
    } catch (err) {
        console.error(`[ERROR] checkAndNotifyUpgrades: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// EXPIRED SUBSCRIPTION CHECKER
// ════════════════════════════════════════════════════════════
async function checkExpiredSubscriptions(client) {
    try {
        const { data: expired, error } = await supabase
            .from('users')
            .select('id, store_name')
            .eq('status', 'pro')
            .lt('subscription_expires_at', new Date().toISOString());

        if (error) { console.error(`[EXPIRY] Error: ${error.message}`); return; }
        if (!expired || expired.length === 0) return;

        console.log(`[CRON] ${expired.length} Pro expired → downgrade ke demo`);

        for (const u of expired) {
            await supabase.from('users')
                .update({ status: 'demo', upgrade_notified: false })
                .eq('id', u.id);

            try {
                await client.sendMessage(u.id,
                    `⚠️ *Langganan PRO Habis — ${u.store_name}*\n\n` +
                    `Akun kembali ke mode *DEMO* (5 transaksi/hari).\n\n` +
                    `Ketik *Paket* untuk perpanjang. 🙏`
                );
            } catch (_) {}
            await sleep(500);
        }
    } catch (err) {
        console.error(`[ERROR] checkExpiredSubscriptions: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// BROADCAST — FIX: lock 30 menit agar queue panjang aman
// ════════════════════════════════════════════════════════════
const broadcastHistory = new Map(); // In-memory dedup

async function broadcastMessage(client, message, target = 'all') {
    try {
        // Dedup: hash pesan + target, tolak duplikat dalam 10 menit
        const hash = `${target}::${message.substring(0, 80)}`;
        const lastAt = broadcastHistory.get(hash);
        if (lastAt && Date.now() - lastAt < 10 * 60 * 1000) {
            console.log(`[BROADCAST] Duplicate dalam 10 menit — skip`);
            return { sent: 0, failed: 0, total: 0, skipped: true };
        }

        let query = supabase.from('users').select('id, store_name');
        if (target !== 'all') query = query.eq('status', target);

        const { data: users, error } = await query;
        if (error) throw new Error(error.message);
        if (!users || users.length === 0) return { sent: 0, failed: 0, total: 0 };

        let sent = 0, failed = 0;
        for (const u of users) {
            try {
                const text = message
                    .replace(/\{nama_toko\}/gi, u.store_name)
                    .replace(/\{nama\}/gi, u.store_name);
                await client.sendMessage(u.id, text);
                sent++;
            } catch (_) {
                failed++;
            }
            await sleep(1200); // 1.2 detik — aman dari ban WA
        }

        broadcastHistory.set(hash, Date.now());
        // Cleanup history jika terlalu besar
        if (broadcastHistory.size > 100) {
            const oldestKeys = Array.from(broadcastHistory.keys()).slice(0, 50);
            oldestKeys.forEach(k => broadcastHistory.delete(k));
        }

        console.log(`[BROADCAST] Selesai: ${sent} OK, ${failed} gagal dari ${users.length}`);
        return { sent, failed, total: users.length };
    } catch (err) {
        console.error(`[ERROR] broadcastMessage: ${err.message}`);
        return { sent: 0, failed: 0, total: 0 };
    }
}

async function processBroadcastPending(client) {
    try {
        const { data, error } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'broadcast_pending')
            .single();

        if (error || !data?.value || data.value === 'null') return;

        let req;
        try { req = JSON.parse(data.value); } catch (_) { return; }
        if (!req?.message || !req?.timestamp) return;

        // Reject request > 5 menit
        if (Date.now() - req.timestamp > 5 * 60 * 1000) {
            await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');
            return;
        }

        // Clear DULU sebelum eksekusi — cegah dobel eksekusi
        await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');

        const result = await broadcastMessage(client, req.message, req.target || 'all');
        if (!result.skipped) {
            await supabase.from('settings').upsert({
                key  : 'broadcast_last_result',
                value: JSON.stringify({ ...result, at: new Date().toISOString() }),
            });
        }
    } catch (err) {
        console.error(`[ERROR] processBroadcastPending: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// SAPAAN PAGI
// ════════════════════════════════════════════════════════════
async function sendMorningGreeting(client) {
    try {
        const { data: users, error } = await supabase.from('users').select('id, store_name');
        if (error || !users?.length) return;

        const greetings = [
            (n) => `🌅 *Selamat pagi Bos ${n}!*\n\nSemoga hari ini penuh berkah dan transaksi yang lancar! 💪\n\nJangan lupa catat setiap pemasukan & pengeluaran.\nContoh: *Jual kopi 50rb* atau *Beli bahan 120rb*`,
            (n) => `☀️ *Pagi Bos ${n}!*\n\nToko sudah siap buka? Yuk mulai hari dengan semangat! 🚀\n\nIngat, setiap transaksi kecil tetap penting dicatat.\nKetik *Bantuan* jika butuh panduan.`,
            (n) => `🌤️ *Good morning Bos ${n}!*\n\nHari baru, semangat baru! Bismillah buat rezeki hari ini. 🙏\n\nBot siap membantu catat keuangan seharian.\nMulai: *Jual [item] [nominal]*`,
            (n) => `🌞 *Selamat pagi Bos ${n}!*\n\nSemoga dagangan hari ini laris manis! 🛒✨\n\nCatatan keuangan yang rapi = bisnis yang lebih tenang. 💰`,
        ];

        const dayIdx = new Date().getDay();
        let sent = 0;
        for (const u of users) {
            try {
                await client.sendMessage(u.id, greetings[dayIdx % greetings.length](u.store_name));
                sent++;
            } catch (_) {}
            await sleep(600);
        }
        console.log(`[CRON] Sapaan Pagi: ${sent}/${users.length} terkirim`);
    } catch (err) {
        console.error(`[CRON] Sapaan Pagi error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// PENGINGAT SORE
// ════════════════════════════════════════════════════════════
async function sendEveningReminder(client) {
    try {
        const { data: users, error } = await supabase.from('users').select('id, store_name');
        if (error || !users?.length) return;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let reminded = 0, skipped = 0;
        for (const u of users) {
            try {
                const { count, error: cntErr } = await supabase
                    .from('transactions')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', u.id)
                    .gte('created_at', todayStart.toISOString());

                if (cntErr || (count ?? 0) > 0) { skipped++; continue; }

                await client.sendMessage(u.id,
                    `🌆 *Halo Bos ${u.store_name}!*\n\n` +
                    `Hari ini belum ada transaksi tercatat. 📭\n\n` +
                    `Mungkin terlupa? Catat sekarang:\n` +
                    `📥 *Jual kopi 50rb*\n` +
                    `📤 *Beli bahan 120rb*\n\n` +
                    `Catatan rapi hari ini = laporan akurat malam nanti. 📊`
                );
                reminded++;
            } catch (_) { skipped++; }
            await sleep(600);
        }
        console.log(`[CRON] Pengingat Sore: ${reminded} diingatkan, ${skipped} dilewati`);
    } catch (err) {
        console.error(`[CRON] Pengingat Sore error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// STOCK ALERT CHECKER
// ════════════════════════════════════════════════════════════
async function checkStockAlerts(client) {
    console.log('[CRON] Stock Alert Checker...');
    try {
        // Ambil semua pending alerts (userId null = semua user)
        const result = await stockManager.getPendingAlerts(null);
        if (!result.success || result.alerts.length === 0) return;

        // Group by user
        const byUser = {};
        result.alerts.forEach(a => {
            if (!byUser[a.user_id]) byUser[a.user_id] = [];
            byUser[a.user_id].push(a);
        });

        let sent = 0;
        for (const [userId, alerts] of Object.entries(byUser)) {
            try {
                const { data: user } = await supabase
                    .from('users')
                    .select('store_name, status')
                    .eq('id', userId)
                    .single();

                if (!user || !['pro', 'unlimited'].includes(user.status)) continue;

                let msg = `⚠️ *Stock Alert — ${user.store_name}*\n\n`;
                alerts.forEach(a => {
                    const p     = a.products;
                    const stock = stockManager.formatQty(p.stock_current, p.unit);
                    const min   = stockManager.formatQty(p.stock_min, p.unit);

                    if (a.alert_type === 'out_of_stock') {
                        msg += `🔴 *${p.name}* (\`${p.sku}\`)\n   STOK HABIS!\n\n`;
                    } else {
                        msg += `⚠️ *${p.name}* (\`${p.sku}\`)\n   Sisa: ${stock} ${p.unit} (min: ${min})\n\n`;
                    }
                });

                msg += `Ketik *Stock list* untuk lihat semua produk.`;
                await client.sendMessage(userId, msg);
                sent++;
            } catch (e) {
                console.error(`[STOCK] Alert send error ${userId}:`, e.message);
            }
            await sleep(800);
        }
        console.log(`[CRON] Stock alerts sent to ${sent} users`);
    } catch (err) {
        console.error(`[CRON] checkStockAlerts error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════════════
async function cleanupOldData() {
    console.log('[CRON] Cleanup...');
    try {
        await supabase.rpc('cleanup_processed_messages').then(({ error }) => {
            if (error) console.error('[CLEANUP] messages:', error.message);
        });
        await supabase.rpc('cleanup_expired_locks').then(({ error }) => {
            if (error) console.error('[CLEANUP] locks:', error.message);
        });
        console.log('[CRON] Cleanup done');
    } catch (err) {
        console.error(`[CRON] Cleanup error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// INISIALISASI SEMUA CRON JOBS
// ════════════════════════════════════════════════════════════
function initSchedulers(client) {
    const tz = { timezone: 'Asia/Jakarta' };

    // ── Laporan harian 22:00 (lock 60 menit) ────────────────
    cron.schedule('0 22 * * *', () => executeWithLock('daily-report', async () => {
        console.log('[CRON] Laporan Harian...');
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const { data: users } = await supabase.from('users').select('id, store_name');
        if (!users) return;
        let ok = 0;
        for (const u of users) {
            if (await sendReport(client, u.id, u.store_name, 'Harian', today.toISOString())) ok++;
            await sleep(300);
        }
        console.log(`[CRON] Harian selesai: ${ok}/${users.length}`);
    }, 60), tz);

    // ── Laporan mingguan Minggu 21:00 (lock 60 menit) ───────
    cron.schedule('0 21 * * 0', () => executeWithLock('weekly-report', async () => {
        console.log('[CRON] Laporan Mingguan...');
        const lw = new Date(); lw.setDate(lw.getDate() - 7); lw.setHours(0, 0, 0, 0);
        const { data: users } = await supabase.from('users').select('id, store_name').in('status', ['pro', 'unlimited']);
        if (!users) return;
        let ok = 0;
        for (const u of users) {
            if (await sendReport(client, u.id, u.store_name, 'Mingguan', lw.toISOString())) ok++;
            await sleep(300);
        }
        console.log(`[CRON] Mingguan selesai: ${ok}/${users.length}`);
    }, 60), tz);

    // ── Laporan bulanan tgl 1 jam 21:00 (lock 60 menit) ─────
    cron.schedule('0 21 1 * *', () => executeWithLock('monthly-report', async () => {
        console.log('[CRON] Laporan Bulanan...');
        const lm = new Date(); lm.setMonth(lm.getMonth() - 1); lm.setDate(1); lm.setHours(0, 0, 0, 0);
        const { data: users } = await supabase.from('users').select('id, store_name').in('status', ['pro', 'unlimited']);
        if (!users) return;
        let ok = 0;
        for (const u of users) {
            if (await sendReport(client, u.id, u.store_name, 'Bulanan', lm.toISOString())) ok++;
            await sleep(300);
        }
        console.log(`[CRON] Bulanan selesai: ${ok}/${users.length}`);
    }, 60), tz);

    // ── Cek expired Pro 00:05 (lock 10 menit) ───────────────
    cron.schedule('5 0 * * *', () => executeWithLock('check-expired', async () => {
        await checkExpiredSubscriptions(client);
    }, 10), tz);

    // ── Upgrade notifications tiap 1 menit (NO LOCK — cepat) ──
    cron.schedule('* * * * *', () => checkAndNotifyUpgrades(client));

    // ── Broadcast pending tiap 2 menit (lock 30 menit) ──────
    // FIX: Durasi lock dinaikkan 5 → 30 menit
    // Alasan: broadcast 1000 user × 1.2 detik = 20 menit
    // Lock 5 menit menyebabkan job overlap jika queue besar
    cron.schedule('*/2 * * * *', () => executeWithLock('broadcast', async () => {
        await processBroadcastPending(client);
    }, 30)); // ✅ 30 menit

    // ── Sapaan pagi 09:00 (lock 60 menit) ───────────────────
    cron.schedule('0 9 * * *', () => executeWithLock('morning-greeting', async () => {
        await sendMorningGreeting(client);
    }, 60), tz);

    // ── Pengingat sore 18:00 (lock 60 menit) ────────────────
    cron.schedule('0 18 * * *', () => executeWithLock('evening-reminder', async () => {
        await sendEveningReminder(client);
    }, 60), tz);

    // ── Stock alerts tiap 6 jam (lock 30 menit) ──────────────
    cron.schedule('0 */6 * * *', () => executeWithLock('stock-alerts', async () => {
        await checkStockAlerts(client);
    }, 30), tz);

    // ── Cleanup data lama 03:00 (lock 10 menit) ─────────────
    cron.schedule('0 3 * * *', () => executeWithLock('cleanup', async () => {
        await cleanupOldData();
    }, 10), tz);

    console.log('[SISTEM] ✅ Schedulers aktif:');
    console.log('  Harian(22:00) | Mingguan(Min 21:00) | Bulanan(1,21:00)');
    console.log('  Expiry(00:05) | Upgrade(1min) | Broadcast(2min,lock30m)');
    console.log('  Pagi(09:00) | Sore(18:00) | StockAlert(6jam) | Cleanup(03:00)');
}

module.exports = { initSchedulers, sendReport, sendUpgradeNotification, broadcastMessage };