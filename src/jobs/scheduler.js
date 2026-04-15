'use strict';

const cron     = require('node-cron');
const supabase = require('../config/supabase');

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

/** Jeda non-blocking agar tidak flood WA */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════
// KIRIM LAPORAN
// Return: true jika ada data & berhasil dikirim, false jika tidak.
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
                `   • Laporan mingguan & bulanan otomatis\n\n` +
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
// Berjalan tiap 1 menit. upgrade_notified=false mencegah dobel kirim.
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
// Berjalan setiap hari jam 00:05. Pro expired → kembali ke demo.
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
// BROADCAST KE USER
// target: 'all' | 'demo' | 'pro' | 'unlimited'
// {nama_toko} diganti otomatis per-user.
// ════════════════════════════════════════════════════════════
async function broadcastMessage(client, message, target = 'all') {
    try {
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
            await sleep(600); // jeda 600ms — aman dari ban WA
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
// Admin panel menyimpan request ke settings.broadcast_pending.
// Scheduler ini yang mengeksekusi agar WA client ada di sini.
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
// Kirim ke semua user yang terdaftar sebagai semangat memulai hari
// ════════════════════════════════════════════════════════════
async function sendMorningGreeting(client) {
    console.log('[CRON] Sapaan Pagi...');
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, store_name');

        if (error) throw new Error(error.message);
        if (!users || users.length === 0) return;

        // Variasi pesan pagi agar tidak monoton
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
                // Pilih variasi pesan berdasarkan hari agar berbeda tiap hari
                const dayOfWeek = new Date().getDay(); // 0-6
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
// Hanya kirim ke user yang BELUM ADA transaksi hari ini
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
                // Cek apakah user sudah ada transaksi hari ini
                const { count, error: cntErr } = await supabase
                    .from('transactions')
                    .select('*', { count: 'exact', head: true })
                    .eq('user_id', u.id)
                    .gte('created_at', todayStart.toISOString());

                if (cntErr) { skipped++; continue; }

                // Sudah ada transaksi → skip, tidak perlu diingatkan
                if ((count ?? 0) > 0) { skipped++; continue; }

                // Belum ada transaksi → kirim pengingat
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

        console.log(`[CRON] Pengingat Sore: ${reminded} diingatkan, ${skipped} dilewati (sudah transaksi/error).`);
    } catch (err) {
        console.error(`[CRON] Pengingat Sore error: ${err.message}`);
    }
}

// ════════════════════════════════════════════════════════════
// INISIALISASI SEMUA CRON JOBS
// ════════════════════════════════════════════════════════════
function initSchedulers(client) {
    const tz = { timezone: 'Asia/Jakarta' };

    // Laporan harian — 22:00 semua user
    cron.schedule('0 22 * * *', async () => {
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
    }, tz);

    // Laporan mingguan — Minggu 21:00 khusus pro & unlimited
    cron.schedule('0 21 * * 0', async () => {
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
    }, tz);

    // Laporan bulanan — Tgl 1 jam 21:00 khusus pro & unlimited
    cron.schedule('0 21 1 * *', async () => {
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
    }, tz);

    // Cek expired pro — tiap hari jam 00:05
    cron.schedule('5 0 * * *', () => checkExpiredSubscriptions(client), tz);

    // Notifikasi upgrade — tiap 1 menit (fallback realtime)
    cron.schedule('* * * * *', () => checkAndNotifyUpgrades(client));

    // Broadcast pending — tiap 2 menit
    cron.schedule('*/2 * * * *', () => processBroadcastPending(client));

    // Sapaan pagi — tiap hari jam 09:00
    cron.schedule('0 9 * * *', () => sendMorningGreeting(client), tz);

    // Pengingat sore — tiap hari jam 18:00, hanya user tanpa transaksi hari ini
    cron.schedule('0 18 * * *', () => sendEveningReminder(client), tz);

    console.log('[SISTEM] ✅ Scheduler aktif: Harian | Mingguan | Bulanan | Expiry | Upgrade | Broadcast | Sapaan Pagi | Pengingat Sore');
}

module.exports = { initSchedulers, sendReport, sendUpgradeNotification, broadcastMessage };