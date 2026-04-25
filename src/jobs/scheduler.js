'use strict';

const cron     = require('node-cron');
const os       = require('os');
const supabase = require('../config/supabase');
const stockManager = require('../utils/stockManager');

// ════════════════════════════════════════════════════════════
// MUTEX LOCK SYSTEM (FIX LOOP BUG #2)
// Prevent cron job double execution
// ════════════════════════════════════════════════════════════
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now()}`;
const activeLocks = new Set();

async function acquireLock(jobName, durationMinutes = 5) {
    const lockKey = `lock:${jobName}`;
    
    // Check memory lock first (fast path)
    if (activeLocks.has(lockKey)) {
        console.log(`[LOCK] ${jobName} already locked in memory`);
        return false;
    }
    
    try {
        const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
        
        // Try to acquire DB lock
const { data, error } = await supabase
    .from('scheduler_locks')
    .insert([{
        job_name  : jobName,
        locked_at : new Date().toISOString(),
        locked_by : INSTANCE_ID,
        expires_at: expiresAt.toISOString(),
    }])
    .select()
    .single();

if (error) {
    // Jika error duplikat, berarti lock sedang dipegang server lain
    console.log(`[LOCK] ${jobName} locked by another instance`);
    return false;
}
        
        // Check if we got the lock (not expired and owned by us)
        if (data && data.locked_by === INSTANCE_ID) {
            activeLocks.add(lockKey);
            console.log(`[LOCK] ✅ ${jobName} acquired by ${INSTANCE_ID}`);
            return true;
        }
        
        return false;
    } catch (err) {
        console.error(`[LOCK] Error acquiring ${jobName}:`, err.message);
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
        console.error(`[LOCK] Error releasing ${jobName}:`, err.message);
    }
}

// Wrapper untuk execute job dengan lock
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
function formatRupiah(amount) {
    return `Rp ${Number(amount).toLocaleString('id-ID')}`;
}

function formatPhone(sender) {
    let n = sender.replace(/@.*$/, '').replace(/\D/g, '');
    if (n.startsWith('0')) n = '62' + n.slice(1);
    return '+' + n;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// KIRIM LAPORAN
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

        const teks =
            `📊 *Laporan ${periodStr}*\n` +
            `🏪 ${storeName}\n` +
            `${'─'.repeat(26)}\n` +
            `🟢 Masuk  : ${formatRupiah(masuk)}\n` +
            `🔴 Keluar : ${formatRupiah(keluar)}\n` +
            `${'─'.repeat(26)}\n` +
            `${saldo >= 0
                ? `💰 *Saldo: ${formatRupiah(saldo)}*`
                : `🔴 *Defisit: -${formatRupiah(Math.abs(saldo))}*`}\n` +
            `📋 Total ${trans.length} transaksi`;

        await client.sendMessage(userId, teks);
        return true;
    } catch (err) {
        console.error(`[ERROR] sendReport [${userId}]: ${err.message}`);
        return false;
    }
}

// ════════════════════════════════════════════════════════════
// NOTIFIKASI UPGRADE PRO / UNLIMITED
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
                `   • Stock opname enterprise unlimited\n` +
                `   • Tidak perlu perpanjang lagi\n\n` +
                `Terima kasih telah mempercayai kami! 🙏`;
        } else {
            const exp = expiresAt
                ? new Date(expiresAt).toLocaleDateString('id-ID', { day:'2-digit', month:'long', year:'numeric' })
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
                `Terima kasih telah mempercayai kami! 🙏`;
        }
        await client.sendMessage(userId, msg);
        console.log(`[NOTIF] Upgrade notification → ${storeName} (${userId}) [${status}]`);
        return true;
    } catch (err) {
        console.error(`[ERROR] sendUpgradeNotification [${userId}]: ${err.message}`);
        return false;
    }
}

// ════════════════════════════════════════════════════════════
// POLLING: CEK USER BARU UPGRADE (fallback realtime)
// ════════════════════════════════════════════════════════════
async function checkAndNotifyUpgrades(client) {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, store_name, status, subscription_expires_at')
            .in('status', ['pro', 'unlimited'])
            .eq('upgrade_notified', false);

        if (error) { console.error(`[ERROR] checkAndNotifyUpgrades: ${error.message}`); return; }
        if (!users || users.length === 0) return;

        for (const u of users) {
            const sent = await sendUpgradeNotification(
                client, u.id, u.store_name, u.status, u.subscription_expires_at
            );
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
// CRON: DOWNGRADE PRO YANG SUDAH EXPIRED
// ════════════════════════════════════════════════════════════
async function checkExpiredSubscriptions(client) {
    try {
        const now = new Date().toISOString();
        const { data: expired, error } = await supabase
            .from('users')
            .select('id, store_name')
            .eq('status', 'pro')
            .lt('subscription_expires_at', now);

        if (error) { console.error(`[ERROR] checkExpired: ${error.message}`); return; }
        if (!expired || expired.length === 0) return;

        console.log(`[CRON] ${expired.length} user pro expired — downgrade ke demo.`);

        for (const u of expired) {
            await supabase.from('users')
                .update({ status: 'demo', upgrade_notified: false })
                .eq('id', u.id);

            try {
                await client.sendMessage(u.id,
                    `⚠️ *Langganan PRO Habis - ${u.store_name}*\n\n` +
                    `Akun Anda kembali ke mode *DEMO* (5 transaksi/hari).\n\n` +
                    `Ketik *Paket* untuk perpanjang langganan. 🙏`
                );
            } catch (_) {}
            await sleep(500);
        }
    } catch (err) {
        console.error(`[ERROR] checkExpiredSubscriptions: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// BROADCAST KE USER (FIX LOOP BUG #3)
// ════════════════════════════════════════════════════════════
const broadcastHistory = new Map(); // In-memory dedup

async function broadcastMessage(client, message, target = 'all') {
    try {
        // Dedup check: hash message + target
        const hash = `${message.substring(0, 50)}-${target}`;
        const lastSent = broadcastHistory.get(hash);
        
        // Jangan kirim broadcast yang sama dalam 10 menit
        if (lastSent && Date.now() - lastSent < 10 * 60 * 1000) {
            console.log(`[BROADCAST] Duplicate detected within 10min — skip`);
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
                const text = message.replace(/\{nama_toko\}/gi, u.store_name);
                await client.sendMessage(u.id, text);
                sent++;
            } catch (_) {
                failed++;
            }
            await sleep(1200); // 1.2 detik — aman dari ban WA
        }

        // Mark as sent
        broadcastHistory.set(hash, Date.now());
        
        // Cleanup old history (keep last 100 only)
        if (broadcastHistory.size > 100) {
            const oldest = Array.from(broadcastHistory.keys()).slice(0, 50);
            oldest.forEach(k => broadcastHistory.delete(k));
        }

        console.log(`[BROADCAST] Selesai: ${sent} OK, ${failed} gagal, total ${users.length}`);
        return { sent, failed, total: users.length };
    } catch (err) {
        console.error(`[ERROR] broadcastMessage: ${err.message}`);
        return { sent: 0, failed: 0, total: 0 };
    }
}

// ════════════════════════════════════════════════════════════
// POLLING: PROSES BROADCAST_PENDING DARI ADMIN PANEL
// ════════════════════════════════════════════════════════════
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

        // Cegah eksekusi request yang terlalu lama (lebih dari 5 menit)
        if (Date.now() - req.timestamp > 5 * 60 * 1000) {
            await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');
            return;
        }

        // Langsung clear dulu supaya tidak dobel eksekusi jika cron overlap
        await supabase.from('settings').update({ value: 'null' }).eq('key', 'broadcast_pending');

        const result = await broadcastMessage(client, req.message, req.target || 'all');
        
        if (result.skipped) {
            console.log(`[BROADCAST] Skipped duplicate`);
            return;
        }
        
        console.log(`[BROADCAST] Hasil: ${JSON.stringify(result)}`);

        // Simpan hasil broadcast ke settings
        await supabase.from('settings')
            .upsert({ key: 'broadcast_last_result', value: JSON.stringify({ ...result, at: new Date().toISOString() }) });

    } catch (err) {
        console.error(`[ERROR] processBroadcastPending: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// SAPAAN PAGI — Setiap hari jam 09:00
// ════════════════════════════════════════════════════════════
async function sendMorningGreeting(client) {
    console.log('[CRON] Sapaan Pagi...');
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, store_name');

        if (error) throw new Error(error.message);
        if (!users || users.length === 0) return;

        const greetings = [
            (name) =>
                `🌅 *Selamat pagi Bos ${name}!*\n\n` +
                `Semoga hari ini penuh berkah dan transaksi yang lancar ya! 💪\n\n` +
                `Jangan lupa catat setiap pemasukan & pengeluaran hari ini.\n` +
                `Contoh: *Jual kopi 50rb* atau *Beli bahan 120rb*`,

            (name) =>
                `☀️ *Pagi Bos ${name}!*\n\n` +
                `Toko sudah siap buka? Yuk mulai hari dengan semangat! 🚀\n\n` +
                `Ingat, setiap transaksi kecil tetap penting dicatat.\n` +
                `Ketik *Bantuan* jika butuh panduan.`,

            (name) =>
                `🌤️ *Good morning Bos ${name}!*\n\n` +
                `Hari baru, semangat baru! Bismillah buat rezeki hari ini. 🙏\n\n` +
                `Bot siap membantu catat keuangan toko Anda seharian penuh.\n` +
                `Mulai dengan: *Jual [item] [nominal]*`,

            (name) =>
                `🌞 *Selamat pagi Bos ${name}!*\n\n` +
                `Semoga dagangan hari ini laris manis ya! 🛒✨\n\n` +
                `Yuk catat transaksi pertama hari ini — sehebat apapun\n` +
                `usaha Anda, catatan keuangan yang rapi bikin lebih tenang. 💰`,
        ];

        let sent = 0;
        for (const u of users) {
            try {
                const dayOfWeek = new Date().getDay();
                const greetFn   = greetings[dayOfWeek % greetings.length];
                await client.sendMessage(u.id, greetFn(u.store_name));
                sent++;
            } catch (_) {}
            await sleep(600);
        }

        console.log(`[CRON] Sapaan Pagi selesai: ${sent}/${users.length} terkirim.`);
    } catch (err) {
        console.error(`[CRON] Sapaan Pagi error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// PENGINGAT SORE — Setiap hari jam 18:00
// ════════════════════════════════════════════════════════════
async function sendEveningReminder(client) {
    console.log('[CRON] Pengingat Sore...');
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, store_name');

        if (error) throw new Error(error.message);
        if (!users || users.length === 0) return;

        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        let reminded = 0;
        let skipped  = 0;

        for (const u of users) {
            try {
                const { count, error: cntErr } = await supabase
                    .from('transactions')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', u.id)
                    .gte('created_at', todayStart.toISOString());

                if (cntErr) { skipped++; continue; }
                if ((count ?? 0) > 0) { skipped++; continue; }

                await client.sendMessage(u.id,
                    `🌆 *Halo Bos ${u.store_name}!*\n\n` +
                    `Kami lihat hari ini belum ada transaksi yang tercatat. 📭\n\n` +
                    `Mungkin terlupa? Yuk catat sekarang sebelum lupa:\n` +
                    `📥 Masuk : *Jual kopi 50rb*\n` +
                    `📤 Keluar: *Beli bahan 120rb*\n\n` +
                    `Catatan yang rapi hari ini bikin laporan malam nanti lebih akurat. 📊`
                );
                reminded++;
            } catch (_) {
                skipped++;
            }
            await sleep(600);
        }

        console.log(`[CRON] Pengingat Sore: ${reminded} diingatkan, ${skipped} dilewati.`);
    } catch (err) {
        console.error(`[CRON] Pengingat Sore error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// STOCK ALERT CHECKER — Kirim notif stock rendah/habis
// ════════════════════════════════════════════════════════════
async function checkStockAlerts(client) {
    console.log('[CRON] Stock Alert Checker...');
    try {
        const result = await stockManager.getPendingAlerts(null);
        
        // Group by user
        const byUser = {};
        (result.alerts || []).forEach(alert => {
            if (!byUser[alert.user_id]) byUser[alert.user_id] = [];
            byUser[alert.user_id].push(alert);
        });
        
        let sent = 0;
        for (const [userId, alerts] of Object.entries(byUser)) {
            try {
                // Get user info
                const { data: user } = await supabase
                    .from('users')
                    .select('store_name, status')
                    .eq('id', userId)
                    .single();
                
                if (!user || !['pro', 'unlimited'].includes(user.status)) continue;
                
                let msg = `⚠️ *Stock Alert - ${user.store_name}*\n\n`;
                
                alerts.forEach(a => {
                    const p = a.products;
                    const stock = stockManager.formatQty(p.stock_current, p.unit);
                    const min = stockManager.formatQty(p.stock_min, p.unit);
                    
                    if (a.alert_type === 'out_of_stock') {
                        msg += `🔴 *${p.name}* (${p.sku})\n`;
                        msg += `   Stock HABIS!\n\n`;
                    } else {
                        msg += `⚠️ *${p.name}* (${p.sku})\n`;
                        msg += `   Stock: ${stock} ${p.unit} (min: ${min})\n\n`;
                    }
                });
                
                const appUrl = process.env.APP_URL || 'dompetku-ai-production.up.railway.app';
                // Get user token for dashboard link
                const { data: uToken } = await supabase.from('users').select('dashboard_token').eq('id', userId).single();
                if (uToken?.dashboard_token) {
                    const dashLink = `${appUrl}/stock/${userId}?token=${uToken.dashboard_token}`;
                    msg += `📊 Kelola stok di:\n${dashLink}`;
                } else {
                    msg += `Ketik *Dashboard* di WA untuk akses portal stok.`;
                }
                
                await client.sendMessage(userId, msg);
                sent++;
            } catch (e) {
                console.error(`[STOCK] Alert send error ${userId}:`, e.message);
            }
            await sleep(800);
        }
        
        console.log(`[CRON] Stock alerts sent: ${sent}`);
    } catch (err) {
        console.error(`[CRON] Stock alert error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// CLEANUP JOBS — Hapus data lama untuk menjaga DB tetap ringan
// ════════════════════════════════════════════════════════════
async function cleanupOldData() {
    console.log('[CRON] Cleanup old data...');
    try {
        // Cleanup message_processed older than 24h
        const { error: msgErr } = await supabase
            .rpc('cleanup_processed_messages');
        if (msgErr) console.error('[CLEANUP] message_processed error:', msgErr.message);
        
        // Cleanup expired locks
        const { error: lockErr } = await supabase
            .rpc('cleanup_expired_locks');
        if (lockErr) console.error('[CLEANUP] locks error:', lockErr.message);
        
        console.log('[CRON] Cleanup done.');
    } catch (err) {
        console.error(`[CRON] Cleanup error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// INISIALISASI SEMUA CRON JOBS (WITH MUTEX LOCK)
// ════════════════════════════════════════════════════════════
function initSchedulers(client) {
    const tz = { timezone: 'Asia/Jakarta' };

    // Laporan harian — 22:00 semua user (WITH LOCK)
    cron.schedule('0 22 * * *', () => {
        executeWithLock('daily-report', async () => {
            console.log('[CRON] Laporan Harian...');
            try {
                const today = new Date(); today.setHours(0, 0, 0, 0);
                const { data: users } = await supabase.from('users').select('id, store_name');
                if (!users) return;
                let ok = 0;
                for (const u of users) {
                    if (await sendReport(client, u.id, u.store_name, 'Harian', today.toISOString())) ok++;
                    await sleep(300);
                }
                console.log(`[CRON] Harian selesai: ${ok}/${users.length}`);
            } catch (e) { console.error(`[CRON] Harian: ${e.message}`); }
        }, 60); // 60 min lock
    }, tz);

    // Laporan mingguan — Minggu 21:00 khusus pro & unlimited
    cron.schedule('0 21 * * 0', () => {
        executeWithLock('weekly-report', async () => {
            console.log('[CRON] Laporan Mingguan...');
            try {
                const lw = new Date(); lw.setDate(lw.getDate() - 7); lw.setHours(0, 0, 0, 0);
                const { data: users } = await supabase.from('users').select('id, store_name')
                    .in('status', ['pro', 'unlimited']);
                if (!users) return;
                let ok = 0;
                for (const u of users) {
                    if (await sendReport(client, u.id, u.store_name, 'Mingguan', lw.toISOString())) ok++;
                    await sleep(300);
                }
                console.log(`[CRON] Mingguan selesai: ${ok}/${users.length}`);
            } catch (e) { console.error(`[CRON] Mingguan: ${e.message}`); }
        }, 60);
    }, tz);

    // Laporan bulanan — Tgl 1 jam 21:00 khusus pro & unlimited
    cron.schedule('0 21 1 * *', () => {
        executeWithLock('monthly-report', async () => {
            console.log('[CRON] Laporan Bulanan...');
            try {
                const lm = new Date(); lm.setMonth(lm.getMonth() - 1); lm.setDate(1); lm.setHours(0, 0, 0, 0);
                const { data: users } = await supabase.from('users').select('id, store_name')
                    .in('status', ['pro', 'unlimited']);
                if (!users) return;
                let ok = 0;
                for (const u of users) {
                    if (await sendReport(client, u.id, u.store_name, 'Bulanan', lm.toISOString())) ok++;
                    await sleep(300);
                }
                console.log(`[CRON] Bulanan selesai: ${ok}/${users.length}`);
            } catch (e) { console.error(`[CRON] Bulanan: ${e.message}`); }
        }, 60);
    }, tz);

    // Cek expired pro — tiap hari jam 00:05
    cron.schedule('5 0 * * *', () => {
        executeWithLock('check-expired', async () => {
            await checkExpiredSubscriptions(client);
        }, 10);
    }, tz);

    // Notifikasi upgrade — tiap 1 menit (fallback realtime) - NO LOCK (fast)
    cron.schedule('* * * * *', () => checkAndNotifyUpgrades(client));

    // Broadcast pending — tiap 2 menit (WITH LOCK)
    cron.schedule('*/2 * * * *', () => {
        executeWithLock('broadcast', async () => {
            await processBroadcastPending(client);
        }, 5);
    });

    // Sapaan pagi — tiap hari jam 09:00
    cron.schedule('0 9 * * *', () => {
        executeWithLock('morning-greeting', async () => {
            await sendMorningGreeting(client);
        }, 60);
    }, tz);

    // Pengingat sore — tiap hari jam 18:00
    cron.schedule('0 18 * * *', () => {
        executeWithLock('evening-reminder', async () => {
            await sendEveningReminder(client);
        }, 60);
    }, tz);

    // Stock alert — tiap 6 jam (00:00, 06:00, 12:00, 18:00)
    cron.schedule('0 */6 * * *', () => {
        executeWithLock('stock-alerts', async () => {
            await checkStockAlerts(client);
        }, 30);
    }, tz);

    // Cleanup old data — tiap hari jam 03:00
    cron.schedule('0 3 * * *', () => {
        executeWithLock('cleanup', async () => {
            await cleanupOldData();
        }, 10);
    }, tz);

    console.log('[SISTEM] ✅ Scheduler aktif dengan mutex lock:');
    console.log('  - Harian (22:00) | Mingguan (Minggu 21:00) | Bulanan (tgl 1, 21:00)');
    console.log('  - Expiry check (00:05) | Upgrade notif (tiap 1 min)');
    console.log('  - Broadcast (tiap 2 min) | Sapaan pagi (09:00) | Pengingat sore (18:00)');
    console.log('  - Stock alerts (tiap 6 jam) | Cleanup (03:00)');
}

module.exports = { initSchedulers, sendReport, sendUpgradeNotification, broadcastMessage };