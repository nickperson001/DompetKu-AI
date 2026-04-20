'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const qrcodeWeb = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session   = require('express-session');
const { Pool }  = require('pg');
const pgSession = require('connect-pg-simple')(session);
const os        = require('os');
const path      = require('path');
const fs        = require('fs');
require('dotenv').config();

const { handleMessage }  = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase           = require('./src/config/supabase');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});
const port = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// SESSION STORE — PostgreSQL dengan fallback ke memory
// ════════════════════════════════════════════════════════════
let pgPool = null;

if (process.env.DATABASE_URL) {
    try {
        pgPool = new Pool({
            connectionString       : process.env.DATABASE_URL,
            ssl                    : process.env.NODE_ENV === 'production'
                                     ? { rejectUnauthorized: false } : false,
            max                    : 5,
            idleTimeoutMillis      : 30000,
            connectionTimeoutMillis: 5000,
        });
        console.log('[SESSION] PostgreSQL pool created');
    } catch (err) {
        console.error('[SESSION] Pool failed:', err.message);
    }
}

function buildSessionMiddleware() {
    const base = {
        secret           : process.env.SESSION_SECRET || 'dompetku-secret-32chars-ganti-ini!',
        resave           : false,
        saveUninitialized: false,
        cookie: {
            secure  : process.env.NODE_ENV === 'production',
            maxAge  : 30 * 24 * 60 * 60 * 1000, // 30 hari
            httpOnly: true,
            sameSite: 'lax',
        },
    };

    if (!pgPool) {
        console.warn('[SESSION] ⚠️  Pakai memory store — set DATABASE_URL untuk session persisten');
        return session(base);
    }

    try {
        const store = new pgSession({
            pool                : pgPool,
            tableName           : 'user_sessions',
            createTableIfMissing: true,
            errorLog            : (err) => console.error('[SESSION] Store error:', err.message),
        });
        console.log('[SESSION] ✅ PostgreSQL session store aktif');
        return session({ ...base, store });
    } catch (err) {
        console.error('[SESSION] Fallback ke memory store:', err.message);
        return session(base);
    }
}

const sessionMiddleware = buildSessionMiddleware();

// ════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files: hanya subfolder assets/ yang bebas diakses
// index.html dan login.html TIDAK lewat static agar auth bisa dikontrol
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════
let botStatus        = 'Initializing';
let currentQR        = '';
let clientReady      = false;
let maintenanceMode  = false;
let waClient         = null;
let systemLogs       = [];
const activeBroadcasts = new Map();

const addLog = (level, message, data = {}) => {
    const log = {
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    };
    systemLogs.unshift(log);
    if (systemLogs.length > 1000) systemLogs.pop();
    // Emit ke socket — bungkus try/catch agar tidak crash sebelum io siap
    try { io.emit('system_log', log); } catch (_) {}
    console.log(`[${level.toUpperCase()}] ${message}`);
};

// ════════════════════════════════════════════════════════════
// PING — Selalu 200, DIPAKAI Railway healthcheck
// Server hidup = ping respond = healthcheck PASS
// Tidak bergantung status WA atau database
// ════════════════════════════════════════════════════════════
app.get('/ping', (req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
});

// ════════════════════════════════════════════════════════════
// HEALTH — Detail status, untuk monitoring saja
// SELALU return 200 agar Railway tidak kill pod
// ════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    const used = process.memoryUsage();
    let dbStatus = 'unknown';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
    } catch (_) {
        dbStatus = 'error';
    }

    res.status(200).json({
        status   : 'running',
        bot      : botStatus,
        ready    : clientReady,
        timestamp: new Date().toISOString(),
        uptime   : Math.floor(process.uptime()),
        database : dbStatus,
        session  : pgPool ? 'postgresql' : 'memory',
        system   : {
            memory: {
                used      : Math.round(used.heapUsed / 1024 / 1024),
                total     : Math.round(used.heapTotal / 1024 / 1024),
                percentage: Math.round((used.heapUsed / used.heapTotal) * 100),
            },
            cpu     : os.loadavg(),
            platform: os.platform(),
        },
    });
});

// ════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════
const isAdmin = (req, res, next) => {
    if (req.session && req.session.authenticated) return next();
    const wantsJSON =
        req.xhr ||
        (req.headers['accept'] || '').includes('application/json') ||
        req.path.startsWith('/api/');
    if (wantsJSON) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');
};

// ════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════════
app.get('/login', (req, res) => {
    // Jika sudah login langsung ke dashboard
    if (req.session && req.session.authenticated) {
        return res.redirect('/');
    }
    // Kirim file login.html dari folder public/
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body || {};

    // Validasi body tidak kosong
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username dan password wajib diisi' });
    }

    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';

    console.log(`[AUTH] Login: "${username}" dari ${req.ip}`);

    if (username === validUser && password === validPass) {
        req.session.authenticated = true;
        req.session.loginAt       = new Date().toISOString();
        addLog('info', `Admin login OK dari ${req.ip}`);
        return res.json({ success: true });
    }

    addLog('warn', `Login gagal: "${username}" dari ${req.ip}`);
    res.status(401).json({ success: false });
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// ════════════════════════════════════════════════════════════
// PROTECTED ROUTES
// ════════════════════════════════════════════════════════════
app.get('/', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Users dengan pagination + search + filter
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page)   || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 20);
        const search = (req.query.search || '').trim();
        const status = req.query.status || 'all';

        let query = supabase.from('users').select('*', { count: 'exact' });
        if (status !== 'all') query = query.eq('status', status);
        if (search) {
            query = query.or(`store_name.ilike.%${search}%,id.ilike.%${search}%`);
        }

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range((page - 1) * limit, page * limit - 1);

        if (error) throw error;

        res.json({
            users     : data || [],
            pagination: {
                page,
                limit,
                total     : count || 0,
                totalPages: Math.ceil((count || 0) / limit),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update status user
app.post('/api/admin/user/:id/status', isAdmin, async (req, res) => {
    const { id }     = req.params;
    const { status } = req.body;

    if (!['demo', 'pro', 'unlimited'].includes(status)) {
        return res.status(400).json({ error: 'Status tidak valid' });
    }

    try {
        const updates = {
            status,
            upgrade_notified       : false,
            is_upgrading           : false,
            upgrade_package        : null,
            subscription_expires_at: status === 'pro'
                ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                : null,
        };

        const { error } = await supabase.from('users').update(updates).eq('id', id);
        if (error) throw error;

        // Kirim notifikasi WA jika bot online
        if (clientReady && waClient) {
            const notifs = {
                demo     : 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).',
                pro      : '🎉 Selamat! Akun PRO aktif 30 hari. ⭐',
                unlimited: '💎 Selamat! Akun UNLIMITED aktif seumur hidup!',
            };
            waClient.sendMessage(id, notifs[status])
                .catch(e => addLog('warn', `WA notif gagal: ${e.message}`));
        }

        addLog('info', `User ${id} → ${status}`);
        io.emit('user_updated', { id, status });
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle maintenance mode
app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
    const { enabled } = req.body;
    try {
        await supabase.from('settings')
            .upsert({ key: 'maintenance_mode', value: String(Boolean(enabled)) });

        maintenanceMode = Boolean(enabled);
        addLog('info', `Maintenance: ${maintenanceMode ? 'ON' : 'OFF'}`);
        res.json({ success: true, maintenance: maintenanceMode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Broadcast
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    const { message, target } = req.body;
    if (!message?.trim()) {
        return res.status(400).json({ error: 'Message diperlukan' });
    }
    if (!clientReady || !waClient) {
        return res.status(503).json({ error: 'Bot belum online — scan QR dulu' });
    }

    try {
        let query = supabase.from('users').select('id, store_name');
        if (target && target !== 'all') query = query.eq('status', target);
        const { data: users, error } = await query;
        if (error) throw error;

        const jobId = Date.now().toString();
        const job   = {
            id    : jobId,
            total : users.length,
            sent  : 0,
            failed: 0,
            status: 'running',
            target: target || 'all',
        };
        activeBroadcasts.set(jobId, job);
        processBroadcast(jobId, users, message);

        addLog('info', `Broadcast dimulai → ${users.length} user [${target || 'all'}]`);
        res.json({ success: true, jobId, total: users.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/broadcast/:id', isAdmin, (req, res) => {
    const job = activeBroadcasts.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });
    res.json(job);
});

async function processBroadcast(jobId, users, message) {
    const job = activeBroadcasts.get(jobId);
    for (let i = 0; i < users.length; i++) {
        try {
            const text = message
                .replace(/\{nama\}/gi,      users[i].store_name)
                .replace(/\{nama_toko\}/gi, users[i].store_name);
            if (waClient) await waClient.sendMessage(users[i].id, text);
            job.sent++;
        } catch (_) {
            job.failed++;
        }

        if (i % 5 === 0 || i === users.length - 1) {
            job.progress = Math.round(((i + 1) / users.length) * 100);
            io.emit('broadcast_progress', {
                jobId,
                current: i + 1,
                total  : users.length,
                sent   : job.sent,
                failed : job.failed,
            });
        }
        await new Promise(r => setTimeout(r, 1200));
    }
    job.status      = 'completed';
    job.completedAt = new Date().toISOString();
    io.emit('broadcast_complete', { jobId, ...job });
    addLog('info', `Broadcast selesai: ${job.sent} terkirim, ${job.failed} gagal`);
}

// System logs
app.get('/api/admin/logs', isAdmin, (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    res.json(systemLogs.slice(0, limit));
});

// Bot status
app.get('/api/admin/status', isAdmin, (req, res) => {
    res.json({
        status     : botStatus,
        ready      : clientReady,
        qr         : currentQR,
        maintenance: maintenanceMode,
    });
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO — Gunakan sessionMiddleware yang sama dengan Express
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', (socket) => {
    const isAuth = socket.request.session?.authenticated;
    addLog('info', `WS: ${socket.id} [${isAuth ? 'admin' : 'guest'}]`);

    // Kirim state bot saat ini — QR harus tampil meski belum login
    socket.emit('bot_update', {
        status: botStatus,
        qr    : currentQR,
        ready : clientReady,
    });

    // Log history hanya untuk admin
    if (isAuth) {
        socket.emit('logs_history', systemLogs.slice(0, 50));
    }

    socket.on('request_reconnect', () => {
        if (!clientReady) {
            addLog('info', 'Manual reconnect diminta');
            initWhatsApp();
        }
    });

    socket.on('disconnect', () => {
        addLog('info', `WS disconnect: ${socket.id}`);
    });
});

// ════════════════════════════════════════════════════════════
// WHATSAPP — Session persistence ke Supabase
// ════════════════════════════════════════════════════════════
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || '/tmp/wa-session';

try {
    if (!fs.existsSync(WA_SESSION_DIR)) {
        fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
        console.log(`[WA] Session dir dibuat: ${WA_SESSION_DIR}`);
    }
} catch (e) {
    console.error('[WA] Gagal buat session dir:', e.message);
}

async function saveSessionToDB(sessionData) {
    if (!sessionData) return;
    try {
        const { error } = await supabase.from('wa_sessions').upsert({
            id        : 'main',
            data      : JSON.stringify(sessionData),
            updated_at: new Date().toISOString(),
        });
        if (error) console.error('[WA-SESSION] Save error:', error.message);
        else console.log('[WA-SESSION] ✅ Session disimpan ke DB');
    } catch (e) {
        console.error('[WA-SESSION] Save gagal:', e.message);
    }
}

// ════════════════════════════════════════════════════════════
// INIT WHATSAPP — Fungsi terpisah agar bisa di-retry
// ════════════════════════════════════════════════════════════
function initWhatsApp() {
    addLog('info', '🔄 Memulai inisialisasi WhatsApp...');
    botStatus = 'Initializing';
    try { io.emit('bot_update', { status: botStatus, qr: '', ready: false }); } catch (_) {}

    // Deteksi Chromium path di sistem
    const chromiumCandidates = [
        process.env.PUPPETEER_EXEC_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ].filter(Boolean);

    let executablePath;
    for (const p of chromiumCandidates) {
        if (fs.existsSync(p)) {
            executablePath = p;
            console.log(`[WA] Chromium ditemukan: ${p}`);
            break;
        }
    }

    if (!executablePath) {
        addLog('warn', '⚠️ Chromium tidak ditemukan — mencoba default Puppeteer path');
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: WA_SESSION_DIR,
            clientId: 'dompetku',
        }),
        puppeteer: {
            headless      : true,
            executablePath: executablePath || undefined,
            args          : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--mute-audio',
                '--safebrowsing-disable-auto-update',
                '--disable-features=TranslateUI',
            ],
            timeout: 120_000, // 2 menit untuk startup Chromium
        },
        restartOnAuthFail: true,
        qrMaxRetries     : 10,
    });

    // ── QR Generated ──────────────────────────────────────
    client.on('qr', async (qr) => {
        botStatus   = 'Scan QR';
        clientReady = false;
        try {
            currentQR = await qrcodeWeb.toDataURL(qr);
        } catch (_) {}
        addLog('warn', '📱 QR Code siap — buka dashboard dan scan dengan WhatsApp');
        io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
    });

    // ── Loading Screen ────────────────────────────────────
    client.on('loading_screen', (percent, message) => {
        addLog('info', `WA Loading: ${percent}% — ${message}`);
    });

    // ── Authenticated ─────────────────────────────────────
    client.on('authenticated', async (sessionData) => {
        addLog('info', '🔐 WhatsApp authenticated');
        if (sessionData) await saveSessionToDB(sessionData);
    });

    // ── Auth Failure ──────────────────────────────────────
    client.on('auth_failure', (reason) => {
        addLog('error', `❌ Auth failure: ${reason}`);
        botStatus   = 'Auth Failed';
        clientReady = false;
        currentQR   = '';
        waClient    = null;
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });
    });

    // ── Ready ─────────────────────────────────────────────
    client.on('ready', () => {
        botStatus   = 'Online';
        clientReady = true;
        currentQR   = '';
        waClient    = client;
        addLog('info', '🟢 WhatsApp ONLINE & siap menerima pesan');
        io.emit('bot_update', { status: botStatus, qr: null, ready: true });

        // Init scheduler setelah bot ready
        try {
            initSchedulers(client);
        } catch (e) {
            addLog('error', `Scheduler init gagal: ${e.message}`);
        }
    });

    // ── Message Handler ───────────────────────────────────
    client.on('message', async (msg) => {
        if (maintenanceMode && !msg.fromMe) {
            msg.reply('🛠️ Sistem sedang dalam perbaikan. Harap tunggu sebentar.').catch(() => {});
            return;
        }
        try {
            addLog('info', `MSG ← ${msg.from}`, { body: (msg.body || '').substring(0, 50) });
            await handleMessage(msg, client);
            io.emit('new_log', {
                from     : msg.from,
                body     : msg.body,
                timestamp: new Date().toISOString(),
            });
        } catch (err) {
            addLog('error', `Message handler error: ${err.message}`);
        }
    });

    // ── Disconnected ──────────────────────────────────────
    client.on('disconnected', (reason) => {
        botStatus   = 'Disconnected';
        clientReady = false;
        waClient    = null;
        addLog('error', `🔴 WA Terputus: ${reason}`);
        io.emit('bot_update', { status: botStatus, ready: false });

        // Auto-reconnect setelah 10 detik
        setTimeout(() => {
            addLog('info', '🔄 Auto-reconnect...');
            initWhatsApp();
        }, 10_000);
    });

    // ── Initialize — error tidak crash server utama ───────
    client.initialize().catch((err) => {
        addLog('error', `WA initialize error: ${err.message}`);
        botStatus   = 'Error';
        clientReady = false;
        waClient    = null;
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });

        // Retry setelah 30 detik
        setTimeout(() => {
            addLog('info', '🔄 Retry WA init...');
            initWhatsApp();
        }, 30_000);
    });
}

// ════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// Process TIDAK boleh crash — Railway akan restart dari awal
// ════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException: ${err.message}`);
    console.error(err.stack);
    addLog('error', `uncaughtException: ${err.message}`);
    // Tidak exit — biarkan server tetap melayani request
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[FATAL] unhandledRejection: ${msg}`);
    addLog('error', `unhandledRejection: ${msg}`);
});

// ════════════════════════════════════════════════════════════
// START SERVER
// PENTING: server.listen DULU, baru initWhatsApp()
// Railway healthcheck hit /ping dalam hitungan detik setelah deploy
// Jika WA init duluan dan crash, port tidak pernah terbind = pod mati
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', (err) => {
    if (err) {
        console.error('[FATAL] server.listen gagal:', err);
        process.exit(1);
    }

    console.log('\n' + '═'.repeat(55));
    console.log(`  🚀 DompetKu HQ v2.0`);
    console.log(`  📍 Port      : ${port}`);
    console.log(`  📍 Login     : http://localhost:${port}/login`);
    console.log(`  📍 Dashboard : http://localhost:${port}/`);
    console.log(`  📍 Ping      : http://localhost:${port}/ping`);
    console.log(`  📍 Health    : http://localhost:${port}/health`);
    console.log(`  💾 Session   : ${pgPool ? 'PostgreSQL ✅' : 'Memory ⚠️'}`);
    console.log(`  📁 WA Dir    : ${WA_SESSION_DIR}`);
    console.log('═'.repeat(55) + '\n');

    addLog('info', `Server berjalan di port ${port}`);

    // Init WA 3 detik setelah server listen
    // Memberi waktu port terbind sempurna dan Railway bisa hit /ping
    setTimeout(() => {
        initWhatsApp();
    }, 3000);
});