'use strict';

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
            'Stock opname lengkap (unlimited produk)',
            'Alert stock minimum otomatis',
            'Berlaku 30 hari, bisa diperpanjang',
        ],
    },
    unlimited: {
        key      : 'unlimited',
        label    : 'UNLIMITED Selamanya',
        emoji    : '💎',
        price    : 199_000,
        priceStr : 'Rp 199.000 (sekali bayar)',
        duration : null,
        features : [
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
    
    // Tolak suffix non-currency
    if (/\d+(kg|gr|gram|liter|ml|buah|biji|bungkus|pack|pcs|box|dus|karton|sak|meter|cm|mm|menit|jam|hari|minggu|bulan|tahun|orang|org)$/i.test(clean)) {
        return null;
    }
    
    clean = clean.replace(/^rp\.?\s*/, '').replace(/^:/, '');
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
    'tf', 'trf', 'kasih', 'ngasih', 'bantu', 'patungan', 'urunan'
];

const KW_MASUK = [
    'masuk', 'terima', 'jual', 'lunas', 'untung', 'setor', 'pemasukan',
    'pendapatan', 'dapat', 'hasil', 'bayaran', 'dibayar', 'terbayar',
    'income', 'omzet', 'penjualan', 'laku', 'terjual', 'nerima', 'laba',
    'komisi', 'bonus', 'thr', 'gaji', 'honor',
    'cair', 'gajian', 'cuan', 'profit', 'kembalian', 'sisa', 'refund',
    'balik modal', 'depo', 'deposit', 'transferan', 'tips',
    'dapet', 'nemu', 'dikasih', 'nyairin', 'narik', 'pelunasan', 'tf masuk'
];

const KW_STATUS = [
    'status', 'info', 'akun', 'profil', 'cek akun', 'saldo', 'pengaturan', 'setting',
    'sisa', 'cek saldo', 'sisa uang', 'sisa duit', 'uangku', 'duitku',
    'mutasi', 'history', 'histori', 'riwayat', 'cek', 'lihat saldo'
];

const KW_LAPORAN = [
    'laporan', 'report', 'rekap', 'rekapan', 'rangkuman', 'catatan', 'rincian',
    'detail', 'transaksi', 'daftar', 'list', 'mutasi', 'statistik',
    'total', 'jumlah', 'pengeluaran bulan ini', 'bulan ini', 'minggu ini', 'hari ini'
];

const KW_BANTUAN = [
    'bantuan', 'menu', 'help', 'cara', 'panduan', '?', 'tutorial', 'info',
    'tolong', 'tanya', 'nanya', 'admin', 'cs', 'customer service',
    'bingung', 'gimana', 'bot', 'halo', 'hai', 'halo bot', 'ping', 'p'
];

const KW_UPGRADE = [
    'upgrade', 'paket', 'langganan', 'berlangganan', 'premium', 'pro', 'vip',
    'beli paket', 'perpanjang', 'subscribe', 'donasi', 'dukung', 'support'
];

const KW_BATAL = [
    'batal', 'cancel', 'stop', 'keluar', 'hapus', 'delete', 'reset', 'clear',
    'ga jadi', 'gak jadi', 'gajadi', 'batalin', 'dicancel', 'undo',
    'salah', 'keliru', 'ulang', 'ngulang', 'skip', 'abaikan'
];

// Stock keywords
const KW_STOCK = ['stock', 'stok', 'persediaan', 'barang', 'inventory', 'gudang'];
const KW_PRODUCT = ['produk', 'product', 'item', 'barang'];

// ════════════════════════════════════════════════════════════
// STOCK HANDLERS
// ════════════════════════════════════════════════════════════

async function handleStockAdd(msg, user, rawBody, body) {
    // Format: tambah produk SKU-001 nama beras unit kg harga beli 10000 harga jual 12000 stock 100 min 10
    const parts = rawBody.split(/\s+/);
    
    if (parts.length < 4) {
        return safeReply(msg,
            `📦 *Tambah Produk Baru*\n\n` +
            `Format:\n` +
            `*Tambah produk [SKU] [Nama] unit [satuan] beli [harga] jual [harga] stock [qty] min [qty]*\n\n` +
            `Contoh:\n` +
            `Tambah produk BRS-01 Beras Premium unit kg beli 10000 jual 12000 stock 100 min 10\n\n` +
            `Unit: kg, pcs, liter, box, dll\n` +
            `Stock & min: opsional`
        ), true;
    }
    
    // Parse data
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
    
    let nameEnd = parts.indexOf('unit');
    if (nameEnd === -1) nameEnd = parts.indexOf('beli');
    if (nameEnd === -1) nameEnd = parts.indexOf('stock');
    
    if (nameEnd > 3) {
        data.name = parts.slice(3, nameEnd).join(' ');
    }
    
    // Parse keywords
    for (let i = 0; i < parts.length; i++) {
        const w = parts[i].toLowerCase();
        if (w === 'unit' && parts[i + 1]) data.unit = parts[i + 1];
        if (w === 'beli' && parts[i + 1]) data.priceBuy = parseCurrency(parts[i + 1]);
        if (w === 'jual' && parts[i + 1]) data.priceSell = parseCurrency(parts[i + 1]);
        if (w === 'stock' && parts[i + 1]) data.stockInitial = parseFloat(parts[i + 1]);
        if (w === 'min' && parts[i + 1]) data.stockMin = parseFloat(parts[i + 1]);
        if (w === 'kategori' && parts[i + 1]) data.category = parts[i + 1];
    }
    
    if (!data.name) {
        return safeReply(msg, '❌ Nama produk wajib diisi.'), true;
    }
    
    const result = await stockManager.addProduct(user.id, data);
    
    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }
    
    return safeReply(msg,
        `✅ *Produk Berhasil Ditambahkan!*\n\n` +
        `📦 SKU     : ${result.product.sku}\n` +
        `📝 Nama    : ${result.product.name}\n` +
        `📊 Satuan  : ${result.product.unit}\n` +
        `💵 Beli    : ${formatRupiah(result.product.price_buy)}\n` +
        `💰 Jual    : ${formatRupiah(result.product.price_sell)}\n` +
        `📦 Stock   : ${stockManager.formatQty(result.product.stock_current, result.product.unit)} ${result.product.unit}\n` +
        `⚠️ Min     : ${stockManager.formatQty(result.product.stock_min, result.product.unit)} ${result.product.unit}\n\n` +
        `Ketik *Stock list* untuk lihat semua produk.`
    ), true;
}

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
    
    text += `Ketik *Stock info [SKU]* untuk detail produk.`;
    
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
        `Aksi:\n` +
        `*Masuk [SKU] [jumlah]* — tambah stock\n` +
        `*Keluar [SKU] [jumlah]* — kurangi stock\n` +
        `*Stock history [SKU]* — lihat riwayat`
    ), true;
}

async function handleStockIn(msg, user, rawBody, body) {
    // Format: masuk BRS-01 50 atau masuk BRS-01 50kg catatan pembelian baru
    const parts = rawBody.split(/\s+/);
    
    if (parts.length < 3) {
        return safeReply(msg, `❌ Format: *Masuk [SKU] [jumlah] [catatan]*\n\nContoh: Masuk BRS-01 50`), true;
    }
    
    const sku = parts[1];
    const qty = parseQuantity(parts[2]) || parseCurrency(parts[2]);
    
    if (!qty || qty <= 0) {
        return safeReply(msg, `❌ Jumlah tidak valid: "${parts[2]}"`), true;
    }
    
    const note = parts.slice(3).join(' ') || null;
    
    // Get product
    const prodResult = await stockManager.getProduct(user.id, sku);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${sku}" tidak ditemukan.\n\nKetik *Stock list* untuk lihat semua produk.`), true;
    }
    
    const product = prodResult.product;
    
    // Adjust stock
    const result = await stockManager.adjustStock(user.id, product.id, 'in', qty, {
        referenceType: 'manual',
        note,
    });
    
    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }
    
    return safeReply(msg,
        `✅ *Stock Masuk Berhasil!*\n\n` +
        `📦 ${product.name} (${product.sku})\n` +
        `➕ Masuk   : ${stockManager.formatQty(qty, product.unit)} ${product.unit}\n` +
        `📊 Sebelum : ${stockManager.formatQty(result.stockBefore, product.unit)} ${product.unit}\n` +
        `📊 Sekarang: ${stockManager.formatQty(result.stockAfter, product.unit)} ${product.unit}\n` +
        (note ? `\n📝 ${note}` : '')
    ), true;
}

async function handleStockOut(msg, user, rawBody, body) {
    // Format: keluar BRS-01 10
    const parts = rawBody.split(/\s+/);
    
    if (parts.length < 3) {
        return safeReply(msg, `❌ Format: *Keluar [SKU] [jumlah] [catatan]*\n\nContoh: Keluar BRS-01 10`), true;
    }
    
    const sku = parts[1];
    const qty = parseQuantity(parts[2]) || parseCurrency(parts[2]);
    
    if (!qty || qty <= 0) {
        return safeReply(msg, `❌ Jumlah tidak valid: "${parts[2]}"`), true;
    }
    
    const note = parts.slice(3).join(' ') || null;
    
    // Get product
    const prodResult = await stockManager.getProduct(user.id, sku);
    if (!prodResult.success) {
        return safeReply(msg, `❌ Produk "${sku}" tidak ditemukan.`), true;
    }
    
    const product = prodResult.product;
    
    // Adjust stock
    const result = await stockManager.adjustStock(user.id, product.id, 'out', qty, {
        referenceType: 'manual',
        note,
    });
    
    if (!result.success) {
        return safeReply(msg, `❌ ${result.error}`), true;
    }
    
    return safeReply(msg,
        `✅ *Stock Keluar Berhasil!*\n\n` +
        `📦 ${product.name} (${product.sku})\n` +
        `➖ Keluar  : ${stockManager.formatQty(qty, product.unit)} ${product.unit}\n` +
        `📊 Sebelum : ${stockManager.formatQty(result.stockBefore, product.unit)} ${product.unit}\n` +
        `📊 Sekarang: ${stockManager.formatQty(result.stockAfter, product.unit)} ${product.unit}\n` +
        (note ? `\n📝 ${note}` : '')
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

        // ── Media Processing (Voice & Image) ──
        if (!user.is_upgrading && msg.hasMedia) {
            try {
                const media = await msg.downloadMedia().catch(() => null);
                if (media) {
                    let extractedText = '';
                    if (media.mimetype.startsWith('audio/')) extractedText = await transcribeAudio(media);
                    else if (media.mimetype.startsWith('image/')) extractedText = await extractTextFromImage(media);

                    if (extractedText && extractedText.trim().length > 3) {
                        const mockMsg = { reply: async (t) => safeReply(msg, t) };
                        const txHandled = await handleTransaction(mockMsg, sender, user, effectiveStatus, extractedText, extractedText.toLowerCase());
                        if (txHandled) return;
                    }
                }
            } catch (err) {
                console.error(`[MEDIA] Gagal proses: ${err.message}`);
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

        // ── STOCK COMMANDS (Pro/Unlimited only) ──
        if (['pro', 'unlimited'].includes(effectiveStatus)) {
            if (body.startsWith('tambah produk') || body.startsWith('add produk')) {
                return handleStockAdd(msg, user, rawBody, body);
            }
            if (body === 'stock list' || body === 'daftar produk' || body === 'list produk') {
                return handleStockList(msg, user);
            }
            if (body.startsWith('stock info ') || body.startsWith('info produk ')) {
                return handleStockInfo(msg, user, rawBody);
            }
            if (body.startsWith('stock history ') || body.startsWith('riwayat ')) {
                // TODO: implement stock history
                return safeReply(msg, '🚧 Fitur riwayat stock akan segera tersedia.'), true;
            }
            if (body === 'stock report' || body === 'laporan stock') {
                return handleStockReport(msg, user);
            }
            // Stock IN/OUT harus cek keyword lebih ketat agar tidak bentrok dengan transaksi
            if (body.split(/\s+/).length >= 3) {
                const firstWord = body.split(/\s+/)[0];
                const secondWord = body.split(/\s+/)[1];
                
                // Hanya proses jika format jelas: masuk/keluar [SKU] [qty]
                // SKU biasanya huruf kapital atau mengandung dash/angka
                if ((firstWord === 'masuk' || firstWord === 'in') && /^[A-Z0-9\-]+$/i.test(secondWord)) {
                    return handleStockIn(msg, user, rawBody, body);
                }
                if ((firstWord === 'keluar' || firstWord === 'out') && /^[A-Z0-9\-]+$/i.test(secondWord)) {
                    return handleStockOut(msg, user, rawBody, body);
                }
            }
        } else if (KW_STOCK.some(k => body.includes(k))) {
            // Demo user coba akses stock
            return safeReply(msg, `🔒 *Fitur Stock Opname*\n\nFitur ini hanya tersedia untuk paket PRO & UNLIMITED.\n\nKetik *Paket* untuk upgrade.`), true;
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
                statusBlock = `🎯 Status  : *🆓 DEMO*\n📊 Hari ini: *${todayCount}/5 transaksi*\n💡 Ketik *Paket* untuk upgrade.`;
            } else if (effectiveStatus === 'pro') {
                const sisa = getDaysRemaining(user);
                statusBlock = `🎯 Status  : *⭐ PRO Bulanan*\n📅 Sisa    : *${sisa} hari*`;
            } else {
                statusBlock = `🎯 Status  : *💎 UNLIMITED Selamanya*`;
            }
            return safeReply(msg, `ℹ️ *Info Akun*\n\n🏪 Toko    : *${user.store_name}*\n📱 WA      : ${formatPhone(sender)}\n${statusBlock}`);
        }

        // ── Laporan ──
        if (KW_LAPORAN.some(k => body === k || body.startsWith(k))) {
            const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
            const sent = await sendReport(client, sender, user.store_name, 'Harian (Manual)', todayStart.toISOString());
            if (!sent) return safeReply(msg, `📊 *${user.store_name}*\n\nBelum ada transaksi hari ini Bos.\nMulai catat: *jual kopi 15rb*`);
            return;
        }

        // ── Bantuan ──
        if (KW_BANTUAN.some(k => body === k)) {
            let statusNote = '';
            if (effectiveStatus === 'demo') {
                const todayCount = await getDailyTransactionCount(sender);
                statusNote = `\n⚠️ Mode DEMO: *${todayCount}/5 transaksi* hari ini.\n`;
            } else if (effectiveStatus === 'pro') {
                const sisa = getDaysRemaining(user);
                statusNote = `\n⭐ PRO aktif, sisa *${sisa} hari*.\n`;
            } else {
                statusNote = `\n💎 UNLIMITED aktif selamanya.\n`;
            }
            
            let stockHelp = '';
            if (['pro', 'unlimited'].includes(effectiveStatus)) {
                stockHelp = `\n*📦 Stock Opname:*\n` +
                    `*Tambah produk [SKU] [Nama]...* — daftar produk baru\n` +
                    `*Stock list* — lihat semua produk\n` +
                    `*Stock info [SKU]* — detail produk\n` +
                    `*Masuk [SKU] [qty]* — tambah stock\n` +
                    `*Keluar [SKU] [qty]* — kurangi stock\n` +
                    `*Stock report* — laporan nilai stock\n`;
            }
            
            return safeReply(msg, `📚 *Panduan Bot - ${user.store_name}*\n${statusNote}\n*💰 Catat Transaksi (ketik langsung):*\n🟢 Masuk : *Jual kopi 50rb*\n🔴 Keluar: *Beli kain 1.5jt*\n\n*Format angka:* 20rb • 1.5jt • 20.000 • 20k\n\n*📋 Perintah tersedia:*\n📊 *Laporan*  — Rekap transaksi hari ini\nℹ️ *Status*   — Info & status akun\n💰 *Paket*    — Lihat & pilih paket upgrade\n📚 *Bantuan*  — Tampilkan menu ini${stockHelp}`);
        }

        // ── Coba parsing transaksi ──
        const txHandled = await handleTransaction(msg, sender, user, effectiveStatus, rawBody, body);
        if (txHandled) return;

        // ── CATCH-ALL ──
        return safeReply(msg, `Halo Bos *${user.store_name}*! 👋\n\nMaaf, saya belum paham maksud Bos. 😅\n\nYang bisa saya bantu:\n📝 *Jual kopi 15rb* — catat pemasukan\n📝 *Beli gula 20rb* — catat pengeluaran\n📚 *Bantuan* — lihat semua panduan\n📊 *Laporan* — lihat rekap hari ini`);

    } catch (err) {
        console.error(`[ERROR] handleMessage [${sender}]: ${err.message}\n${err.stack}`);
        safeReply(msg, `⚠️ Ada gangguan teknis Bos. Coba lagi ya.\nJika masalah berlanjut, ketik *Bantuan*.`);
    }
}

module.exports = { handleMessage, invalidateMaintenanceCache };