'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const qrcodeWeb  = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session    = require('express-session');
const { Pool }   = require('pg');
const pgSession  = require('connect-pg-simple')(session);
const os         = require('os');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

const { handleMessage }  = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase           = require('./src/config/supabase');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});
const port = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// SESSION STORE
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
        secret           : process.env.SESSION_SECRET || 'dompetku-secret-32chars-ganti!!',
        resave           : false,
        saveUninitialized: false,
        cookie: {
            secure  : process.env.NODE_ENV === 'production',
            maxAge  : 30 * 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax',
        },
    };

    if (!pgPool) {
        console.warn('[SESSION] ⚠️ Memory store — set DATABASE_URL untuk session persisten');
        return session(base);
    }

    try {
        const store = new pgSession({
            pool                : pgPool,
            tableName           : 'user_sessions',
            createTableIfMissing: true,
            errorLog            : (err) => console.error('[SESSION] Store error:', err.message),
        });
        console.log('[SESSION] ✅ PostgreSQL store aktif');
        return session({ ...base, store });
    } catch (err) {
        console.error('[SESSION] Fallback ke memory:', err.message);
        return session(base);
    }
}

const sessionMiddleware = buildSessionMiddleware();

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ════════════════════════════════════════════════════════════
// STATIC FILES
// ════════════════════════════════════════════════════════════
// Serve public folder
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════
let botStatus      = 'Initializing';
let currentQR      = '';
let clientReady    = false;
let maintenanceMode = false;
let systemLogs     = [];
let waClient       = null; // Bisa null jika Puppeteer belum siap
const activeBroadcasts = new Map();

const addLog = (level, message, data = {}) => {
    const log = {
        timestamp: new Date().toISOString(),
        level, message, data,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    };
    systemLogs.unshift(log);
    if (systemLogs.length > 1000) systemLogs.pop();
    try { io.emit('system_log', log); } catch (_) {}
    console.log(`[${level.toUpperCase()}] ${message}`);
};

// ════════════════════════════════════════════════════════════
// PING — Selalu 200, Railway healthcheck menggunakan ini
// ════════════════════════════════════════════════════════════
app.get('/ping', (req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
});

// ════════════════════════════════════════════════════════════
// HEALTH — Monitoring detail, TIDAK dipakai healthcheck
// ════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    const used = process.memoryUsage();
    let dbStatus = 'unknown';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
    } catch (_) { dbStatus = 'error'; }

    // SELALU 200 — jangan biarkan Railway kill pod karena WA belum ready
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
    if (req.session?.authenticated) return next();
    const wantsJSON = req.xhr ||
        (req.headers['accept'] || '').includes('application/json') ||
        req.path.startsWith('/api/');
    return wantsJSON
        ? res.status(401).json({ error: 'Unauthorized' })
        : res.redirect('/login');
};

// ════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════════
app.get('/login', (req, res) => {
    if (req.session?.authenticated) return res.redirect('/');
    const loginPath = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(loginPath)) {
        return res.sendFile(loginPath);
    }
    // Fallback inline jika file tidak ada
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login — DompetKu</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>body{background:#020617;color:#f8fafc}</style>
</head>
<body class="min-h-screen flex items-center justify-center p-6">
    <div class="w-full max-w-sm bg-slate-800/70 backdrop-blur border border-slate-700 p-10 rounded-3xl shadow-2xl">
        <div class="text-center mb-8">
            <h1 class="text-4xl font-black text-green-500">DompetKu</h1>
            <p class="text-slate-400 text-xs mt-2 uppercase tracking-widest">Admin Dashboard</p>
        </div>
        <div class="space-y-4">
            <input type="text" id="u" placeholder="Username"
                class="w-full bg-slate-900 border border-slate-600 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-green-500 transition">
            <input type="password" id="p" placeholder="Password"
                class="w-full bg-slate-900 border border-slate-600 p-4 rounded-2xl outline-none focus:ring-2 focus:ring-green-500 transition">
            <button onclick="doLogin()"
                class="w-full bg-green-600 hover:bg-green-500 py-4 rounded-2xl font-bold transition shadow-lg">
                Masuk ke Dashboard
            </button>
            <p id="err" class="hidden text-red-400 text-xs text-center font-bold pt-1">
                USERNAME ATAU PASSWORD SALAH
            </p>
        </div>
    </div>
    <script>
        document.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
        async function doLogin() {
            const res = await fetch('/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value })
            });
            const data = await res.json();
            if (data.success) window.location.href = '/';
            else document.getElementById('err').classList.remove('hidden');
        }
    </script>
</body>
</html>`);
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';

    console.log(`[AUTH] Login attempt: "${username}" from ${req.ip}`);

    if (username === validUser && password === validPass) {
        req.session.authenticated = true;
        req.session.loginAt       = new Date().toISOString();
        addLog('info', `Admin login OK from ${req.ip}`);
        return res.json({ success: true });
    }

    addLog('warn', `Failed login: "${username}" from ${req.ip}`);
    res.status(401).json({ success: false });
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// ════════════════════════════════════════════════════════════
// PROTECTED ROUTES
// ════════════════════════════════════════════════════════════
app.get('/', isAdmin, (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.send('<h1>DompetKu Dashboard</h1><p>index.html tidak ditemukan di folder public/</p>');
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const page   = Math.max(1, parseInt(req.query.page)  || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 20);
        const search = (req.query.search || '').trim();
        const status = req.query.status || 'all';

        let query = supabase.from('users').select('*', { count: 'exact' });
        if (status !== 'all') query = query.eq('status', status);
        if (search) query = query.or(`store_name.ilike.%${search}%,id.ilike.%${search}%`);

        const { data, error, count } = await query
            .order('created_at', { ascending: false })
            .range((page - 1) * limit, page * limit - 1);

        if (error) throw error;
        res.json({
            users     : data || [],
            pagination: {
                page, limit,
                total     : count || 0,
                totalPages: Math.ceil((count || 0) / limit),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

        if (clientReady && waClient) {
            const notifs = {
                demo     : 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).',
                pro      : '🎉 Selamat! Akun PRO aktif 30 hari. ⭐',
                unlimited: '💎 Selamat! Akun UNLIMITED aktif seumur hidup!',
            };
            waClient.sendMessage(id, notifs[status])
                .catch(e => addLog('warn', `WA notif failed: ${e.message}`));
        }

        addLog('info', `User ${id} → ${status}`);
        io.emit('user_updated', { id, status });
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    const { message, target } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message diperlukan' });
    if (!clientReady || !waClient) return res.status(503).json({ error: 'Bot belum online — scan QR dulu' });

    try {
        let query = supabase.from('users').select('id, store_name');
        if (target && target !== 'all') query = query.eq('status', target);
        const { data: users, error } = await query;
        if (error) throw error;

        const jobId = Date.now().toString();
        const job   = { id: jobId, total: users.length, sent: 0, failed: 0, status: 'running', target: target || 'all' };
        activeBroadcasts.set(jobId, job);
        processBroadcast(jobId, users, message);

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
                .replace(/\{nama\}/gi, users[i].store_name)
                .replace(/\{nama_toko\}/gi, users[i].store_name);
            if (waClient) await waClient.sendMessage(users[i].id, text);
            job.sent++;
        } catch (_) { job.failed++; }

        if (i % 5 === 0 || i === users.length - 1) {
            job.progress = Math.round(((i + 1) / users.length) * 100);
            io.emit('broadcast_progress', {
                jobId, current: i + 1, total: users.length,
                sent: job.sent, failed: job.failed,
            });
        }
        await new Promise(r => setTimeout(r, 1200));
    }
    job.status      = 'completed';
    job.completedAt = new Date().toISOString();
    io.emit('broadcast_complete', { jobId, ...job });
    addLog('info', `Broadcast done: ${job.sent} sent, ${job.failed} failed`);
}

app.get('/api/admin/logs', isAdmin, (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    res.json(systemLogs.slice(0, limit));
});

app.get('/api/admin/status', isAdmin, (req, res) => {
    res.json({ status: botStatus, ready: clientReady, qr: currentQR, maintenance: maintenanceMode });
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', (socket) => {
    const isAuth = socket.request.session?.authenticated;
    addLog('info', `WS: ${socket.id} [${isAuth ? 'admin' : 'guest'}]`);

    socket.emit('bot_update', { status: botStatus, qr: currentQR, ready: clientReady });
    if (isAuth) socket.emit('logs_history', systemLogs.slice(0, 50));

    socket.on('request_reconnect', () => {
        if (!clientReady) {
            addLog('info', 'Manual reconnect requested');
            initWhatsApp();
        }
    });

    socket.on('disconnect', () => {
        addLog('info', `WS disconnected: ${socket.id}`);
    });
});

// ════════════════════════════════════════════════════════════
// WHATSAPP INIT — Terpisah dari server start
// ════════════════════════════════════════════════════════════
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || '/tmp/wa-session';

// Pastikan folder session ada
try {
    if (!fs.existsSync(WA_SESSION_DIR)) {
        fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
    }
} catch (e) {
    console.error('[WA] Gagal buat session dir:', e.message);
}

async function saveSessionToDB(sessionData) {
    if (!sessionData) return;
    try {
        await supabase.from('wa_sessions').upsert({
            id        : 'main',
            data      : JSON.stringify(sessionData),
            updated_at: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[WA-SESSION] Save failed:', e.message);
    }
}

function initWhatsApp() {
    addLog('info', '🔄 Inisialisasi WhatsApp...');
    botStatus = 'Initializing';
    io.emit('bot_update', { status: botStatus, qr: '', ready: false });

    // Deteksi Chromium path
    const chromiumPaths = [
        process.env.PUPPETEER_EXEC_PATH,
        '/run/current-system/sw/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ].filter(Boolean);

    let executablePath;
    for (const p of chromiumPaths) {
        if (fs.existsSync(p)) {
            executablePath = p;
            console.log(`[WA] Chromium found: ${p}`);
            break;
        }
    }

    if (!executablePath) {
        addLog('warn', '⚠️ Chromium tidak ditemukan di path manapun — mencoba tanpa executablePath');
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: WA_SESSION_DIR,
            clientId: 'dompetku',
        }),
        puppeteer: {
            headless         : true,
            executablePath   : executablePath || undefined,
            args             : [
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
            timeout: 120_000, // 120 detik untuk startup
        },
        restartOnAuthFail: true,
        qrMaxRetries     : 10,
    });

    client.on('qr', async (qr) => {
        botStatus   = 'Scan QR';
        clientReady = false;
        try { currentQR = await qrcodeWeb.toDataURL(qr); } catch (_) {}
        addLog('warn', '📱 QR Code siap — buka dashboard dan scan');
        io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
    });

    client.on('loading_screen', (percent, message) => {
        addLog('info', `WA Loading: ${percent}% — ${message}`);
    });

    client.on('authenticated', async (sessionData) => {
        addLog('info', '🔐 WhatsApp authenticated');
        if (sessionData) await saveSessionToDB(sessionData);
    });

    client.on('auth_failure', (reason) => {
        addLog('error', `❌ Auth failure: ${reason}`);
        botStatus   = 'Auth Failed';
        clientReady = false;
        currentQR   = '';
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });
    });

    client.on('ready', () => {
        botStatus   = 'Online';
        clientReady = true;
        currentQR   = '';
        waClient    = client;
        addLog('info', '🟢 WhatsApp ONLINE');
        io.emit('bot_update', { status: botStatus, qr: null, ready: true });

        // Init schedulers SETELAH bot ready
        try {
            initSchedulers(client);
        } catch (e) {
            addLog('error', `Scheduler init failed: ${e.message}`);
        }
    });

    client.on('message', async (msg) => {
        if (maintenanceMode && !msg.fromMe) {
            msg.reply('🛠️ Sistem sedang dalam perbaikan.').catch(() => {});
            return;
        }
        try {
            addLog('info', `MSG ← ${msg.from}`, { body: (msg.body || '').substring(0, 50) });
            await handleMessage(msg, client);
            io.emit('new_log', { from: msg.from, body: msg.body, timestamp: new Date().toISOString() });
        } catch (err) {
            addLog('error', `Message error: ${err.message}`);
        }
    });

    client.on('disconnected', (reason) => {
        botStatus   = 'Disconnected';
        clientReady = false;
        waClient    = null;
        addLog('error', `🔴 WA Disconnected: ${reason}`);
        io.emit('bot_update', { status: botStatus, ready: false });

        // Auto-reconnect setelah 10 detik
        setTimeout(() => {
            addLog('info', '🔄 Auto-reconnect...');
            initWhatsApp();
        }, 10_000);
    });

    // Init dengan error handling yang tidak crash server
    client.initialize().catch((err) => {
        addLog('error', `WA initialize error: ${err.message}`);
        botStatus   = 'Error';
        clientReady = false;
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });

        // Coba lagi setelah 30 detik
        setTimeout(() => {
            addLog('info', '🔄 Retry WA init setelah error...');
            initWhatsApp();
        }, 30_000);
    });
}

// ════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS — Jangan pernah crash process utama
// ════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException: ${err.message}`);
    console.error(err.stack);
    addLog('error', `uncaughtException: ${err.message}`);
    // TIDAK exit(1) — biarkan server tetap hidup
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[FATAL] unhandledRejection: ${msg}`);
    addLog('error', `unhandledRejection: ${msg}`);
    // TIDAK exit(1)
});

// ════════════════════════════════════════════════════════════
// START — Server DULU, WA BELAKANGAN
// Ini kunci utama agar Railway healthcheck berhasil
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', () => {
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`  🚀 DompetKu HQ v2.0 — listening on port ${port}`);
    console.log(`  📍 Login    : http://localhost:${port}/login`);
    console.log(`  📍 Dashboard: http://localhost:${port}/`);
    console.log(`  📍 Ping     : http://localhost:${port}/ping`);
    console.log(`  📍 Health   : http://localhost:${port}/health`);
    console.log(`  💾 Session  : ${pgPool ? 'PostgreSQL ✅' : 'Memory ⚠️'}`);
    console.log(`  📁 WA Dir   : ${WA_SESSION_DIR}`);
    console.log(`${'═'.repeat(50)}\n`);

    addLog('info', `Server started on port ${port}`);

    // Init WA setelah server listen — Railway bisa hit /ping lebih dulu
    setTimeout(() => {
        initWhatsApp();
    }, 2000); // Delay 2 detik untuk pastikan port terbind sempurna
});