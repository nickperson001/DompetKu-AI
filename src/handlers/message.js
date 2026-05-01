'use strict';
const crypto = require('crypto');

const supabase = require('../config/supabase');
const { sendReport } = require('../jobs/scheduler');
const { transcribeAudio, extractTextFromImage } = require('../utils/mediaProcessor');
const stockManager = require('../utils/stockManager');

// ════════════════════════════════════════════════════════════
// MESSAGE DEDUPLICATION (FIX LOOP BUG #1)
// ════════════════════════════════════════════════════════════
const processedMessages = new Set();

async function isMessageProcessed(messageId) {
    // Check memory cache first
    if (processedMessages.has(messageId)) return true;

    // Check database
    try {
        const { data } = await supabase
            .from('message_processed')
            .select('message_id')
            .eq('message_id', messageId)
            .single();
        
        if (data) {
            processedMessages.add(messageId);
            return true;
        }
        return false;
    } catch (_) {
        return false;
    }
}

async function markMessageProcessed(messageId, userId) {
    processedMessages.add(messageId);
    
    // Store in DB (fire-and-forget)
    supabase.from('message_processed')
        .insert([{ message_id: messageId, user_id: userId }])
        .then()
        .catch(() => {});
    
    // Cleanup memory cache if too large
    if (processedMessages.size > 10000) {
        const toDelete = Array.from(processedMessages).slice(0, 5000);
        toDelete.forEach(id => processedMessages.delete(id));
    }
}

// ════════════════════════════════════════════════════════════
// KONFIGURASI PAKET
// ════════════════════════════════════════════════════════════
const PACKAGES = {
    pro: {
        key      : 'pro',
        label    : 'PRO Bulanan',
        emoji    : '⭐',
        price    : 49_000,
        priceStr : 'Rp 49.000/bulan',
        duration : 30,
        features : [
            'Transaksi tanpa batas per hari',
            'Laporan mingguan otomatis',
            'Dashboard web stok (tambah/kurang/opname)',
            'Alert stock minimum otomatis',
            'Berlaku 30 hari, bisa diperpanjang',
        ],
    },
    unlimited: {
        key      : 'unlimited',
        label    : 'UNLIMITED Selamanya',
        emoji    : '💎',
        price    : 499_000,
        priceStr : 'Rp 499.000 (sekali bayar)',
        duration : null,
        features : [
            'Transaksi tanpa batas per hari',
            'Semua laporan otomatis (harian, mingguan, bulanan)',
            'Dashboard web stok enterprise (unlimited produk)',
            'Alert stock + rekomendasi restock',
            'Berlaku SEUMUR HIDUP — tidak perlu perpanjang',
            'Prioritas support admin',
        ],
    },
};

const PAYMENT = {
    bank    : 'BCA',
    account : '8670662536',
    name    : 'HANAN RIDWAN HANIF',
};

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function parseCurrency(text) {
    if (!text || typeof text !== 'string') return null;
    let clean = text.toLowerCase().trim();

    // ── Tolak suffix non-currency (satuan ukuran/waktu) ──────────
    if (/\d+(kg|gr|gram|ons|liter|lt|ml|cc|buah|biji|bungkus|pack|pcs|box|krat|karton|dus|sak|meter|cm|mm|menit|jam|hari|minggu|bulan|tahun|orang|org|lembar|rim|roll|set|pasang)$/i.test(clean)) {
        return null;
    }

    // ── Strip prefix ──────────────────────────────────────────────
    clean = clean.replace(/^rp\.?\s*/i, '').replace(/^:/, '').trim();

    // ── Handle multiplier suffix ──────────────────────────────────
    let multiplier = 1;

    // Milyar: m, milyar, miliar
    if (/(?:m|miliar|milyar)$/.test(clean)) {
        multiplier = 1_000_000_000;
        clean = clean.replace(/(?:m|miliar|milyar)$/, '');
    }
    // Juta: jt, juta, jt an
    else if (/(?:jt|juta)(?:an)?$/.test(clean)) {
        multiplier = 1_000_000;
        clean = clean.replace(/(?:jt|juta)(?:an)?$/, '');
    }
    // Ribu: rb, ribu, k, rbu
    else if (/(?:rb|rbu|ribu|k)(?:an)?$/.test(clean)) {
        multiplier = 1_000;
        clean = clean.replace(/(?:rb|rbu|ribu|k)(?:an)?$/, '');
    }

    // ── Handle decimal separator based on context ─────────────────
    if (multiplier > 1) {
        // With multiplier: comma is decimal (1,5jt = 1.5 million)
        clean = clean.replace(',', '.');
    } else {
        const dotCount   = (clean.match(/\./g) || []).length;
        const commaCount = (clean.match(/,/g) || []).length;

        if (dotCount >= 2) {
            // 1.000.000 → remove all dots
            clean = clean.replace(/\./g, '');
        } else if (commaCount >= 2) {
            // 1,000,000 → remove all commas
            clean = clean.replace(/,/g, '');
        } else if (dotCount === 1 && commaCount === 0) {
            const parts = clean.split('.');
            // .000 pattern = thousands separator
            if (parts[1]?.length === 3 && /^\d+$/.test(parts[1])) {
                clean = clean.replace('.', '');
            }
            // otherwise keep as decimal
        } else if (commaCount === 1 && dotCount === 0) {
            const parts = clean.split(',');
            // ,000 pattern = thousands separator
            if (parts[1]?.length === 3 && /^\d+$/.test(parts[1])) {
                clean = clean.replace(',', '');
            } else {
                // ,5 pattern = decimal
                clean = clean.replace(',', '.');
            }
        } else if (dotCount > 0 && commaCount > 0) {
            // Mixed: 1.000,50 or 1,000.50
            if (clean.lastIndexOf('.') > clean.lastIndexOf(',')) {
                // Last is dot → decimal dot style: remove commas
                clean = clean.replace(/,/g, '');
            } else {
                // Last is comma → decimal comma style: remove dots, replace comma
                clean = clean.replace(/\./g, '').replace(',', '.');
            }
        }
    }

    clean = clean.replace(/[^0-9.]/g, '');
    const nominal = parseFloat(clean) * multiplier;
    if (isNaN(nominal) || nominal <= 0 || nominal > 10_000_000_000) return null;
    return Math.round(nominal);
}

function parseQuantity(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.toLowerCase().trim();
    
    // Extract number before unit
    const match = clean.match(/^(\d+(?:[.,]\d+)?)(kg|gr|gram|liter|ml|buah|biji|bungkus|pack|pcs|box|dus|karton|sak|meter|cm|mm)?$/i);
    if (!match) return null;
    
    const num = parseFloat(match[1].replace(',', '.'));
    if (isNaN(num) || num <= 0 || num > 1_000_000) return null;
    
    return num;
}

function formatPhone(sender) {
    let n = sender.replace(/@.*$/, '').replace(/\D/g, '');
    if (n.startsWith('0')) n = '62' + n.slice(1);
    return '+' + n;
}

function formatRupiah(amount) {
    return `Rp ${Number(amount).toLocaleString('id-ID')}`;
}

async function getDailyTransactionCount(userId) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { count, error } = await supabase
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', start.toISOString());
    if (error) throw new Error(`DB count error: ${error.message}`);
    return count ?? 0;
}

async function safeReply(msg, text) {
    try {
        await msg.reply(text);
    } catch (err) {
        console.error(`[WARN] safeReply gagal ke ${msg?.from}: ${err.message}`);
    }
}

function getEffectiveStatus(user) {
    if (user.status === 'pro' && user.subscription_expires_at) {
        if (new Date(user.subscription_expires_at) <= new Date()) return 'demo';
    }
    return user.status;
}

function getDaysRemaining(user) {
    if (!user.subscription_expires_at) return null;
    const diff = new Date(user.subscription_expires_at) - new Date();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ════════════════════════════════════════════════════════════
// CACHE MAINTENANCE MODE
// ════════════════════════════════════════════════════════════
let _mCache = { active: false, message: '', ts: 0 };

async function getMaintenanceMode() {
    if (Date.now() - _mCache.ts < 30_000) return _mCache;
    try {
        const { data } = await supabase
            .from('settings')
            .select('key, value')
            .in('key', ['maintenance_mode', 'maintenance_message']);
        const map = {};
        (data || []).forEach(r => { map[r.key] = r.value; });
        _mCache = {
            active: map['maintenance_mode'] === 'true',
            message: map['maintenance_message'] || '🔧 Bot Sedang Perbaikan\n\nMohon maaf atas ketidaknyamanannya Bos.\nBot akan segera kembali normal. Terima kasih! 🙏',
            ts: Date.now(),
        };
    } catch (_) {
        _mCache.ts = Date.now();
    }
    return _mCache;
}

function invalidateMaintenanceCache() { _mCache.ts = 0; }

// ════════════════════════════════════════════════════════════
// KEYWORD DEFINITIONS
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
// KEYWORD DEFINITIONS — Riset human behavior UMKM Indonesia
// Mencakup: bahasa formal, slang, singkatan, typo umum
// ════════════════════════════════════════════════════════════

const KW_KELUAR = [
    // Pembelian & belanja
    'beli', 'belanja', 'purchase', 'bayar', 'bayarin', 'bayarkan', 'bayaran keluar',
    'purchase', 'pesan', 'pesen', 'order', 'restock',
    // Biaya operasional
    'biaya', 'ongkos', 'cost', 'expense', 'pengeluaran', 'keluar', 'modal',
    'listrik', 'air', 'gas', 'telpon', 'telepon', 'internet', 'wifi', 'kuota',
    'pulsa', 'paket data', 'sewa', 'kontrakan', 'kos', 'kontrak',
    // Gaji & upah
    'gaji', 'upah', 'honor', 'fee', 'ongkir', 'pengiriman', 'kirim uang', 'kirim',
    'kasbon', 'pinjam', 'minjemin', 'kasih pinjaman',
    // Hutang & cicilan
    'hutang', 'utang', 'nyicil', 'cicilan', 'angsuran', 'kredit', 'bayar hutang',
    'bayar cicilan', 'bayar angsuran', 'lunasin hutang',
    // Investasi & modal
    'modal', 'invest', 'investasi', 'setor modal',
    // Pajak & admin
    'pajak', 'tax', 'denda', 'administrasi', 'admin', 'biaya admin', 'asuransi',
    // Transportasi
    'bensin', 'solar', 'bbm', 'pertalite', 'pertamax', 'transport', 'transportasi',
    'ojek', 'ojol', 'gojek', 'grab', 'maxim', 'taxi', 'travel', 'parkir', 'tol',
    // Makan & minum
    'makan', 'minum', 'ngopi', 'kopi', 'lunch', 'dinner', 'breakfast', 'snack',
    'jajan', 'nongkrong', 'hang out',
    // Sosial
    'sedekah', 'donasi', 'infaq', 'zakat', 'sumbangan', 'nyumbang', 'kondangan',
    'amplop', 'kado', 'hadiah', 'parcel', 'patungan', 'urunan', 'kolekte',
    // Servis & perawatan
    'servis', 'service', 'benerin', 'repair', 'renovasi', 'maintenance',
    // Withdraw & tarik
    'tarik', 'wd', 'withdraw', 'tarik tunai', 'ambil',
    // Transfer keluar
    'tf', 'trf', 'transfer', 'kirim', 'transfer ke', 'bayar ke',
    // Lainnya
    'rugi', 'minus', 'susut', 'hilang', 'rusak', 'expired', 'kadaluarsa',
    'nombok', 'nombokin', 'talangan', 'ngasih', 'kasih', 'bantu',
    // Slang/informal
    'cap go', 'abis', 'habis buat', 'keluar buat', 'dipake buat',
];

const KW_MASUK = [
    // Penjualan
    'jual', 'jualan', 'dagang', 'laku', 'terjual', 'sold', 'penjualan', 'omzet',
    'sales', 'income', 'revenue', 'pemasukan', 'pendapatan',
    // Terima uang
    'terima', 'nerima', 'diterima', 'dapat', 'dapet', 'nemu', 'masuk',
    'bayaran', 'dibayar', 'terbayar', 'lunas', 'pelunasan',
    // Keuntungan
    'untung', 'laba', 'profit', 'cuan', 'hasilnya', 'hasil',
    // Komisi & bonus
    'komisi', 'bonus', 'thr', 'incentive', 'insentif', 'reward',
    // Gaji terima
    'gajian', 'gaji masuk', 'honor masuk', 'cair',
    // Setor & deposit  
    'setor', 'setoran', 'deposit', 'depo', 'top up', 'topup', 'isi',
    // Transfer masuk
    'tf masuk', 'transfer masuk', 'transferan', 'ditransfer', 'dikirim',
    // Refund & kembalian
    'refund', 'dikembalikan', 'kembalian', 'cashback', 'balik modal',
    // Tips & tambahan
    'tips', 'tip', 'tip masuk', 'uang tip', 'tambahan', 'extra',
    // Pinjaman diterima
    'pinjam masuk', 'hutang masuk', 'dikasih', 'dibantu',
    // Slang
    'nyairin', 'narik', 'dapet duit', 'uang masuk', 'duit masuk',
    'abis terjual', 'laris', 'borong',
];

const KW_STATUS = [
    'status', 'info', 'akun', 'profil', 'cek akun', 'cek status',
    'saldo', 'cek saldo', 'lihat saldo', 'berapa saldo', 'saldo berapa',
    'sisa uang', 'sisa duit', 'uangku', 'duitku', 'tabungan',
    'riwayat', 'history', 'histori', 'mutasi', 'mutasi rekening',
    'cek', 'lihat', 'view', 'pengaturan', 'setting',
];

const KW_LAPORAN = [
    'laporan', 'report', 'rekap', 'rekapan', 'rangkuman', 'ringkasan',
    'catatan', 'rincian', 'detail', 'summary',
    'transaksi', 'daftar transaksi', 'list transaksi',
    'statistik', 'analisis', 'analisa',
    'total', 'jumlah', 'hitungan',
    'bulan ini', 'minggu ini', 'hari ini',
    'pengeluaran bulan ini', 'pemasukan bulan ini',
    'rekap harian', 'rekap mingguan', 'rekap bulanan',
    'berapa hari ini', 'hasil hari ini',
];

const KW_BANTUAN = [
    'bantuan', 'menu', 'help', 'cara', 'panduan', 'petunjuk',
    '?', 'tutorial', 'tolong', 'tanya', 'nanya',
    'bingung', 'gimana', 'caranya', 'bagaimana', 'how',
    'bot', 'halo', 'hai', 'halo bot', 'hi bot', 'selamat', 'pagi', 'siang', 'sore', 'malam',
    'ping', 'test', 'coba', 'tes',
    'cs', 'admin', 'customer service', 'support',
    'mulai', 'start', 'begin',
];

const KW_UPGRADE = [
    'upgrade', 'paket', 'langganan', 'berlangganan', 'subscribe',
    'premium', 'pro', 'unlimited', 'vip', 'berbayar',
    'beli paket', 'beli langganan', 'perpanjang', 'renew', 'renewal',
    'donasi', 'dukung', 'support',
    'harga', 'tarif', 'biaya berlangganan',
];

const KW_BATAL = [
    'batal', 'batalin', 'batalkan', 'cancel', 'stop',
    'ga jadi', 'gak jadi', 'tidak jadi', 'nggak jadi', 'gajadi',
    'dicancel', 'undo', 'hapus', 'delete',
    'salah', 'keliru', 'maaf salah', 'kirim salah',
    'skip', 'abaikan', 'lewat',
];

// ── Stock & Dashboard (simplified for WA — full CRUD di dashboard web) ──
const KW_STOCK     = ['stok', 'stock', 'persediaan', 'inventori', 'inventory', 'gudang'];
const KW_PRODUCT   = ['produk', 'barang', 'item'];
const KW_DASHBOARD = [
    'dashboard', 'web', 'portal', 'website',
    'link stok', 'link stock', 'buka web', 'lihat web', 'akses web',
    'buka dashboard', 'lihat dashboard', 'akses dashboard',
    'cek stok', 'cek stock', 'lihat stok', 'lihat stock',
    'stok saya', 'stock saya', 'inventori saya',
];

// ════════════════════════════════════════════════════════════
// STOCK HANDLERS
// ════════════════════════════════════════════════════════════

async function handleStockList(msg, user) {
    const result = await stockManager.listProducts(user.id, { active: true });
    
    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }
    
    if (result.products.length === 0) {
        return safeReply(msg,
            `📦 *Stock Kosong*\n\n` +
            `Belum ada produk terdaftar.\n\n` +
            `Tambah produk dengan:\n` +
            `*Tambah produk [SKU] [Nama] ...*\n\n` +
            `Ketik *Bantuan Stock* untuk panduan.`
        ), true;
    }
    
    let text = `📦 *Daftar Produk - ${user.store_name}*\n\n`;
    
    result.products.forEach((p, i) => {
        const stock = stockManager.formatQty(p.stock_current, p.unit);
        const alert = parseFloat(p.stock_current) <= parseFloat(p.stock_min) ? ' ⚠️' : '';
        
        text += `${i + 1}. *${p.name}*${alert}\n`;
        text += `   SKU: ${p.sku} | ${stock} ${p.unit}\n`;
        text += `   Jual: ${formatRupiah(p.price_sell)}\n\n`;
    });
    
    text += `Ketik *Stock info [SKU]* untuk detail produk.\nKetik *Dashboard* untuk kelola stok via web (tambah/kurang/opname).`;
    
    return safeReply(msg, text), true;
}

async function handleStockInfo(msg, user, rawBody) {
    const parts = rawBody.split(/\s+/);
    const skuOrId = parts[2];
    
    if (!skuOrId) {
        return safeReply(msg, `❌ Format: *Stock info [SKU]*\n\nContoh: Stock info BRS-01`), true;
    }
    
    const result = await stockManager.getProduct(user.id, skuOrId);
    
    if (!result.success) {
        return safeReply(msg, `❌ Produk "${skuOrId}" tidak ditemukan.\n\nKetik *Stock list* untuk lihat semua produk.`), true;
    }
    
    const p = result.product;
    const stock = stockManager.formatQty(p.stock_current, p.unit);
    const min = stockManager.formatQty(p.stock_min, p.unit);
    const value = parseFloat(p.stock_current) * parseFloat(p.price_buy);
    
    let alert = '';
    if (parseFloat(p.stock_current) <= 0) {
        alert = '\n\n🔴 *STOCK HABIS!*';
    } else if (parseFloat(p.stock_current) <= parseFloat(p.stock_min)) {
        alert = '\n\n⚠️ *Stock di bawah minimum!*';
    }
    
    return safeReply(msg,
        `📦 *Detail Produk*\n\n` +
        `SKU      : ${p.sku}\n` +
        `Nama     : ${p.name}\n` +
        `Kategori : ${p.category}\n` +
        `Satuan   : ${p.unit}\n\n` +
        `💵 Harga Beli : ${formatRupiah(p.price_buy)}\n` +
        `💰 Harga Jual : ${formatRupiah(p.price_sell)}\n\n` +
        `📊 Stock      : ${stock} ${p.unit}\n` +
        `⚠️ Minimum    : ${min} ${p.unit}\n` +
        `💎 Nilai Stock: ${formatRupiah(value)}` +
        alert + `\n\n` +
        `💡 Kelola stok (tambah/kurangi/opname) via web:\n` +
        `Ketik *Dashboard* untuk dapat link akses.`
    ), true;
}


async function handleStockReport(msg, user) {
    const result = await stockManager.generateStockReport(user.id);
    
    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }
    
    if (result.totalProducts === 0) {
        return safeReply(msg, `📦 Belum ada produk terdaftar.`), true;
    }
    
    let text = `📊 *Laporan Stock - ${user.store_name}*\n\n`;
    text += `Total Produk: ${result.totalProducts}\n`;
    text += `Nilai Stock : ${formatRupiah(result.totalValue)}\n\n`;
    
    text += `*Per Kategori:*\n`;
    Object.entries(result.byCategory).forEach(([cat, data]) => {
        text += `\n${cat} (${data.count} item)\n`;
        text += `Nilai: ${formatRupiah(data.value)}\n`;
    });
    
    return safeReply(msg, text), true;
}

// ════════════════════════════════════════════════════════════
// TRANSACTION HANDLERS
// ════════════════════════════════════════════════════════════

async function showUpgradeMenu(msg, user, effectiveStatus) {
    if (effectiveStatus === 'unlimited') {
        return safeReply(msg, `💎 Bos *${user.store_name}* sudah berlangganan *UNLIMITED* selamanya!\nSemua fitur sudah aktif tanpa batas. Terima kasih! 🙏`);
    }
    let currentInfo = '';
    if (effectiveStatus === 'pro') {
        const sisa = getDaysRemaining(user);
        currentInfo = `\n📌 Status sekarang: *PRO* — sisa *${sisa} hari*\n`;
    }
    return safeReply(msg,
        `💰 *Pilih Paket - ${user.store_name}*\n` + currentInfo + `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⭐ *1. PRO Bulanan — ${PACKAGES.pro.priceStr}*\n` + PACKAGES.pro.features.map(f => `   ✅ ${f}`).join('\n') +
        `\n\n💎 *2. UNLIMITED Selamanya — ${PACKAGES.unlimited.priceStr}*\n` + PACKAGES.unlimited.features.map(f => `   ✅ ${f}`).join('\n') +
        `\n━━━━━━━━━━━━━━━━━━━━━━━\nKetik *Pilih 1* untuk PRO Bulanan\nKetik *Pilih 2* untuk UNLIMITED Selamanya`
    );
}

async function handlePackageSelection(msg, sender, user, body) {
    let pkg = null;
    if (body === 'pilih 1' || body === 'pilih pro' || body === '1' || body === 'paket 1') pkg = PACKAGES.pro;
    if (body === 'pilih 2' || body === 'pilih unlimited' || body === '2' || body === 'paket 2') pkg = PACKAGES.unlimited;
    if (!pkg) return false;

    const { error } = await supabase.from('users').update({ is_upgrading: true, upgrade_package: pkg.key }).eq('id', sender);
    if (error) throw new Error(`Gagal set upgrade: ${error.message}`);

    return safeReply(msg,
        `${pkg.emoji} *${pkg.label} - ${user.store_name}*\n\n` +
        `Transfer sebesar *${pkg.priceStr}* ke:\n💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n   a/n ${PAYMENT.name}\n\n` +
        `Setelah transfer, *kirim foto bukti* di sini.\nAdmin akan verifikasi dalam 1×24 jam. ✅\n\nKetik *Batal* untuk membatalkan.`
    ), true;
}

async function handleTransferProof(msg, client, sender, user) {
    const media = await msg.downloadMedia().catch(() => null);
    if (!media) return safeReply(msg, '❌ Gagal mengunduh gambar. Coba kirim ulang ya Bos.\n\nAtau ketik Batal untuk membatalkan.');

    const pkg = (user.upgrade_package && PACKAGES[user.upgrade_package]) ? PACKAGES[user.upgrade_package] : PACKAGES.pro;

    const { error: upErr } = await supabase.from('upgrades').insert([{ user_id: sender, package: pkg.key, status: 'pending' }]);
    if (upErr) throw new Error(`Gagal simpan upgrade: ${upErr.message}`);

    await supabase.from('users').update({ is_upgrading: false, upgrade_package: null }).eq('id', sender);

    try {
        const admin = client.info?.wid?._serialized;
        if (admin) {
            await client.sendMessage(admin, media, {
                caption: `🚨 *PERMINTAAN UPGRADE ${pkg.label.toUpperCase()}*\n🏪 Toko   : ${user.store_name}\n📱 WA     : ${formatPhone(sender)}\n💰 Paket  : ${pkg.label} (${pkg.priceStr})\n🕐 Waktu  : ${new Date().toLocaleString('id-ID')}`,
            });
        }
    } catch (e) {
        console.error(`[WARN] Gagal kirim bukti ke admin: ${e.message}`);
    }

    return safeReply(msg, `✅ *Bukti transfer diterima!*\n\nPaket      : *${pkg.label}*\nNominal    : *${pkg.priceStr}*\n\nAdmin akan memverifikasi dalam 1×24 jam.\nNotifikasi otomatis dikirim saat akun aktif. 🚀`);
}

async function handleTransaction(msg, sender, user, effectiveStatus, rawBody, body) {
    let type = null, amount = null;
    const descWords = [];

    if (KW_KELUAR.some(k => body.includes(k))) type = 'keluar';
    else if (KW_MASUK.some(k => body.includes(k))) type = 'masuk';

    // Kumpulkan semua kandidat nominal
    const candidates = [];
    for (const word of rawBody.split(/\s+/)) {
        const val = parseCurrency(word);
        if (val !== null) candidates.push({ val, word });
        else descWords.push(word);
    }
    
    // Prioritas: kata dengan prefix "Rp" atau ":", atau nominal terbesar
    if (candidates.length > 0) {
        const withPrefix = candidates.find(c => /^(rp|:)/i.test(c.word));
        amount = withPrefix ? withPrefix.val : Math.max(...candidates.map(c => c.val));
    }

    if (type && !amount) {
        const ex = type === 'keluar' ? '*beli rokok 20rb*' : '*jual kopi 15rb*';
        return safeReply(msg, `❌ *Nominalnya belum ada Bos.*\n\nContoh yang benar: ${ex}\n\nFormat angka yang didukung:\n• 20rb  • 50k  • 1.5jt  • 20.000  • 1000000`), true;
    }

    if (!type && amount) {
        return safeReply(msg, `❌ *Tipe transaksinya belum jelas Bos.*\n\n📥 Masuk : *jual kopi ${formatRupiah(amount)}*\n📤 Keluar: *beli bahan ${formatRupiah(amount)}*`), true;
    }

    if (!type && !amount) return false;

    if (effectiveStatus === 'demo') {
        const todayCount = await getDailyTransactionCount(sender);
        if (todayCount >= 5) {
            return safeReply(msg, `⚠️ *Limit Harian Demo Habis!*\n\nSudah *${todayCount} transaksi* hari ini.\nLimit reset otomatis besok pukul 00:00.\n\n💡 Ketik *Paket* untuk upgrade tanpa batas.`), true;
        }
    }

    const finalDesc = descWords.filter(w => {
        const wl = w.toLowerCase();
        return !KW_KELUAR.includes(wl) && !KW_MASUK.includes(wl) && parseCurrency(w) === null;
    }).join(' ').trim() || 'Tanpa keterangan';

    const { error: trxErr } = await supabase.from('transactions').insert([{ user_id: sender, type, amount, description: finalDesc }]);
    if (trxErr) throw new Error(`Gagal simpan transaksi: ${trxErr.message}`);

    const emoji = type === 'masuk' ? '✅' : '💸';
    const tipeLabel = type === 'masuk' ? '📥 MASUK' : '📤 KELUAR';
    let extraInfo = '';
    if (effectiveStatus === 'demo') {
        const todayCount = await getDailyTransactionCount(sender);
        const sisa = 5 - todayCount;
        extraInfo = `\n\n⏳ Sisa kuota hari ini: *${sisa} transaksi*`;
        if (sisa <= 1) extraInfo += `\n💡 Ketik *Paket* untuk upgrade tanpa batas.`;
    }

    return safeReply(msg, `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n💵 Jumlah : ${formatRupiah(amount)}\n📝 Ket    : ${finalDesc}${extraInfo}`), true;
}


// ════════════════════════════════════════════════════════════
// DASHBOARD LINK HANDLER
// Generate / retrieve token dan kirim link ke user
// ════════════════════════════════════════════════════════════
async function handleDashboardRequest(msg, sender, user) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    // Cek apakah user sudah punya token
    let { data: userData } = await supabase
        .from('users')
        .select('dashboard_token, dashboard_token_created_at')
        .eq('id', sender)
        .single();

    let token = userData?.dashboard_token;

    // Generate token baru jika belum ada
    if (!token) {
        token = crypto.randomBytes(16).toString('hex');
        await supabase.from('users')
            .update({
                dashboard_token: token,
                dashboard_token_created_at: new Date().toISOString()
            })
            .eq('id', sender);
    }

    const link = `${appUrl}/stock/${sender}?token=${token}`;

    return safeReply(msg,
        `📊 *Dashboard Stok — ${user.store_name}*\n` +
        `_Tata Business Suite_\n\n` +
        `Akses dashboard stok Anda di sini:\n` +
        `🔗 ${link}\n\n` +
        `✅ *Fitur dashboard:*\n` +
        `   • Tambah, edit & hapus produk\n` +
        `   • Catat stok masuk & keluar\n` +
        `   • Stock opname (hitung fisik)\n` +
        `   • Laporan & riwayat lengkap\n\n` +
        `⚠️ Jaga kerahasiaan link ini.\n` +
        `Ketik *Token baru* jika link bermasalah.`
    ), true;
}

async function handleNewToken(msg, sender, user) {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const token = crypto.randomBytes(16).toString('hex');
    await supabase.from('users')
        .update({
            dashboard_token: token,
            dashboard_token_created_at: new Date().toISOString()
        })
        .eq('id', sender);

    const link = `${appUrl}/stock/${sender}?token=${token}`;

    return safeReply(msg,
        `🔑 *Link Dashboard Baru — Tata Business Suite*\n\n` +
        `Link lama sudah tidak berlaku.\n\n` +
        `Link baru Anda:\n🔗 ${link}\n\n` +
        `Simpan link ini. Jangan bagikan ke orang lain.`
    ), true;
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER — PIPELINE UTAMA (FIX LOOP)
// ════════════════════════════════════════════════════════════
async function handleMessage(msg, client) {
    if (!msg) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return;
    if (msg.from.includes('-')) return;
    
    // FIX LOOP #1: Jangan proses pesan dari bot sendiri
    if (msg.fromMe) return;
    
    // FIX LOOP #1: Dedup by message ID
    if (msg.id && msg.id._serialized) {
        const isDuplicate = await isMessageProcessed(msg.id._serialized);
        if (isDuplicate) {
            console.log(`[DEDUP] Message ${msg.id._serialized} already processed — skip`);
            return;
        }
    }

    const sender = msg.from;
    const rawBody = (msg.body || '').trim();
    const body = rawBody.toLowerCase();

    // Mark as processed ASAP
    if (msg.id && msg.id._serialized) {
        await markMessageProcessed(msg.id._serialized, sender);
    }

    // Validasi kosong
    if (!rawBody && !msg.hasMedia) return;

    try {
        const maint = await getMaintenanceMode();
        if (maint.active) return safeReply(msg, maint.message);

        const { data: user, error: dbErr } = await supabase.from('users').select('*').eq('id', sender).single();
        if (dbErr && dbErr.code !== 'PGRST116') throw new Error(`Database error: ${dbErr.message}`);

        if (!user) {
            if (body.startsWith('daftar ')) {
                const storeName = rawBody.substring(7).trim();
                if (!storeName) return safeReply(msg, '❌ Nama toko tidak boleh kosong.\nContoh: *Daftar Toko Jaya*');
                if (storeName.length > 50) return safeReply(msg, '❌ Nama toko maksimal 50 karakter.');
                const { error: insErr } = await supabase.from('users').insert([{ id: sender, store_name: storeName, status: 'demo' }]);
                if (insErr) throw new Error(`Gagal daftar: ${insErr.message}`);
                return safeReply(msg, `Halo Bos *${storeName}*! 👋 Pendaftaran berhasil!\n\n📌 Akun Anda sekarang dalam mode *DEMO*\n   • Limit: *5 transaksi per hari*\n   • Gratis selamanya\n\nKetik *Bantuan* untuk panduan, atau *Paket* untuk upgrade.`);
            }
            return safeReply(msg, `Halo! 👋 Anda belum terdaftar di sistem.\n\nDaftarkan toko Anda dulu:\n📝 Ketik: *Daftar [Nama Toko]*\nContoh : *Daftar Warung Jaya*`);
        }

        msg.getChat().then(c => c.sendStateTyping()).catch(() => {});
        const effectiveStatus = getEffectiveStatus(user);

        // ── Media Processing (Voice Note & Foto Struk) ──────────
        // Hanya proses jika user tidak sedang dalam flow upgrade
        if (!user.is_upgrading && msg.hasMedia) {
            const mime = (msg.type || '').toLowerCase();
            const isAudio = mime === 'ptt' || mime === 'audio'; // ptt = push-to-talk / voice note WA
            const isImage = mime === 'image';

            if (isAudio || isImage) {
                // Kirim feedback loading dulu agar user tidak menunggu tanpa respons
                const loadingMsg = isAudio
                    ? '🎙️ Sedang transkripsi suara... sebentar ya Bos.'
                    : '📸 Sedang memindai struk... sebentar ya Bos.';

                await safeReply(msg, loadingMsg);

                try {
                    const media = await msg.downloadMedia().catch(() => null);

                    if (!media) {
                        await safeReply(msg, '❌ Gagal mengunduh file. Coba kirim ulang ya Bos.');
                    } else {
                        let result = null;

                        if (isAudio) {
                            result = await transcribeAudio(media);
                        } else {
                            result = await extractTextFromImage(media);
                        }

                        if (!result.success) {
                            // Error yang informatif berdasarkan tipe
                            const errMsg = isAudio
                                ? `❌ *Gagal memproses voice note*\n\n${result.error}\n\nCoba ketik pesannya langsung ya Bos.`
                                : `❌ *Gagal memindai struk*\n\n${result.error}\n\nTips:\n• Foto harus terang & tidak buram\n• Arahkan kamera tegak lurus\n• Pastikan tulisan terbaca jelas`;
                            await safeReply(msg, errMsg);
                        } else if (!result.hasTransaction || result.confidence < 25) {
                            // Teks berhasil diambil tapi tidak ada info transaksi
                            const preview = result.text.substring(0, 120).replace(/\n/g, ' ');
                            const hint = isAudio
                                ? `💬 Terdengar: "_${preview}..._"\n\nSaya tidak mendeteksi transaksi keuangan di sana Bos. Coba sebut nominalnya dengan jelas, contoh: "jual kopi lima puluh ribu".`
                                : `📄 Teks terdeteksi: "_${preview}..._"\n\nSaya tidak menemukan info transaksi di struk ini Bos. Coba ketik manual, contoh: *Jual 150rb*.`;
                            await safeReply(msg, hint);
                        } else {
                            // Ada transaksi — proses seperti pesan teks biasa
                            const txHandled = await handleTransaction(
                                msg, sender, user, effectiveStatus,
                                result.text, result.text.toLowerCase()
                            );
                            if (!txHandled) {
                                // Teks ada tapi parser tidak menemukan pola transaksi
                                const preview = result.text.substring(0, 100).replace(/\n/g, ' ');
                                await safeReply(msg,
                                    `📋 *Teks berhasil dibaca:*\n${preview}\n\nTapi saya belum bisa otomatis mencatat transaksinya Bos.\nCoba ketik manual: *Jual 150rb* atau *Beli bahan 75rb*`
                                );
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[MEDIA] Unhandled error: ${err.message}\n${err.stack}`);
                    await safeReply(msg,
                        `⚠️ Ada gangguan saat memproses ${isAudio ? 'voice note' : 'foto'} Bos.\nCoba kirim ulang, atau ketik pesannya langsung.`
                    );
                }
                return; // Selalu return setelah handle media — jangan proses sebagai teks
            }
        }

        // ── Bukti transfer (upgrading + foto) ──
        if (user.is_upgrading && msg.hasMedia) return handleTransferProof(msg, client, sender, user);

        // ── Upgrading tapi bukan foto ──
        if (user.is_upgrading && !msg.hasMedia) {
            const isGlobalCmd = KW_STATUS.some(k => body === k) || KW_LAPORAN.some(k => body === k || body.startsWith(k)) || KW_BANTUAN.some(k => body === k);
            if (!isGlobalCmd) {
                if (KW_BATAL.some(k => body === k || body.includes(k))) {
                    await supabase.from('users').update({ is_upgrading: false, upgrade_package: null }).eq('id', sender);
                    return safeReply(msg, `✅ Proses upgrade dibatalkan.\n\nKetik *Paket* kapan saja untuk memulai lagi.`);
                }
                const pkgKey = user.upgrade_package && PACKAGES[user.upgrade_package] ? user.upgrade_package : null;
                if (!pkgKey) {
                    await supabase.from('users').update({ is_upgrading: false, upgrade_package: null }).eq('id', sender);
                    return safeReply(msg, `⚠️ Sesi upgrade tidak ditemukan Bos.\n\nKetik *Paket* untuk memilih paket lagi.`);
                }
                const pkg = PACKAGES[pkgKey];
                return safeReply(msg, `📸 *Bos, kirim foto bukti transfer dulu ya!*\n\nPaket dipilih : *${pkg.label}*\nNominal       : *${pkg.priceStr}*\n\nTransfer ke:\n💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n   a/n ${PAYMENT.name}\n\nAtau ketik *Batal* untuk membatalkan.`);
            }
        }

        // ── Dashboard web link ──────────────────────────────
        if (KW_DASHBOARD.some(k => body === k || body.includes(k))) {
            return handleDashboardRequest(msg, sender, user);
        }
        if (body === 'token baru' || body === 'reset token' || body === 'link baru') {
            return handleNewToken(msg, sender, user);
        }

        // ── STOCK COMMANDS — WA hanya untuk cek singkat ──────────
        // Full CRUD (tambah, edit, hapus, opname) ada di dashboard web
        if (KW_STOCK.some(k => body.includes(k)) || KW_DASHBOARD.some(k => body === k || body.includes(k))) {
            // Jika kata dashboard sudah handle sebelumnya, tidak akan sampai sini
            // Ini untuk kata2 stock yang tidak masuk KW_DASHBOARD
            if (['pro', 'unlimited'].includes(effectiveStatus)) {
                // Cek stok produk tertentu: "stok BRS-01" atau "cek stok beras"
                const parts = body.split(/\s+/);
                if (parts.length >= 2) {
                    const possibleSku = parts.find(w => /^[A-Z0-9\-]{3,}/i.test(w));
                    if (possibleSku) {
                        const prodResult = await stockManager.getProduct(sender, possibleSku);
                        if (prodResult.success) {
                            const p = prodResult.product;
                            const stock = parseFloat(p.stock_current);
                            const min   = parseFloat(p.stock_min);
                            let statusIcon = stock <= 0 ? '🔴' : stock <= min ? '⚠️' : '🟢';
                            return safeReply(msg,
                                `${statusIcon} *${p.name}*\n\n` +
                                `SKU   : ${p.sku}\n` +
                                `Stok  : *${stockManager.formatQty(stock, p.unit)} ${p.unit}*\n` +
                                `Min   : ${stockManager.formatQty(min, p.unit)} ${p.unit}\n\n` +
                                `Untuk kelola stok lengkap, buka dashboard:\n` +
                                `Ketik *Dashboard* untuk dapat link.`
                            ), true;
                        }
                    }
                }
                // Default: arahkan ke dashboard
                return handleDashboardRequest(msg, sender, user);
            } else {
                return safeReply(msg,
                    `🔒 *Fitur Stock Opname*\n\n` +
                    `Tersedia untuk paket *PRO* & *UNLIMITED*.\n\n` +
                    `Ketik *Paket* untuk upgrade.`
                ), true;
            }
        }

        // ── Perintah paket/upgrade ──
        if (KW_UPGRADE.some(k => body === k) || body === 'paket') return showUpgradeMenu(msg, user, effectiveStatus);
        if (body.startsWith('pilih ')) {
            const handled = await handlePackageSelection(msg, sender, user, body);
            if (handled) return;
        }
        if (KW_BATAL.some(k => body === k)) return safeReply(msg, `Tidak ada proses yang sedang berjalan Bos. 😊\n\nKetik *Bantuan* untuk melihat menu.`);

        // ── Status ──
        if (KW_STATUS.some(k => body === k)) {
            let statusBlock = '';
            if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                statusBlock = `🎯 *Status:* 🆓 FREE DEMO\n📊 *Kuota:* ${todayCount}/5 transaksi hari ini\n\n💡 _Ketik *Paket* untuk upgrade ke fitur penuh._`;
            } else if (effectiveStatus === 'pro') {
                const sisa = getDaysRemaining(user);
                statusBlock = `🎯 *Status:* ⭐ PRO BULANAN\n📅 *Masa Aktif:* Sisa ${sisa} hari lagi`;
            } else {
                statusBlock = `🎯 *Status:* 💎 UNLIMITED SELAMANYA`;
            }
            
            const statusMessage = `ℹ️ *INFO AKUN - ${user.store_name.toUpperCase()}*

🏪 *Toko:* ${user.store_name}
📱 *WhatsApp:* ${formatPhone(sender)}

---

${statusBlock}

---
_Gunakan bot ini untuk mempermudah pencatatan bisnis Anda. Semangat, Bos!_`;

            return safeReply(msg, statusMessage);
        }

     
       // ── Laporan ──
        if (KW_LAPORAN.some(k => body === k || body.startsWith(k))) {
            const todayStart = new Date(); 
            todayStart.setHours(0, 0, 0, 0);

            const sent = await sendReport(
                client, 
                sender, 
                user.store_name, 
                'Harian (Manual)', 
                todayStart.toISOString()
            );

            if (!sent) {
                const emptyReportMsg = `📊 *LAPORAN - ${user.store_name.toUpperCase()}*

Belum ada transaksi tercatat untuk hari ini, Bos.

---
💡 *Tips:*
Mulai catat transaksi dengan mengetik langsung:
_Contoh: Jual Barang 1.5jt_`;

                return safeReply(msg, emptyReportMsg);
            }
            return;
        }
        // ── Bantuan ──
        if (KW_BANTUAN.some(k => body === k)) {
            let statusNote = '';
            if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                statusNote = `⚠️ *Mode DEMO:* ${todayCount}/5 transaksi hari ini.`;
            } else if (effectiveStatus === 'pro') {
                const sisa = getDaysRemaining(user);
                statusNote = `⭐ *PRO aktif,* sisa ${sisa} hari.`;
            } else {
                statusNote = `💎 *UNLIMITED* aktif selamanya.`;
            }
            
            let stockHelp = '';
            if (['pro', 'unlimited'].includes(effectiveStatus)) {
                stockHelp = `\n\n---\n\n*📦 MANAJEMEN STOK (OPNAME)*\n\n` +
                    `• *Tambah produk [SKU], [Nama]...*\n` +
                    `• *Stock list* — Lihat semua produk\n` +
                    `• *Stock info [SKU]* — Detail produk\n` +
                    `• *Masuk [SKU] [qty]* — Tambah stok\n` +
                    `• *Keluar [SKU] [qty]* — Kurangi stok\n` +
                    `• *Stock report* — Laporan nilai aset`;
            }
            
            const helpMessage = `📚 *PANDUAN BOT - ${user.store_name.toUpperCase()}*

${statusNote}

---

*💰 CATAT TRANSAKSI*
_(Ketik langsung untuk mencatat)_

🟢 *Pemasukan*
Format: Jual [nama] [nominal]
Contoh: *Jual kopi 50rb*

🔴 *Pengeluaran*
Format: Beli [nama] [nominal]
Contoh: *Beli kain 1.5jt*

💡 _Format angka: 20rb • 1.5jt • 20.000 • 20k_

---

*📋 PERINTAH UTAMA*

• *Laporan* — Rekap transaksi hari ini
• *Status* — Info & status akun
• *Paket* — Opsi upgrade & langganan
• *Bantuan* — Tampilkan menu ini${stockHelp}`;

            return safeReply(msg, helpMessage);
        }

        // ── Coba parsing transaksi ──
        const txHandled = await handleTransaction(msg, sender, user, effectiveStatus, rawBody, body);
        if (txHandled) return;

        // ── CATCH-ALL ──
        return safeReply(msg, `Halo Bos *${user.store_name}*! 👋\n_Tata Business Suite_\n\nMaaf, saya belum paham maksud Bos. 😅\n\nYang bisa saya bantu:\n📝 *Jual kopi 15rb* — catat pemasukan\n📝 *Beli gula 20rb* — catat pengeluaran\n📦 *Stock list* — lihat stok produk\n🌐 *Dashboard* — kelola stok via web\n📚 *Bantuan* — lihat semua panduan`);

    } catch (err) {
    console.error('FULL ERROR:', {
        message: err.message,
        stack: err.stack,
        sender,
        body
    });
    safeReply(msg, `⚠️ Ada gangguan teknis Bos...`);
    }
}

module.exports = { handleMessage, invalidateMaintenanceCache };