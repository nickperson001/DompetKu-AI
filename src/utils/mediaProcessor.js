'use strict';

/**
 * mediaProcessor.js — v2.0
 * Handler untuk Voice Note (audio) dan Foto Struk (image)
 *
 * VALIDASI LENGKAP:
 * - Ukuran file maksimal (audio: 10MB, image: 8MB)
 * - Format MIME yang didukung
 * - Guard HF_TOKEN sebelum panggil API
 * - Timeout per request ke Hugging Face
 * - Pre-processing image bertingkat untuk akurasi OCR
 * - Logging terstruktur untuk debugging
 */

const path   = require('path');
const crypto = require('crypto');
const fs     = require('fs/promises');
const fsSync = require('fs');
const os     = require('os');

// ── Conditional imports (graceful jika module tidak terinstall) ──
let HfInference, Tesseract, sharp;
try { ({ HfInference } = require('@huggingface/inference')); } catch (_) {}
try { Tesseract = require('tesseract.js'); } catch (_) {}
try { sharp = require('sharp'); } catch (_) {}

// ════════════════════════════════════════════════════════════
// KONFIGURASI
// ════════════════════════════════════════════════════════════
const CONFIG = {
    tmpDir         : os.tmpdir(), // ✅ FIX: os.tmpdir() writable di semua OS/Railway

    // Audio
    audio: {
        maxSizeBytes  : 10 * 1024 * 1024,  // 10 MB
        timeoutMs     : 45_000,             // 45 detik timeout ke HF
        model         : 'openai/whisper-large-v3',
        language      : 'id',
        supportedMimes: [
            'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac',
            'audio/wav', 'audio/webm', 'audio/opus', 'audio/x-m4a',
            'audio/3gp', 'audio/amr', 'video/ogg',  // WA kirim voice sebagai video/ogg kadang
        ],
    },

    // Image
    image: {
        maxSizeBytes  : 8 * 1024 * 1024,   // 8 MB
        timeoutMs     : 30_000,             // 30 detik timeout OCR
        tesseractLang : 'ind+eng',
        minTextLength : 5,                  // Minimum karakter hasil OCR agar dianggap valid
        supportedMimes: [
            'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
            'image/gif',  'image/bmp', 'image/tiff',
        ],
        // Pre-processing chains
        preProcess: {
            // Chain 1: standar untuk struk printer thermal
            thermal: (s) => s.grayscale().normalize().sharpen({ sigma: 1.5 }).threshold(150),
            // Chain 2: untuk foto struk dari kamera HP
            photo  : (s) => s.grayscale().normalize().sharpen({ sigma: 1.2 }).linear(1.3, -20),
            // Chain 3: fallback minimal
            minimal: (s) => s.grayscale().normalize(),
        },
    },
};

// ── Inisialisasi HF client (lazy, guard token) ──────────────
let _hfClient = null;
function getHFClient() {
    if (!process.env.HF_TOKEN) {
        throw new Error('HF_TOKEN tidak diset di environment variables.');
    }
    if (!HfInference) {
        throw new Error('Package @huggingface/inference tidak terinstall.');
    }
    if (!_hfClient) _hfClient = new HfInference(process.env.HF_TOKEN);
    return _hfClient;
}

// ── Pastikan tmp dir ada ────────────────────────────────────
try {
    if (!fsSync.existsSync(CONFIG.tmpDir)) {
        fsSync.mkdirSync(CONFIG.tmpDir, { recursive: true });
    }
} catch (_) {}

// ════════════════════════════════════════════════════════════
// HELPERS INTERNAL
// ════════════════════════════════════════════════════════════

/**
 * Hitung ukuran base64 dalam bytes
 */
function base64SizeBytes(b64) {
    if (!b64) return 0;
    const padding = (b64.match(/=/g) || []).length;
    return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Buat nama file temp yang unik
 */
function tmpFilePath(ext) {
    return path.join(CONFIG.tmpDir, `${crypto.randomUUID()}.${ext}`);
}

/**
 * Hapus file temp (fire-and-forget, tidak crash)
 */
async function cleanupFile(filePath) {
    if (!filePath) return;
    try { await fs.unlink(filePath); } catch (_) {}
}

/**
 * Promise dengan timeout
 */
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout (${ms / 1000}s) saat ${label}`)), ms)
        ),
    ]);
}

/**
 * Log terstruktur
 */
function log(level, context, message, extra = {}) {
    const ts = new Date().toISOString();
    const extra_str = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
    console[level === 'error' ? 'error' : 'log'](`[${ts}] [${level.toUpperCase()}] [${context}] ${message}${extra_str}`);
}

// ════════════════════════════════════════════════════════════
// VALIDASI MEDIA
// ════════════════════════════════════════════════════════════

/**
 * Hasil validasi: { valid, error, sizeBytes, ext }
 */
function validateAudio(mediaObj) {
    if (!mediaObj || !mediaObj.data) {
        return { valid: false, error: 'Data audio kosong atau tidak valid.' };
    }

    const mime      = (mediaObj.mimetype || '').toLowerCase();
    const sizeBytes = base64SizeBytes(mediaObj.data);

    // Validasi MIME — toleran: jika mengandung 'audio' atau 'ogg' anggap valid
    const isKnownMime = CONFIG.audio.supportedMimes.includes(mime);
    const looksAudio  = mime.includes('audio') || mime.includes('ogg') || mime.includes('opus');
    if (!isKnownMime && !looksAudio) {
        return { valid: false, error: `Format audio tidak didukung: ${mime}` };
    }

    // Validasi ukuran
    if (sizeBytes > CONFIG.audio.maxSizeBytes) {
        const mb = (sizeBytes / 1024 / 1024).toFixed(1);
        return { valid: false, error: `Ukuran audio terlalu besar (${mb}MB). Maksimal 10MB.` };
    }
    if (sizeBytes < 100) {
        return { valid: false, error: 'Audio terlalu pendek atau kosong.' };
    }

    // Tentukan ekstensi file temp
    const extMap = {
        'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
        'audio/wav': 'wav',  'audio/webm': 'webm', 'audio/ogg': 'ogg',
        'audio/opus': 'ogg', 'audio/x-m4a': 'm4a', 'video/ogg': 'ogg',
    };
    const ext = extMap[mime] || 'ogg';

    return { valid: true, sizeBytes, ext, mime };
}

function validateImage(mediaObj) {
    if (!mediaObj || !mediaObj.data) {
        return { valid: false, error: 'Data gambar kosong atau tidak valid.' };
    }

    const mime      = (mediaObj.mimetype || '').toLowerCase();
    const sizeBytes = base64SizeBytes(mediaObj.data);

    const isKnownMime = CONFIG.image.supportedMimes.includes(mime);
    const looksImage  = mime.includes('image');
    if (!isKnownMime && !looksImage) {
        return { valid: false, error: `Format gambar tidak didukung: ${mime}` };
    }

    if (sizeBytes > CONFIG.image.maxSizeBytes) {
        const mb = (sizeBytes / 1024 / 1024).toFixed(1);
        return { valid: false, error: `Ukuran gambar terlalu besar (${mb}MB). Maksimal 8MB.` };
    }
    if (sizeBytes < 500) {
        return { valid: false, error: 'Gambar terlalu kecil atau rusak.' };
    }

    return { valid: true, sizeBytes, mime };
}

// ════════════════════════════════════════════════════════════
// POST-PROCESSING TEXT
// ════════════════════════════════════════════════════════════

/**
 * Bersihkan hasil OCR / transcription
 * - Hapus karakter noise
 * - Normalisasi spasi & baris
 * - Hapus baris kosong berlebihan
 */
function cleanOcrText(raw) {
    if (!raw) return '';
    let text = raw
        .replace(/[\r]/g, '\n')
        .replace(/[|}{\\<>@#^~`]/g, ' ')      // noise karakter OCR umum
        .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, ' ') // non-printable
        .replace(/ {3,}/g, ' ')              // spasi berlebihan
        .replace(/\n{4,}/g, '\n\n')          // baris kosong berlebihan
        .replace(/^\s+|\s+$/gm, '')          // trim per baris
        .trim();

    // ✅ FIX nominal OCR: "l00" → "100", "l.l00" → "1.100", "0O0" → "000"
    // Huruf l/I/O sering dibaca sebagai angka di OCR struk thermal
    text = text.replace(/(?<=[\d.,])l(?=[\d.,])/g, '1');  // "1l0" → "110"
    text = text.replace(/(?<=[\d.,])I(?=[\d.,])/g, '1');  // "1I0" → "110"
    text = text.replace(/(?<=\d)O(?=\d)/g, '0');           // "1O0" → "100"
    text = text.replace(/\bl(?=\d)/g, '1');                 // "l00" → "100"
    text = text.replace(/\bO(?=\d)/g, '0');                 // "O00" → "000"

    // Batasi panjang output agar tidak membebani parser transaksi
    if (text.length > 800) text = text.substring(0, 800);

    return text;
}

function cleanTranscriptText(raw) {
    if (!raw) return '';
    return raw
        .replace(/[^\w\s.,!?;:()/\-+Rp0-9]/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
}

/**
 * Deteksi apakah teks hasil OCR/transcribe mengandung info transaksi keuangan
 * Return: { hasTransaction, confidence }
 */
function detectTransactionInText(text) {
    if (!text || text.length < 3) return { hasTransaction: false, confidence: 0 };

    const lower = text.toLowerCase();
    let score   = 0;

    // Ada angka yang bisa jadi nominal
    const hasNumber = /\d{3,}/.test(text);
    if (hasNumber) score += 30;

    // Ada kata keuangan
    const finWords = ['rp', 'total', 'bayar', 'harga', 'jual', 'beli', 'masuk', 'keluar',
                      'tunai', 'cash', 'transfer', 'debit', 'kredit', 'kembalian', 'jumlah',
                      'subtotal', 'diskon', 'pajak', 'ppn', 'nota', 'struk', 'receipt', 'invoice'];
    const wordHits = finWords.filter(w => lower.includes(w)).length;
    score += wordHits * 10;

    // Ada format Rp
    if (/rp\s*[\d.,]+/i.test(text)) score += 25;
    if (/[\d.,]{4,}/.test(text))     score += 10;

    return { hasTransaction: score >= 30, confidence: Math.min(100, score) };
}

// ════════════════════════════════════════════════════════════
// MAIN: TRANSCRIBE AUDIO (Voice Note)
// ════════════════════════════════════════════════════════════

/**
 * Transkrip voice note ke teks
 *
 * @param {object} mediaObj - {data: base64, mimetype: string}
 * @returns {object} { success, text, error, source:'audio' }
 */
async function transcribeAudio(mediaObj) {
    const ctx      = 'AUDIO';
    const validation = validateAudio(mediaObj);

    if (!validation.valid) {
        log('warn', ctx, 'Validasi gagal', { error: validation.error });
        return { success: false, text: '', error: validation.error, source: 'audio' };
    }

    const { sizeBytes, ext, mime } = validation;
    log('info', ctx, 'Mulai transkrip', { sizeKB: Math.round(sizeBytes / 1024), mime });

    // Guard HF_TOKEN
    let hf;
    try {
        hf = getHFClient();
    } catch (err) {
        log('error', ctx, 'HF client gagal', { error: err.message });
        return { success: false, text: '', error: 'Fitur voice note tidak tersedia (HF_TOKEN belum diset).', source: 'audio' };
    }

    const filePath = tmpFilePath(ext);

    try {
        // Tulis file temp
        await fs.writeFile(filePath, Buffer.from(mediaObj.data, 'base64'));
        const audioBuffer = await fs.readFile(filePath);

        // Panggil Whisper API dengan timeout
        // ✅ FIX: Bungkus audioBuffer dalam Blob dengan explicit content-type
        // Tanpa ini HF API gagal dengan "Unable to determine the input's content-type"
        const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });
        const result = await withTimeout(
            hf.automaticSpeechRecognition({
                model     : CONFIG.audio.model,
                data      : audioBlob,
                parameters: { language: CONFIG.audio.language },
            }),
            CONFIG.audio.timeoutMs,
            'Whisper transcription'
        );

        const raw    = result?.text || '';
        const clean  = cleanTranscriptText(raw);

        if (!clean || clean.length < 2) {
            log('warn', ctx, 'Hasil transcribe kosong');
            return { success: false, text: '', error: 'Suara tidak terdeteksi atau terlalu pendek. Coba kirim ulang dengan lebih jelas.', source: 'audio' };
        }

        const detection = detectTransactionInText(clean);
        log('info', ctx, 'Transcribe berhasil', { length: clean.length, confidence: detection.confidence });

        return {
            success       : true,
            text          : clean,
            rawText       : raw,
            hasTransaction: detection.hasTransaction,
            confidence    : detection.confidence,
            source        : 'audio',
            error         : null,
        };

    } catch (err) {
        const isTimeout = err.message.includes('Timeout');
        const msg       = isTimeout
            ? 'Voice note terlalu panjang, coba kirim pesan singkat saja ya Bos.'
            : `Gagal memproses audio: ${err.message}`;

        log('error', ctx, 'Transcribe error', { error: err.message, isTimeout });
        return { success: false, text: '', error: msg, source: 'audio' };

    } finally {
        await cleanupFile(filePath);
    }
}

// ════════════════════════════════════════════════════════════
// MAIN: EXTRACT TEXT FROM IMAGE (Foto Struk/Nota)
// ════════════════════════════════════════════════════════════

/**
 * Ekstrak teks dari foto struk/nota menggunakan OCR
 *
 * @param {object} mediaObj - {data: base64, mimetype: string}
 * @returns {object} { success, text, error, source:'image' }
 */
async function extractTextFromImage(mediaObj) {
    const ctx        = 'IMAGE-OCR';
    const validation = validateImage(mediaObj);

    if (!validation.valid) {
        log('warn', ctx, 'Validasi gagal', { error: validation.error });
        return { success: false, text: '', error: validation.error, source: 'image' };
    }

    if (!sharp) {
        log('error', ctx, 'sharp tidak terinstall');
        return { success: false, text: '', error: 'Fitur scan struk tidak tersedia (modul sharp tidak ada).', source: 'image' };
    }

    if (!Tesseract) {
        log('error', ctx, 'tesseract.js tidak terinstall');
        return { success: false, text: '', error: 'Fitur scan struk tidak tersedia (modul tesseract tidak ada).', source: 'image' };
    }

    const { sizeBytes, mime } = validation;
    log('info', ctx, 'Mulai OCR', { sizeKB: Math.round(sizeBytes / 1024), mime });

    const rawBuffer = Buffer.from(mediaObj.data, 'base64');
    const results   = [];     // kumpulkan hasil dari beberapa pre-process chain

    // ── Jalankan 3 chain pre-processing, ambil hasil terbaik ──
    const chains = [
        { name: 'thermal', fn: CONFIG.image.preProcess.thermal },
        { name: 'photo',   fn: CONFIG.image.preProcess.photo   },
        { name: 'minimal', fn: CONFIG.image.preProcess.minimal },
    ];

    for (const chain of chains) {
        const filePath = tmpFilePath('jpg');
        try {
            // Pre-process image
            let sharpPipeline = sharp(rawBuffer).resize(1800, null, { withoutEnlargement: true });
            sharpPipeline     = chain.fn(sharpPipeline);
            const processed   = await sharpPipeline.jpeg({ quality: 95 }).toBuffer();

            await fs.writeFile(filePath, processed);

            // OCR
            const { data: { text, confidence } } = await withTimeout(
                Tesseract.recognize(filePath, CONFIG.image.tesseractLang, { logger: () => {} }),
                CONFIG.image.timeoutMs,
                `OCR chain ${chain.name}`
            );

            const clean      = cleanOcrText(text);
            const detection  = detectTransactionInText(clean);

            log('info', ctx, `Chain ${chain.name}`, { len: clean.length, confidence: Math.round(confidence), txConf: detection.confidence });

            if (clean.length >= CONFIG.image.minTextLength) {
                results.push({ text: clean, ocrConf: confidence, txConf: detection.confidence, chain: chain.name, detection });
            }

        } catch (err) {
            log('warn', ctx, `Chain ${chain.name} gagal`, { error: err.message });
        } finally {
            await cleanupFile(filePath);
        }

        // Early exit: jika sudah dapat hasil dengan confidence tinggi, tidak perlu chain lagi
        const best = results.find(r => r.txConf >= 60);
        if (best) break;
    }

    if (!results.length) {
        log('warn', ctx, 'Semua chain OCR gagal menghasilkan teks');
        return {
            success: false,
            text   : '',
            error  : 'Tidak ada teks terdeteksi di gambar. Pastikan foto struk cukup terang dan tidak buram.',
            source : 'image',
        };
    }

    // Pilih hasil dengan txConf tertinggi, tiebreak dengan ocrConf
    results.sort((a, b) => b.txConf - a.txConf || b.ocrConf - a.ocrConf);
    const best = results[0];

    log('info', ctx, 'OCR selesai', { chain: best.chain, len: best.text.length, txConf: best.txConf });

    return {
        success       : true,
        text          : best.text,
        hasTransaction: best.detection.hasTransaction,
        confidence    : best.txConf,
        ocrConfidence : Math.round(best.ocrConf),
        chain         : best.chain,
        source        : 'image',
        error         : null,
    };
}

// ════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════
module.exports = {
    transcribeAudio,
    extractTextFromImage,
    validateAudio,
    validateImage,
    detectTransactionInText,
};