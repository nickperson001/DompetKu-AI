'use strict';
const supabase = require('../config/supabase');
const { sendReport } = require('../jobs/scheduler');
const { transcribeAudio, extractTextFromImage } = require('../utils/mediaProcessor');

// ════════════════════════════════════════════════════════════
// KONFIGURASI PAKET
// ════════════════════════════════════════════════════════════
const PACKAGES = {
  pro: {
    key      : 'pro',
    label    : 'PRO Bulanan',
    emoji    : '⭐',
    price    : 29_000,
    priceStr : 'Rp 29.000/bulan',
    duration : 30,
    features : [
      'Transaksi tanpa batas per hari',
      'Laporan mingguan otomatis',
      'Berlaku 30 hari, bisa diperpanjang',
    ],
  },
  unlimited: {
    key      : 'unlimited',
    label    : 'UNLIMITED Selamanya',
    emoji    : '💎',
    price    : 299_000,
    priceStr : 'Rp 299.000 (sekali bayar)',
    duration : null,
    features : [
      'Transaksi tanpa batas per hari',
      'Semua laporan otomatis (harian, mingguan, bulanan)',
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
  clean = clean.replace(/^rp.?/, '');
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
    const dotCount = (clean.match(/\./g) || []).length;
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

// ════════════════════════════════════════════════════════════
// SUB-HANDLERS
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

  for (const word of rawBody.split(/\s+/)) {
    const val = parseCurrency(word);
    if (val !== null && amount === null) amount = val;
    else descWords.push(word);
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

  return safeReply(msg, `${emoji} *Berhasil Dicatat!*\n\n${tipeLabel}\n💵 Jumlah : ${formatRupiah(amount)}\n📝 Ket    : ${finalDesc}${extraInfo}\n\n📩 Notifikasi otomatis telah dikirim ke database.`), true;
}

// ════════════════════════════════════════════════════════════
// MAIN HANDLER — PIPELINE UTAMA
// ════════════════════════════════════════════════════════════
async function handleMessage(msg, client) {
  if (!msg) return;
  if (msg.from === 'status@broadcast') return;
  if (msg.from.includes('@g.us')) return;
  if (msg.from.includes('-')) return;

  const sender = msg.from;
  const rawBody = (msg.body || '').trim();
  const body = rawBody.toLowerCase();

  await supabase.from('activity_logs').insert([{
    user_id: sender,
    action: body.includes('jual') || body.includes('beli') ? 'transaksi' : body === 'status' ? 'status' : body === 'paket' ? 'upgrade' : 'chat',
    details: rawBody.substring(0, 100)
  }]);
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

    // ── STEP 3.5: Pemrosesan Media (Voice Note & Foto Nota) ─────────
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
            if (txHandled) return; // Transaksi berhasil dicatat dari media
          }
        }
      } catch (err) {
        console.error(`[MEDIA] Gagal proses: ${err.message}`);
      }
    }

    // ── STEP 4: Bukti transfer (user sedang upgrade & kirim foto) ──
    if (user.is_upgrading && msg.hasMedia) return handleTransferProof(msg, client, sender, user);

    // ── STEP 5: Pesan saat is_upgrading tapi bukan foto ───────────
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

    // ── STEP 6: Perintah paket / upgrade ──────────────────────────
    if (KW_UPGRADE.some(k => body === k) || body === 'paket') return showUpgradeMenu(msg, user, effectiveStatus);
    if (body.startsWith('pilih ')) {
      const handled = await handlePackageSelection(msg, sender, user, body);
      if (handled) return;
    }
    if (KW_BATAL.some(k => body === k)) return safeReply(msg, `Tidak ada proses yang sedang berjalan Bos. 😊\n\nKetik *Bantuan* untuk melihat menu.`);

    // ── STEP 7: Perintah status ───────────────────────────────────
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

    // ── STEP 8: Perintah laporan ──────────────────────────────────
    if (KW_LAPORAN.some(k => body === k || body.startsWith(k))) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const sent = await sendReport(client, sender, user.store_name, 'Harian (Manual)', todayStart.toISOString());
      if (!sent) return safeReply(msg, `📊 *${user.store_name}*\n\nBelum ada transaksi hari ini Bos.\nMulai catat: *jual kopi 15rb*`);
      return;
    }

    // ── STEP 9: Perintah bantuan ──────────────────────────────────
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
      return safeReply(msg, `📚 *Panduan Bot - ${user.store_name}*\n${statusNote}\n*💰 Catat Transaksi (ketik langsung):*\n🟢 Masuk : *Jual kopi 50rb*\n🔴 Keluar: *Beli kain 1.5jt*\n\n*Format angka:* 20rb • 1.5jt • 20.000 • 20k\n\n*📋 Perintah tersedia:*\n📊 *Laporan*  — Rekap transaksi hari ini\nℹ️ *Status*   — Info & status akun\n💰 *Paket*    — Lihat & pilih paket upgrade\n📚 *Bantuan*  — Tampilkan menu ini`);
    }

    // ── STEP 10: Coba parsing transaksi ───────────────────────────
    const txHandled = await handleTransaction(msg, sender, user, effectiveStatus, rawBody, body);
    if (txHandled) return;

    // ── STEP 11: CATCH-ALL ────────────────────────────────────────
    return safeReply(msg, `Halo Bos *${user.store_name}*! 👋\n\nMaaf, saya belum paham maksud Bos. 😅\n\nYang bisa saya bantu:\n📝 *Jual kopi 15rb* — catat pemasukan\n📝 *Beli gula 20rb* — catat pengeluaran\n📚 *Bantuan* — lihat semua panduan\n📊 *Laporan* — lihat rekap hari ini`);

  } catch (err) {
    console.error(`[ERROR] handleMessage [${sender}]: ${err.message}\n${err.stack}`);
    safeReply(msg, `⚠️ Ada gangguan teknis Bos. Coba lagi ya.\nJika masalah berlanjut, ketik *Bantuan*.`);
  }
}

module.exports = { handleMessage, invalidateMaintenanceCache };