'use strict';

const supabase = require('../config/supabase');
const { sendReport } = require('../jobs/scheduler');
const { transcribeAudio, extractTextFromImage } = require('../utils/mediaProcessor');
const stockManager = require('../utils/stockManager');

// ════════════════════════════════════════════════════════════
// MESSAGE DEDUPLICATION — FIX: await DB insert sebelum proses
// ════════════════════════════════════════════════════════════
const processedMessages = new Set(); // In-memory cache (fast lookup)

async function isMessageProcessed(messageId) {
    if (processedMessages.has(messageId)) return true;

    try {
        const { data } = await supabase
            .from('message_processed')
            .select('message_id')
            .eq('message_id', messageId)
            .maybeSingle();

        if (data) {
            processedMessages.add(messageId); // Sync ke cache
            return true;
        }
        return false;
    } catch (_) {
        return false; // DB error: lanjutkan proses (non-fatal)
    }
}

async function markMessageProcessed(messageId, userId) {
    // ── 1. Tulis ke memory Set DULU agar cepat ──────────────
    processedMessages.add(messageId);

    // ── 2. AWAIT insert ke DB agar persistent ───────────────
    // FIX: sebelumnya fire-and-forget, sekarang di-await
    // Gunakan timeout 3 detik agar tidak memblokir terlalu lama
    try {
        await Promise.race([
            supabase
                .from('message_processed')
                .insert([{ message_id: messageId, user_id: userId }])
                .then(({ error }) => {
                    // ON CONFLICT DO NOTHING: abaikan error duplicate key
                    if (error && !error.message.includes('duplicate')) {
                        console.warn('[DEDUP] DB insert warn:', error.message);
                    }
                }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), 3000)
            ),
        ]);
    } catch (err) {
        // Timeout atau error: memory Set masih menjaga dedup dalam proses yang sama
        console.warn('[DEDUP] DB mark warning (non-fatal):', err.message);
    }

    // ── 3. Cleanup memory cache jika terlalu besar ──────────
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
        key     : 'pro',
        label   : 'PRO Bulanan',
        emoji   : '⭐',
        price   : 49_000,
        priceStr: 'Rp 49.000/bulan',
        duration: 30,
        features: [
            'Transaksi tanpa batas per hari',
            'Laporan mingguan otomatis',
            'Stock opname lengkap (unlimited produk)',
            'Alert stock minimum otomatis',
            'Berlaku 30 hari, bisa diperpanjang',
        ],
    },
    unlimited: {
        key     : 'unlimited',
        label   : 'UNLIMITED Selamanya',
        emoji   : '💎',
        price   : 199_000,
        priceStr: 'Rp 199.000 (sekali bayar)',
        duration: null,
        features: [
            'Transaksi tanpa batas per hari',
            'Semua laporan otomatis (harian, mingguan, bulanan)',
            'Stock opname enterprise (unlimited produk)',
            'Alert stock + rekomendasi restock',
            'Berlaku SEUMUR HIDUP — tidak perlu perpanjang',
            'Prioritas support admin',
        ],
    },
};

const PAYMENT = {
    bank   : 'BCA',
    account: '8670662536',
    name   : 'HANAN RIDWAN HANIF',
};

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function parseCurrency(text) {
    if (!text || typeof text !== 'string') return null;
    let clean = text.toLowerCase().trim();

    // Tolak suffix non-currency (unit ukuran/waktu)
    if (/\d+(kg|gr|gram|liter|ml|buah|biji|bungkus|pack|pcs|box|dus|karton|sak|meter|cm|mm|menit|jam|hari|minggu|bulan|tahun|orang|org)$/i.test(clean)) {
        return null;
    }

    clean = clean.replace(/^rp\.?\s*/i, '').replace(/^:/, '');

    let multiplier = 1;
    if (/(?:jt|juta)$/.test(clean)) {
        multiplier = 1_000_000;
        clean = clean.replace(/(?:jt|juta)$/, '');
    } else if (/(?:rb|ribu|k)$/.test(clean)) {
        multiplier = 1_000;
        clean = clean.replace(/(?:rb|ribu|k)$/, '');
    }

    if (multiplier > 1) {
        clean = clean.replace(',', '.');
    } else {
        const dotCount   = (clean.match(/\./g) || []).length;
        const commaCount = (clean.match(/,/g) || []).length;
        if (dotCount === 1 && commaCount === 0) {
            if (clean.split('.')[1]?.length === 3) clean = clean.replace('.', '');
        } else if (commaCount === 1 && dotCount === 0) {
            if (clean.split(',')[1]?.length === 3) clean = clean.replace(',', '');
            else clean = clean.replace(',', '.');
        } else {
            clean = clean.replace(/[.,]/g, '');
        }
    }

    clean = clean.replace(/[^0-9.]/g, '');
    const nominal = parseFloat(clean) * multiplier;
    if (isNaN(nominal) || nominal <= 0 || nominal > 10_000_000_000) return null;
    return Math.round(nominal);
}

function parseQuantity(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.trim().match(/^(\d+(?:[.,]\d+)?)/);
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
// MAINTENANCE MODE CACHE (30 detik TTL)
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
            active : map['maintenance_mode'] === 'true',
            message: map['maintenance_message'] || '🔧 Bot Sedang Perbaikan\n\nMohon maaf atas ketidaknyamanannya Bos.\nBot akan segera kembali normal. Terima kasih! 🙏',
            ts     : Date.now(),
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
const KW_KELUAR = [
    'beli', 'bayar', 'keluar', 'biaya', 'listrik', 'gaji', 'hutang', 'utang',
    'rokok', 'belanja', 'modal', 'sewa', 'transfer', 'kirim', 'ongkir', 'bensin',
    'makan', 'minum', 'service', 'servis', 'cicilan', 'angsuran', 'tagihan',
    'pengeluaran', 'bayarkan', 'pajak', 'denda', 'asuransi', 'transport', 'kredit',
    'jajan', 'ngopi', 'nongkrong', 'pulsa', 'kuota', 'paket data', 'wifi',
    'topup', 'top up', 'isi saldo', 'tarik', 'wd', 'withdraw', 'kasbon',
    'sedekah', 'donasi', 'nyumbang', 'kondangan', 'amplop', 'kado',
    'parkir', 'tol', 'gojek', 'grab', 'maxim', 'ojol',
    'bayarin', 'dibayarin', 'nyicil', 'nombok', 'rugi', 'minus',
    'tf', 'trf', 'kasih', 'ngasih', 'bantu', 'patungan', 'urunan',
];

const KW_MASUK = [
    'masuk', 'terima', 'jual', 'lunas', 'untung', 'setor', 'pemasukan',
    'pendapatan', 'dapat', 'hasil', 'bayaran', 'dibayar', 'terbayar',
    'income', 'omzet', 'penjualan', 'laku', 'terjual', 'nerima', 'laba',
    'komisi', 'bonus', 'thr', 'honor',
    'cair', 'gajian', 'cuan', 'profit', 'kembalian', 'sisa', 'refund',
    'balik modal', 'depo', 'deposit', 'transferan', 'tips',
    'dapet', 'nemu', 'dikasih', 'nyairin', 'narik', 'pelunasan', 'tf masuk',
];

const KW_STATUS   = ['status', 'info', 'akun', 'profil', 'cek akun', 'saldo', 'pengaturan', 'setting', 'sisa', 'cek saldo', 'sisa uang', 'sisa duit', 'uangku', 'duitku', 'mutasi', 'history', 'histori', 'riwayat', 'cek', 'lihat saldo'];
const KW_LAPORAN  = ['laporan', 'report', 'rekap', 'rekapan', 'rangkuman', 'catatan', 'rincian', 'detail', 'transaksi', 'daftar', 'list', 'mutasi', 'statistik', 'total', 'jumlah', 'pengeluaran bulan ini', 'bulan ini', 'minggu ini', 'hari ini'];
const KW_BANTUAN  = ['bantuan', 'menu', 'help', 'cara', 'panduan', '?', 'tutorial', 'tolong', 'tanya', 'nanya', 'admin', 'cs', 'customer service', 'bingung', 'gimana', 'bot', 'halo', 'hai', 'halo bot', 'ping', 'p'];
const KW_UPGRADE  = ['upgrade', 'paket', 'langganan', 'berlangganan', 'premium', 'pro', 'vip', 'beli paket', 'perpanjang', 'subscribe', 'donasi', 'dukung', 'support'];
const KW_BATAL    = ['batal', 'cancel', 'stop', 'hapus', 'delete', 'reset', 'clear', 'ga jadi', 'gak jadi', 'gajadi', 'batalin', 'dicancel', 'undo', 'salah', 'keliru', 'ulang', 'ngulang', 'skip', 'abaikan'];
const KW_STOCK    = ['stock', 'stok', 'persediaan', 'inventory', 'gudang'];

// ════════════════════════════════════════════════════════════
// STOCK COMMAND HANDLERS
// ════════════════════════════════════════════════════════════

async function handleStockAdd(msg, user, rawBody) {
    const parts = rawBody.split(/\s+/);

    if (parts.length < 4) {
        return safeReply(msg,
            `📦 *Tambah Produk Baru*\n\n` +
            `Format:\n` +
            `*Tambah produk [SKU] [Nama] unit [satuan] beli [harga] jual [harga] stock [qty] min [qty]*\n\n` +
            `Contoh:\n` +
            `*Tambah produk BRS-01 Beras Premium unit kg beli 10000 jual 12000 stock 100 min 10*\n\n` +
            `• SKU: kode unik produk (huruf/angka/dash)\n` +
            `• Unit: kg, pcs, liter, box, dll\n` +
            `• stock & min: opsional`
        ), true;
    }

    const data = {
        sku         : parts[2],
        name        : '',
        unit        : 'pcs',
        priceBuy    : 0,
        priceSell   : 0,
        stockInitial: 0,
        stockMin    : 0,
        category    : 'Umum',
    };

    // Tentukan akhir nama (sebelum keyword 'unit'/'beli'/'stock')
    const keywords = ['unit', 'beli', 'jual', 'stock', 'min', 'kategori'];
    let nameEnd = parts.length;
    for (let i = 3; i < parts.length; i++) {
        if (keywords.includes(parts[i].toLowerCase())) { nameEnd = i; break; }
    }
    data.name = parts.slice(3, nameEnd).join(' ');

    for (let i = 0; i < parts.length; i++) {
        const w = parts[i].toLowerCase();
        if (w === 'unit'     && parts[i + 1]) data.unit         = parts[i + 1];
        if (w === 'beli'     && parts[i + 1]) data.priceBuy     = parseCurrency(parts[i + 1]) || 0;
        if (w === 'jual'     && parts[i + 1]) data.priceSell    = parseCurrency(parts[i + 1]) || 0;
        if (w === 'stock'    && parts[i + 1]) data.stockInitial = parseFloat(parts[i + 1]) || 0;
        if (w === 'min'      && parts[i + 1]) data.stockMin     = parseFloat(parts[i + 1]) || 0;
        if (w === 'kategori' && parts[i + 1]) data.category     = parts[i + 1];
    }

    if (!data.name) {
        return safeReply(msg, `❌ Nama produk wajib diisi setelah SKU.\n\nContoh: *Tambah produk BRS-01 Beras Premium ...*`), true;
    }

    const result = await stockManager.addProduct(user.id, data);

    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }

    const p = result.product;
    return safeReply(msg,
        `✅ *Produk Berhasil Ditambahkan!*\n\n` +
        `📦 SKU     : *${p.sku}*\n` +
        `📝 Nama    : ${p.name}\n` +
        `📂 Kategori: ${p.category}\n` +
        `📊 Satuan  : ${p.unit}\n` +
        `💵 Harga Beli: ${formatRupiah(p.price_buy)}\n` +
        `💰 Harga Jual: ${formatRupiah(p.price_sell)}\n` +
        `📦 Stock Awal: ${stockManager.formatQty(p.stock_current, p.unit)} ${p.unit}\n` +
        `⚠️ Minimum   : ${stockManager.formatQty(p.stock_min, p.unit)} ${p.unit}\n\n` +
        `Ketik *Stock list* untuk lihat semua produk.`
    ), true;
}

async function handleStockList(msg, user) {
    const result = await stockManager.listProducts(user.id, { active: true });

    if (!result.success) {
        return safeReply(msg, `❌ Gagal mengambil data: ${result.error}`), true;
    }

    if (result.products.length === 0) {
        return safeReply(msg,
            `📦 *Belum Ada Produk*\n\n` +
            `Tambah produk pertama Anda:\n` +
            `*Tambah produk [SKU] [Nama] unit [satuan] beli [harga] jual [harga]*\n\n` +
            `Contoh:\n*Tambah produk KPI-01 Kopi Arabika unit kg beli 80000 jual 120000 stock 10 min 2*`
        ), true;
    }

    let text = `📦 *Daftar Produk — ${user.store_name}*\n`;
    text += `Total: ${result.products.length} produk\n\n`;

    result.products.forEach((p, i) => {
        const stock    = stockManager.formatQty(p.stock_current, p.unit);
        const stockNum = parseFloat(p.stock_current);
        const minNum   = parseFloat(p.stock_min);

        let icon = '🟢';
        if (stockNum <= 0)       icon = '🔴';
        else if (stockNum <= minNum) icon = '⚠️';

        text += `${i + 1}. ${icon} *${p.name}*\n`;
        text += `   SKU: \`${p.sku}\` | ${stock} ${p.unit}\n`;
        text += `   Jual: ${formatRupiah(p.price_sell)}\n\n`;
    });

    text += `🟢 Aman  ⚠️ Menipis  🔴 Habis\n\n`;
    text += `Ketik *Stock info [SKU]* untuk detail`;

    return safeReply(msg, text), true;
}

async function handleStockInfo(msg, user, rawBody) {
    const parts    = rawBody.split(/\s+/);
    const skuOrId  = parts[2];

    if (!skuOrId) {
        return safeReply(msg, `❌ Format: *Stock info [SKU]*\nContoh: *Stock info BRS-01*`), true;
    }

    const result = await stockManager.getProduct(user.id, skuOrId);

    if (!result.success) {
        return safeReply(msg, `❌ Produk "${skuOrId}" tidak ditemukan.\nKetik *Stock list* untuk lihat semua produk.`), true;
    }

    const p     = result.product;
    const stock = stockManager.formatQty(p.stock_current, p.unit);
    const min   = stockManager.formatQty(p.stock_min, p.unit);
    const value = parseFloat(p.stock_current) * parseFloat(p.price_buy);

    let statusAlert = '\n✅ Stock aman';
    if (parseFloat(p.stock_current) <= 0) {
        statusAlert = '\n\n🔴 *STOK HABIS! Segera restock.*';
    } else if (parseFloat(p.stock_current) <= parseFloat(p.stock_min)) {
        statusAlert = '\n\n⚠️ *Stock menipis! Di bawah minimum.*';
    }

    return safeReply(msg,
        `📦 *Detail Produk*\n\n` +
        `SKU      : \`${p.sku}\`\n` +
        `Nama     : ${p.name}\n` +
        `Kategori : ${p.category}\n` +
        `Satuan   : ${p.unit}\n\n` +
        `💵 Harga Beli : ${formatRupiah(p.price_buy)}\n` +
        `💰 Harga Jual : ${formatRupiah(p.price_sell)}\n` +
        `📊 Margin     : ${formatRupiah(parseFloat(p.price_sell) - parseFloat(p.price_buy))}\n\n` +
        `📦 Stok Saat Ini: *${stock} ${p.unit}*\n` +
        `⚠️ Minimum      : ${min} ${p.unit}\n` +
        `💎 Nilai Stok   : ${formatRupiah(value)}` +
        statusAlert + `\n\n` +
        `Aksi:\n` +
        `• *Masuk ${p.sku} [qty]* — tambah stok\n` +
        `• *Keluar ${p.sku} [qty]* — kurangi stok\n` +
        `• *Stock history ${p.sku}* — riwayat`
    ), true;
}

async function handleStockHistory(msg, user, rawBody) {
    const parts   = rawBody.split(/\s+/);
    const skuOrId = parts[2];

    if (!skuOrId) {
        return safeReply(msg, `❌ Format: *Stock history [SKU]*`), true;
    }

    const prodResult = await stockManager.getProduct(user.id, skuOrId);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${skuOrId}" tidak ditemukan.`), true;
    }

    const histResult = await stockManager.getStockHistory(user.id, prodResult.product.id, 10);
    if (!histResult.success || histResult.movements.length === 0) {
        return safeReply(msg, `📋 Belum ada riwayat pergerakan stok untuk *${prodResult.product.name}*.`), true;
    }

    const p = prodResult.product;
    let text = `📋 *Riwayat Stok — ${p.name}*\n(10 terakhir)\n\n`;

    histResult.movements.forEach(m => {
        const tgl  = new Date(m.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: '2-digit' });
        const jam  = new Date(m.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const icon = m.type === 'in' ? '➕' : m.type === 'out' ? '➖' : '🔄';

        text += `${icon} *${m.type.toUpperCase()}* ${stockManager.formatQty(m.quantity, p.unit)} ${p.unit}\n`;
        text += `   ${m.stock_before} → ${m.stock_after} | ${tgl} ${jam}\n`;
        if (m.note) text += `   📝 ${m.note}\n`;
        text += '\n';
    });

    return safeReply(msg, text), true;
}

async function handleStockIn(msg, user, rawBody) {
    const parts = rawBody.split(/\s+/);

    if (parts.length < 3) {
        return safeReply(msg, `❌ Format: *Masuk [SKU] [jumlah] [catatan]\nContoh: Masuk BRS-01 50*`), true;
    }

    const sku  = parts[1];
    const qty  = parseQuantity(parts[2]);
    const note = parts.slice(3).join(' ') || null;

    if (!qty || qty <= 0) {
        return safeReply(msg, `❌ Jumlah tidak valid: "${parts[2]}"\nContoh: *Masuk BRS-01 50*`), true;
    }

    const prodResult = await stockManager.getProduct(user.id, sku);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${sku}" tidak ditemukan.\nKetik *Stock list* untuk cek SKU yang benar.`), true;
    }

    const product = prodResult.product;
    const result  = await stockManager.adjustStock(user.id, product.id, 'in', qty, { referenceType: 'manual', note });

    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }

    return safeReply(msg,
        `✅ *Stok Masuk Berhasil!*\n\n` +
        `📦 ${product.name} (\`${product.sku}\`)\n` +
        `➕ Masuk   : *${stockManager.formatQty(qty, product.unit)} ${product.unit}*\n` +
        `📊 Sebelum : ${stockManager.formatQty(result.stockBefore, product.unit)} ${product.unit}\n` +
        `📊 Sekarang: *${stockManager.formatQty(result.stockAfter, product.unit)} ${product.unit}*\n` +
        (note ? `📝 Catatan : ${note}\n` : '') +
        `\n💡 Ketik *Stock info ${product.sku}* untuk detail`
    ), true;
}

async function handleStockOut(msg, user, rawBody) {
    const parts = rawBody.split(/\s+/);

    if (parts.length < 3) {
        return safeReply(msg, `❌ Format: *Keluar [SKU] [jumlah] [catatan]*\nContoh: *Keluar BRS-01 10*`), true;
    }

    const sku  = parts[1];
    const qty  = parseQuantity(parts[2]);
    const note = parts.slice(3).join(' ') || null;

    if (!qty || qty <= 0) {
        return safeReply(msg, `❌ Jumlah tidak valid: "${parts[2]}"\nContoh: *Keluar BRS-01 10*`), true;
    }

    const prodResult = await stockManager.getProduct(user.id, sku);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${sku}" tidak ditemukan.`), true;
    }

    const product = prodResult.product;
    const result  = await stockManager.adjustStock(user.id, product.id, 'out', qty, { referenceType: 'manual', note });

    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }

    return safeReply(msg,
        `✅ *Stok Keluar Berhasil!*\n\n` +
        `📦 ${product.name} (\`${product.sku}\`)\n` +
        `➖ Keluar  : *${stockManager.formatQty(qty, product.unit)} ${product.unit}*\n` +
        `📊 Sebelum : ${stockManager.formatQty(result.stockBefore, product.unit)} ${product.unit}\n` +
        `📊 Sekarang: *${stockManager.formatQty(result.stockAfter, product.unit)} ${product.unit}*\n` +
        (note ? `📝 Catatan : ${note}\n` : '') +
        (result.stockAfter <= parseFloat(product.stock_min)
            ? `\n⚠️ *Perhatian: Stok mendekati minimum!*`
            : '')
    ), true;
}

async function handleStockAdjust(msg, user, rawBody) {
    // Format: Adjust BRS-01 75 koreksi fisik
    const parts = rawBody.split(/\s+/);
    if (parts.length < 3) {
        return safeReply(msg, `❌ Format: *Adjust [SKU] [jumlah baru] [catatan]*\nContoh: *Adjust BRS-01 75 koreksi fisik*`), true;
    }

    const sku  = parts[1];
    const qty  = parseQuantity(parts[2]);
    const note = parts.slice(3).join(' ') || 'Penyesuaian manual';

    if (qty === null || qty < 0) {
        return safeReply(msg, `❌ Jumlah tidak valid: "${parts[2]}"`), true;
    }

    const prodResult = await stockManager.getProduct(user.id, sku);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${sku}" tidak ditemukan.`), true;
    }

    const product = prodResult.product;
    const result  = await stockManager.adjustStock(user.id, product.id, 'adjustment', qty, { referenceType: 'adjustment', note });

    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }

    return safeReply(msg,
        `🔄 *Penyesuaian Stok Berhasil!*\n\n` +
        `📦 ${product.name} (\`${product.sku}\`)\n` +
        `📊 Sebelum : ${stockManager.formatQty(result.stockBefore, product.unit)} ${product.unit}\n` +
        `📊 Setelah : *${stockManager.formatQty(result.stockAfter, product.unit)} ${product.unit}*\n` +
        `📝 Catatan : ${note}`
    ), true;
}

async function handleStockReport(msg, user) {
    const result = await stockManager.generateStockReport(user.id);

    if (!result.success) {
        return safeReply(msg, `❌ Gagal generate laporan: ${result.error}`), true;
    }

    if (result.totalProducts === 0) {
        return safeReply(msg, `📦 Belum ada produk terdaftar.\n\nKetik *Bantuan stock* untuk panduan.`), true;
    }

    let text = `📊 *Laporan Stok — ${user.store_name}*\n`;
    text += `📅 ${new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n\n`;
    text += `📦 Total Produk : ${result.totalProducts}\n`;
    text += `💎 Total Nilai  : ${formatRupiah(result.totalValue)}\n`;
    if (result.outStockCount > 0) text += `🔴 Stok Habis   : ${result.outStockCount} produk\n`;
    if (result.lowStockCount > 0) text += `⚠️ Stok Menipis : ${result.lowStockCount} produk\n`;

    text += `\n${'─'.repeat(26)}\n`;

    Object.entries(result.byCategory).forEach(([cat, data]) => {
        text += `\n📂 *${cat}* (${data.count} item)\n`;
        text += `   Nilai: ${formatRupiah(data.value)}\n`;
    });

    if (result.outStockCount > 0 || result.lowStockCount > 0) {
        text += `\n${'─'.repeat(26)}\n`;
        text += `\n⚠️ *Produk Perlu Perhatian:*\n`;
        result.products
            .filter(p => parseFloat(p.stock_current) <= parseFloat(p.stock_min))
            .slice(0, 5)
            .forEach(p => {
                const icon = parseFloat(p.stock_current) <= 0 ? '🔴' : '⚠️';
                text += `${icon} ${p.name}: ${stockManager.formatQty(p.stock_current, p.unit)} ${p.unit}\n`;
            });
    }

    return safeReply(msg, text), true;
}

// ════════════════════════════════════════════════════════════
// UPGRADE & TRANSACTION HANDLERS
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
        `💰 *Pilih Paket — ${user.store_name}*\n` + currentInfo +
        `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⭐ *1. PRO Bulanan — ${PACKAGES.pro.priceStr}*\n` +
        PACKAGES.pro.features.map(f => `   ✅ ${f}`).join('\n') +
        `\n\n💎 *2. UNLIMITED Selamanya — ${PACKAGES.unlimited.priceStr}*\n` +
        PACKAGES.unlimited.features.map(f => `   ✅ ${f}`).join('\n') +
        `\n━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `Ketik *Pilih 1* untuk PRO\nKetik *Pilih 2* untuk UNLIMITED`
    );
}

async function handlePackageSelection(msg, sender, user, body) {
    let pkg = null;
    if (['pilih 1', 'pilih pro', '1', 'paket 1'].includes(body)) pkg = PACKAGES.pro;
    if (['pilih 2', 'pilih unlimited', '2', 'paket 2'].includes(body)) pkg = PACKAGES.unlimited;
    if (!pkg) return false;

    const { error } = await supabase.from('users')
        .update({ is_upgrading: true, upgrade_package: pkg.key })
        .eq('id', sender);
    if (error) throw new Error(`Gagal set upgrade: ${error.message}`);

    await safeReply(msg,
        `${pkg.emoji} *${pkg.label} — ${user.store_name}*\n\n` +
        `Transfer sebesar *${pkg.priceStr}* ke:\n` +
        `💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n` +
        `   a/n ${PAYMENT.name}\n\n` +
        `Setelah transfer, *kirim foto bukti* di sini.\n` +
        `Admin akan verifikasi dalam 1×24 jam. ✅\n\n` +
        `Ketik *Batal* untuk membatalkan.`
    );
    return true;
}

async function handleTransferProof(msg, client, sender, user) {
    const media = await msg.downloadMedia().catch(() => null);
    if (!media) return safeReply(msg, '❌ Gagal mengunduh gambar. Coba kirim ulang.\n\nAtau ketik *Batal* untuk membatalkan.');

    const pkg = (user.upgrade_package && PACKAGES[user.upgrade_package])
        ? PACKAGES[user.upgrade_package]
        : PACKAGES.pro;

    const { error: upErr } = await supabase.from('upgrades')
        .insert([{ user_id: sender, package: pkg.key, status: 'pending' }]);
    if (upErr) throw new Error(`Gagal simpan upgrade: ${upErr.message}`);

    await supabase.from('users')
        .update({ is_upgrading: false, upgrade_package: null })
        .eq('id', sender);

    try {
        const admin = client.info?.wid?._serialized;
        if (admin) {
            await client.sendMessage(admin, media, {
                caption:
                    `🚨 *PERMINTAAN UPGRADE ${pkg.label.toUpperCase()}*\n` +
                    `🏪 Toko  : ${user.store_name}\n` +
                    `📱 WA    : ${formatPhone(sender)}\n` +
                    `💰 Paket : ${pkg.label} (${pkg.priceStr})\n` +
                    `🕐 Waktu : ${new Date().toLocaleString('id-ID')}`,
            });
        }
    } catch (e) {
        console.error(`[WARN] Gagal kirim bukti ke admin: ${e.message}`);
    }

    return safeReply(msg,
        `✅ *Bukti Transfer Diterima!*\n\n` +
        `Paket   : *${pkg.label}*\n` +
        `Nominal : *${pkg.priceStr}*\n\n` +
        `Admin akan memverifikasi dalam 1×24 jam.\n` +
        `Notifikasi otomatis dikirim saat akun aktif. 🚀`
    );
}

async function handleTransaction(msg, sender, user, effectiveStatus, rawBody, body) {
    let type = null;
    let amount = null;
    const descWords = [];

    if (KW_KELUAR.some(k => body.includes(k))) type = 'keluar';
    else if (KW_MASUK.some(k => body.includes(k))) type = 'masuk';

    // Kumpulkan semua kandidat nominal — ambil terbesar / yang ada prefix Rp atau :
    const candidates = [];
    for (const word of rawBody.split(/\s+/)) {
        const val = parseCurrency(word);
        if (val !== null) candidates.push({ val, word });
        else descWords.push(word);
    }

    if (candidates.length > 0) {
        const withPrefix = candidates.find(c => /^(rp|:)/i.test(c.word));
        amount = withPrefix ? withPrefix.val : Math.max(...candidates.map(c => c.val));
    }

    if (type && !amount) {
        const ex = type === 'keluar' ? '*beli rokok 20rb*' : '*jual kopi 15rb*';
        return safeReply(msg,
            `❌ *Nominalnya belum ada Bos.*\n\n` +
            `Contoh: ${ex}\n\n` +
            `Format angka: 20rb • 50k • 1.5jt • 20.000`
        ), true;
    }
    if (!type && amount) {
        return safeReply(msg,
            `❌ *Tipe transaksi belum jelas Bos.*\n\n` +
            `📥 Masuk : *jual kopi ${formatRupiah(amount)}*\n` +
            `📤 Keluar: *beli bahan ${formatRupiah(amount)}*`
        ), true;
    }
    if (!type && !amount) return false;

    if (effectiveStatus === 'demo') {
        const todayCount = await getDailyTransactionCount(sender);
        if (todayCount >= 5) {
            return safeReply(msg,
                `⚠️ *Limit Harian Demo Habis!*\n\n` +
                `Sudah *${todayCount} transaksi* hari ini.\n` +
                `Limit reset otomatis besok pukul 00:00.\n\n` +
                `💡 Ketik *Paket* untuk upgrade tanpa batas.`
            ), true;
        }
    }

    const finalDesc = descWords.filter(w => {
        const wl = w.toLowerCase();
        return !KW_KELUAR.includes(wl) && !KW_MASUK.includes(wl) && parseCurrency(w) === null;
    }).join(' ').trim() || 'Tanpa keterangan';

    const { error: trxErr } = await supabase.from('transactions')
        .insert([{ user_id: sender, type, amount, description: finalDesc }]);
    if (trxErr) throw new Error(`Gagal simpan transaksi: ${trxErr.message}`);

    const emoji    = type === 'masuk' ? '✅' : '💸';
    const tipeLbl  = type === 'masuk' ? '📥 MASUK' : '📤 KELUAR';
    let extraInfo  = '';

    if (effectiveStatus === 'demo') {
        const todayCount = await getDailyTransactionCount(sender);
        const sisa = 5 - todayCount;
        extraInfo = `\n\n⏳ Sisa kuota hari ini: *${sisa} transaksi*`;
        if (sisa <= 1) extraInfo += `\n💡 Ketik *Paket* untuk upgrade.`;
    }

    return safeReply(msg,
        `${emoji} *Berhasil Dicatat!*\n\n` +
        `${tipeLbl}\n` +
        `💵 Jumlah : ${formatRupiah(amount)}\n` +
        `📝 Ket    : ${finalDesc}` +
        extraInfo
    ), true;
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER — PIPELINE (FIX LOOP + DEDUP AWAIT)
// ════════════════════════════════════════════════════════════
async function handleMessage(msg, client) {
    if (!msg) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@g.us')) return;  // Skip grup
    if (msg.from.includes('-')) return;       // Skip channel

    // ── FIX LOOP: Skip pesan dari bot sendiri ──────────────
    if (msg.fromMe) return;

    // ── FIX LOOP: Dedup by message ID (await untuk persistensi) ──
    const msgId = msg.id?._serialized;
    if (msgId) {
        const isDuplicate = await isMessageProcessed(msgId);
        if (isDuplicate) {
            console.log(`[DEDUP] Skip duplicate: ${msgId}`);
            return;
        }
        // AWAIT insert sebelum lanjut proses agar benar-benar tercatat
        await markMessageProcessed(msgId, msg.from);
    }

    const sender  = msg.from;
    const rawBody = (msg.body || '').trim();
    const body    = rawBody.toLowerCase();

    if (!rawBody && !msg.hasMedia) return;

    try {
        const maint = await getMaintenanceMode();
        if (maint.active) return safeReply(msg, maint.message);

        const { data: user, error: dbErr } = await supabase
            .from('users').select('*').eq('id', sender).maybeSingle();
        if (dbErr) throw new Error(`Database error: ${dbErr.message}`);

        // ── User belum daftar ──
        if (!user) {
            if (body.startsWith('daftar ')) {
                const storeName = rawBody.substring(7).trim();
                if (!storeName)            return safeReply(msg, '❌ Nama toko tidak boleh kosong.\nContoh: *Daftar Toko Jaya*');
                if (storeName.length > 50) return safeReply(msg, '❌ Nama toko maksimal 50 karakter.');
                const { error: insErr } = await supabase.from('users')
                    .insert([{ id: sender, store_name: storeName, status: 'demo' }]);
                if (insErr) throw new Error(`Gagal daftar: ${insErr.message}`);
                return safeReply(msg,
                    `Halo Bos *${storeName}*! 👋 Pendaftaran berhasil!\n\n` +
                    `📌 Akun Anda sekarang dalam mode *DEMO*\n` +
                    `   • Limit: *5 transaksi per hari*\n` +
                    `   • Gratis selamanya\n\n` +
                    `Ketik *Bantuan* untuk panduan lengkap.`
                );
            }
            return safeReply(msg,
                `Halo! 👋 Anda belum terdaftar.\n\n` +
                `Daftarkan toko Anda:\n` +
                `📝 Ketik: *Daftar [Nama Toko]*\n` +
                `Contoh : *Daftar Warung Jaya*`
            );
        }

        msg.getChat().then(c => c.sendStateTyping()).catch(() => {});
        const effectiveStatus = getEffectiveStatus(user);

        // ── Media Processing (Voice & Image OCR) ────────────
        if (!user.is_upgrading && msg.hasMedia) {
            try {
                const media = await msg.downloadMedia().catch(() => null);
                if (media) {
                    let extractedText = '';
                    if (media.mimetype.startsWith('audio/')) {
                        extractedText = await transcribeAudio(media);
                    } else if (media.mimetype.startsWith('image/')) {
                        // Jika sedang upgrade → handle sebagai bukti transfer
                        if (user.is_upgrading) return handleTransferProof(msg, client, sender, user);
                        extractedText = await extractTextFromImage(media);
                    }

                    if (extractedText && extractedText.trim().length > 3) {
                        const mockMsg = { reply: async (t) => safeReply(msg, t) };
                        const txHandled = await handleTransaction(
                            mockMsg, sender, user, effectiveStatus,
                            extractedText, extractedText.toLowerCase()
                        );
                        if (txHandled) return;
                    }
                }
            } catch (err) {
                console.error(`[MEDIA] Gagal proses: ${err.message}`);
            }
        }

        // ── Bukti transfer (is_upgrading + foto) ────────────
        if (user.is_upgrading && msg.hasMedia) return handleTransferProof(msg, client, sender, user);

        // ── Sedang upgrade tapi bukan foto ──────────────────
        if (user.is_upgrading && !msg.hasMedia) {
            const isGlobalCmd =
                KW_STATUS.some(k => body === k) ||
                KW_LAPORAN.some(k => body === k || body.startsWith(k)) ||
                KW_BANTUAN.some(k => body === k);

            if (!isGlobalCmd) {
                if (KW_BATAL.some(k => body === k || body.includes(k))) {
                    await supabase.from('users')
                        .update({ is_upgrading: false, upgrade_package: null })
                        .eq('id', sender);
                    return safeReply(msg, `✅ Proses upgrade dibatalkan.\n\nKetik *Paket* kapan saja untuk memulai lagi.`);
                }
                const pkgKey = user.upgrade_package && PACKAGES[user.upgrade_package] ? user.upgrade_package : null;
                if (!pkgKey) {
                    await supabase.from('users')
                        .update({ is_upgrading: false, upgrade_package: null })
                        .eq('id', sender);
                    return safeReply(msg, `⚠️ Sesi upgrade tidak ditemukan.\n\nKetik *Paket* untuk memilih paket lagi.`);
                }
                const pkg = PACKAGES[pkgKey];
                return safeReply(msg,
                    `📸 *Bos, kirim foto bukti transfer dulu ya!*\n\n` +
                    `Paket   : *${pkg.label}*\n` +
                    `Nominal : *${pkg.priceStr}*\n\n` +
                    `Transfer ke:\n💳 *${PAYMENT.bank} — ${PAYMENT.account}*\n   a/n ${PAYMENT.name}\n\n` +
                    `Atau ketik *Batal* untuk membatalkan.`
                );
            }
        }

        // ════════════════════════════════════════════════════
        // STOCK COMMANDS — Pro/Unlimited only
        // Harus dicek SEBELUM keyword masuk/keluar biasa
        // ════════════════════════════════════════════════════
        if (['pro', 'unlimited'].includes(effectiveStatus)) {

            if (body.startsWith('tambah produk ') || body.startsWith('add produk ')) {
                return handleStockAdd(msg, user, rawBody);
            }
            if (body === 'stock list' || body === 'stok list' || body === 'daftar produk' || body === 'list produk') {
                return handleStockList(msg, user);
            }
            if (body.startsWith('stock info ') || body.startsWith('stok info ') || body.startsWith('info produk ')) {
                return handleStockInfo(msg, user, rawBody);
            }
            if (body.startsWith('stock history ') || body.startsWith('stok history ') || body.startsWith('riwayat stok ')) {
                return handleStockHistory(msg, user, rawBody);
            }
            if (body === 'stock report' || body === 'stok report' || body === 'laporan stok') {
                return handleStockReport(msg, user);
            }

            // Adjust (opname fisik)
            if (body.startsWith('adjust ') || body.startsWith('koreksi ')) {
                return handleStockAdjust(msg, user, rawBody);
            }

            // Bantuan stock
            if (body === 'bantuan stock' || body === 'bantuan stok' || body === 'help stock') {
                return safeReply(msg,
                    `📦 *Panduan Stock Opname*\n\n` +
                    `*Tambah Produk:*\n` +
                    `Tambah produk [SKU] [Nama] unit [satuan] beli [harga] jual [harga] stock [qty] min [qty]\n\n` +
                    `*Lihat Produk:*\n` +
                    `• *Stock list* — semua produk\n` +
                    `• *Stock info [SKU]* — detail produk\n` +
                    `• *Stock history [SKU]* — riwayat 10 terakhir\n` +
                    `• *Stock report* — laporan nilai stok\n\n` +
                    `*Update Stok:*\n` +
                    `• *Masuk [SKU] [qty]* — stok masuk\n` +
                    `• *Keluar [SKU] [qty]* — stok keluar\n` +
                    `• *Adjust [SKU] [qty baru]* — koreksi fisik\n\n` +
                    `Contoh SKU: BRS-01, KPI-01, GLA-02`
                ), true;
            }

            // Stock IN — harus format: "masuk [SKU] [qty]"
            // SKU pattern harus uppercase/angka/dash agar tidak bentrok "masuk" transaksi keuangan
            const bodyParts  = body.split(/\s+/);
            const firstWord  = bodyParts[0];
            const secondWord = bodyParts[1] || '';

            if ((firstWord === 'masuk' || firstWord === 'in') &&
                /^[A-Z0-9][A-Z0-9\-]{1,}/i.test(secondWord) &&
                bodyParts.length >= 3) {
                return handleStockIn(msg, user, rawBody);
            }

            // Stock OUT — hanya jika format "keluar [SKU] [qty]" dan SKU valid
            if ((firstWord === 'keluar' || firstWord === 'out') &&
                /^[A-Z0-9][A-Z0-9\-]{1,}/i.test(secondWord) &&
                bodyParts.length >= 3 &&
                !KW_KELUAR.some(k => k !== 'keluar' && body.includes(k))) {
                // Validasi: kata kedua harus berupa SKU (bukan nama produk biasa)
                if (secondWord.includes('-') || /^[A-Z]{2,}\d+$/i.test(secondWord)) {
                    return handleStockOut(msg, user, rawBody);
                }
            }

        } else if (KW_STOCK.some(k => body.includes(k))) {
            // Demo user coba akses fitur stock
            return safeReply(msg,
                `🔒 *Fitur Stock Opname*\n\n` +
                `Fitur ini tersedia untuk paket *PRO* & *UNLIMITED*.\n\n` +
                `✅ Kelola stok produk\n` +
                `✅ Alert stok minimum otomatis\n` +
                `✅ Laporan nilai inventori\n\n` +
                `Ketik *Paket* untuk upgrade.`
            ), true;
        }

        // ── Upgrade / Paket ──────────────────────────────────
        if (KW_UPGRADE.some(k => body === k) || body === 'paket') {
            return showUpgradeMenu(msg, user, effectiveStatus);
        }
        if (body.startsWith('pilih ') || ['1', '2'].includes(body)) {
            const handled = await handlePackageSelection(msg, sender, user, body);
            if (handled) return;
        }
        if (KW_BATAL.some(k => body === k)) {
            return safeReply(msg, `Tidak ada proses yang sedang berjalan Bos. 😊\n\nKetik *Bantuan* untuk melihat menu.`);
        }

        // ── Status Akun ──────────────────────────────────────
        if (KW_STATUS.some(k => body === k)) {
            let statusBlock = '';
            if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                statusBlock = `🎯 Status  : *🆓 DEMO*\n📊 Hari ini: *${todayCount}/5 transaksi*\n💡 Ketik *Paket* untuk upgrade.`;
            } else if (effectiveStatus === 'pro') {
                const sisa = getDaysRemaining(user);
                statusBlock = `🎯 Status  : *⭐ PRO Bulanan*\n📅 Sisa    : *${sisa} hari*`;
            } else {
                statusBlock = `🎯 Status  : *💎 UNLIMITED Selamanya*`;
            }
            return safeReply(msg,
                `ℹ️ *Info Akun*\n\n` +
                `🏪 Toko    : *${user.store_name}*\n` +
                `📱 WA      : ${formatPhone(sender)}\n` +
                `${statusBlock}`
            );
        }

        // ── Laporan ──────────────────────────────────────────
        if (KW_LAPORAN.some(k => body === k || body.startsWith(k))) {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const sent = await sendReport(client, sender, user.store_name, 'Harian (Manual)', todayStart.toISOString());
            if (!sent) return safeReply(msg, `📊 *${user.store_name}*\n\nBelum ada transaksi hari ini Bos.\nMulai catat: *Jual kopi 15rb*`);
            return;
        }

        // ── Bantuan ──────────────────────────────────────────
        if (KW_BANTUAN.some(k => body === k)) {
            let statusNote = '';
            let stockHelp  = '';

            if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                statusNote = `\n⚠️ Mode DEMO: *${todayCount}/5 transaksi* hari ini.\n`;
            } else if (effectiveStatus === 'pro') {
                statusNote = `\n⭐ PRO aktif, sisa *${getDaysRemaining(user)} hari*.\n`;
                stockHelp  = `\n*📦 Stock Opname (PRO):*\n• *Stock list* • *Stock info [SKU]* • *Masuk/Keluar [SKU] [qty]*\n• *Stock report* • *Bantuan stock* — panduan lengkap\n`;
            } else {
                statusNote = `\n💎 UNLIMITED aktif selamanya.\n`;
                stockHelp  = `\n*📦 Stock Opname (UNLIMITED):*\n• *Stock list* • *Stock info [SKU]* • *Masuk/Keluar [SKU] [qty]*\n• *Stock report* • *Bantuan stock* — panduan lengkap\n`;
            }

            return safeReply(msg,
                `📚 *Panduan Bot — ${user.store_name}*\n` +
                statusNote +
                `\n*💰 Catat Transaksi:*\n` +
                `🟢 Masuk : *Jual kopi 50rb*\n` +
                `🔴 Keluar: *Beli kain 1.5jt*\n` +
                `Format: 20rb • 1.5jt • 20.000 • 20k\n` +
                `\n*📋 Perintah:*\n` +
                `📊 *Laporan* — rekap hari ini\n` +
                `ℹ️ *Status*  — info akun\n` +
                `💰 *Paket*   — upgrade\n` +
                `📚 *Bantuan* — menu ini\n` +
                stockHelp
            );
        }

        // ── Parsing Transaksi Keuangan ────────────────────────
        const txHandled = await handleTransaction(msg, sender, user, effectiveStatus, rawBody, body);
        if (txHandled) return;

        // ── CATCH-ALL ─────────────────────────────────────────
        return safeReply(msg,
            `Halo Bos *${user.store_name}*! 👋\n\n` +
            `Maaf, saya belum paham maksud Bos. 😅\n\n` +
            `Coba:\n` +
            `📝 *Jual kopi 15rb* — catat pemasukan\n` +
            `📝 *Beli gula 20rb* — catat pengeluaran\n` +
            `📚 *Bantuan* — lihat semua panduan\n` +
            `📊 *Laporan* — rekap hari ini`
        );

    } catch (err) {
        console.error(`[ERROR] handleMessage [${sender}]: ${err.message}\n${err.stack}`);
        safeReply(msg, `⚠️ Ada gangguan teknis Bos. Coba lagi ya.\nJika masalah berlanjut, ketik *Bantuan*.`);
    }
}

module.exports = { handleMessage, invalidateMaintenanceCache };