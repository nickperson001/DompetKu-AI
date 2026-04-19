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
const io     = new Server(server);
const port   = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// SESSION STORE (PostgreSQL + fallback memory)
// ════════════════════════════════════════════════════════════
let pgPool = null;
if (process.env.DATABASE_URL) {
    try {
        pgPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl             : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max             : 5,   // Batasi connection pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        console.log('[SESSION] PostgreSQL pool created');
    } catch (err) {
        console.error('[SESSION] Pool creation failed:', err.message);
    }
}

function buildSessionMiddleware() {
    const base = {
        secret           : process.env.SESSION_SECRET || 'dompetku-secret-32chars-ganti!!',
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
        console.warn('[SESSION] ⚠️  Pakai memory store — session hilang saat restart');
        console.warn('[SESSION]    Set DATABASE_URL di Railway untuk session persisten');
        return session(base);
    }

    try {
        const store = new pgSession({
            pool                : pgPool,
            tableName           : 'user_sessions',
            createTableIfMissing: true,
            errorLog            : (err) => console.error('[SESSION] Store error:', err.message),
        });

        store.on && store.on('error', (err) => {
            console.error('[SESSION] Store runtime error:', err.message);
        });

        console.log('[SESSION] ✅ PostgreSQL session store aktif');
        return session({ ...base, store });
    } catch (err) {
        console.error('[SESSION] ❌ Gagal init pg store, fallback memory:', err.message);
        return session(base);
    }
}

const sessionMiddleware = buildSessionMiddleware();

app.use(sessionMiddleware);
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// ════════════════════════════════════════════════════════════
// WA SESSION DIR — pastikan folder ada di /tmp
// ════════════════════════════════════════════════════════════
// FIX: LocalAuth di container stateless (Railway) kehilangan session
// saat redeploy karena /tmp tidak persisten.
// Solusi: /tmp bertahan selama container HIDUP (restart OK),
// hanya hilang saat REDEPLOY. Scan QR ulang diperlukan setelah deploy baru.
// Untuk session persisten antar deploy → gunakan Railway Volume (paid)
// atau simpan/restore session files ke Supabase Storage (advanced).
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || '/tmp/wa-session';

// Pastikan direktori ada
if (!fs.existsSync(WA_SESSION_DIR)) {
    fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
    console.log(`[WA] Session dir created: ${WA_SESSION_DIR}`);
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
        else console.log('[WA-SESSION] ✅ Session saved to DB');
    } catch (e) {
        console.error('[WA-SESSION] Save failed:', e.message);
    }
}

// ════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════
let botStatus        = 'Initializing';
let currentQR        = '';
let clientReady      = false;
let maintenanceMode  = false;
let systemLogs       = [];
const activeBroadcasts = new Map();

const addLog = (level, message, data = {}) => {
    const log = {
        timestamp: new Date().toISOString(),
        level, message, data,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    };
    systemLogs.unshift(log);
    if (systemLogs.length > 1000) systemLogs.pop();
    io.emit('system_log', log);
};

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT
// FIX LocalAuth untuk container:
// - dataPath ke /tmp/wa-session (writable di Railway)
// - clientId untuk namespace session (hindari konflik multi-deploy)
// - webVersionCache untuk cache versi WA agar tidak re-download setiap start
// ════════════════════════════════════════════════════════════
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: WA_SESSION_DIR,
        clientId: 'dompetku-bot', // Namespace unik untuk session files
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--single-process',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--safebrowsing-disable-auto-update',
        ],
        executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
        timeout: 60000, // 60 detik timeout untuk startup Chromium
    },
    webVersionCache: {
        type : 'local',
        path : '/tmp/wa-version-cache', // Cache versi WA di /tmp
    },
    restartOnAuthFail: true,
    qrMaxRetries    : 5,     // Coba generate QR maksimal 5 kali
});

// ── WA Events ───────────────────────────────────────────────
client.on('qr', async (qr) => {
    botStatus   = 'Scan QR';
    currentQR   = await qrcodeWeb.toDataURL(qr);
    clientReady = false;
    addLog('warn', '📱 QR Code generated — buka dashboard dan scan WA');
    io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
});

client.on('loading_screen', (percent, message) => {
    addLog('info', `Loading: ${percent}% — ${message}`);
});

client.on('authenticated', async (sessionData) => {
    addLog('info', '✅ WhatsApp authenticated');
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
    addLog('info', '🟢 WhatsApp client READY & Online');
    io.emit('bot_update', { status: botStatus, qr: null, ready: true });
    initSchedulers(client);
});

client.on('message', async (msg) => {
    if (maintenanceMode && !msg.fromMe) {
        await msg.reply('🛠️ Sistem sedang dalam perbaikan. Harap tunggu sebentar.').catch(() => {});
        return;
    }
    try {
        addLog('info', `MSG ← ${msg.from}`, { body: (msg.body || '').substring(0, 60) });
        await handleMessage(msg, client);
        io.emit('new_log', { from: msg.from, body: msg.body, timestamp: new Date().toISOString() });
    } catch (err) {
        addLog('error', `Message handler error: ${err.message}`);
    }
});

client.on('disconnected', (reason) => {
    botStatus   = 'Disconnected';
    clientReady = false;
    addLog('error', `🔴 Disconnected: ${reason}`);
    io.emit('bot_update', { status: botStatus, ready: false });

    // Auto reconnect setelah 5 detik
    setTimeout(() => {
        addLog('info', '🔄 Attempting to reconnect...');
        client.initialize().catch(e => addLog('error', `Reconnect failed: ${e.message}`));
    }, 5000);
});

// Start WA
client.initialize().catch(e => addLog('error', `Initialize failed: ${e.message}`));

// ════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════
const isAdmin = (req, res, next) => {
    if (req.session?.authenticated) return next();
    const wantsJSON = req.xhr ||
        req.headers['accept']?.includes('application/json') ||
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
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/health', async (req, res) => {
    const used = process.memoryUsage();
    let dbStatus = 'error';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
    } catch (_) {}

    const health = {
        status   : clientReady && dbStatus === 'connected' ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime   : Math.floor(process.uptime()),
        whatsapp : { status: botStatus, ready: clientReady },
        system   : {
            memory: {
                used      : Math.round(used.heapUsed / 1024 / 1024),
                total     : Math.round(used.heapTotal / 1024 / 1024),
                percentage: Math.round((used.heapUsed / used.heapTotal) * 100),
            },
            cpu     : os.loadavg(),
            platform: os.platform(),
        },
        database    : dbStatus,
        session_type: pgPool ? 'postgresql' : 'memory',
    };
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    // FIX: gunakan ADMIN_USERNAME & ADMIN_PASSWORD (bukan ADMIN_USER/ADMIN_PASS)
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === validUser && password === validPass) {
        req.session.authenticated = true;
        req.session.loginAt       = new Date().toISOString();
        addLog('info', `Admin login OK from ${req.ip}`);
        res.json({ success: true });
    } else {
        addLog('warn', `Failed login: "${username}" from ${req.ip}`);
        res.status(401).json({ success: false });
    }
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
            pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) },
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
            upgrade_notified: false,
            is_upgrading    : false,
            upgrade_package : null,
            subscription_expires_at: status === 'pro'
                ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                : null,
        };

        const { error } = await supabase.from('users').update(updates).eq('id', id);
        if (error) throw error;

        if (clientReady) {
            const notifs = {
                demo     : 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).',
                pro      : '🎉 Selamat! Akun PRO aktif 30 hari. ⭐',
                unlimited: '💎 Selamat! Akun UNLIMITED aktif seumur hidup!',
            };
            client.sendMessage(id, notifs[status]).catch(e => addLog('warn', `WA notif failed: ${e.message}`));
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
    if (!clientReady)     return res.status(503).json({ error: 'Bot belum online — scan QR dulu' });

    try {
        let query = supabase.from('users').select('id, store_name');
        if (target && target !== 'all') query = query.eq('status', target);
        const { data: users, error } = await query;
        if (error) throw error;

        const jobId = Date.now().toString();
        const job   = { id: jobId, total: users.length, sent: 0, failed: 0, status: 'running', target: target || 'all' };
        activeBroadcasts.set(jobId, job);
        processBroadcast(jobId, users, message);

        addLog('info', `Broadcast started → ${users.length} users [${target || 'all'}]`);
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
            await client.sendMessage(users[i].id, text);
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
// SOCKET.IO — Gunakan sessionMiddleware yang sama
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.use((socket, next) => {
    // Izinkan semua koneksi — QR harus bisa ditampilkan sebelum login
    next();
});

io.on('connection', (socket) => {
    const isAuth = socket.request.session?.authenticated;
    addLog('info', `WS connected: ${socket.id} [${isAuth ? 'admin' : 'guest'}]`);

    // Kirim state saat ini ke client baru
    socket.emit('bot_update', { status: botStatus, qr: currentQR, ready: clientReady });

    if (isAuth) {
        socket.emit('logs_history', systemLogs.slice(0, 50));
    }

    socket.on('request_reconnect', () => {
        if (!clientReady) {
            addLog('info', 'Manual reconnect requested');
            client.initialize().catch(e => addLog('error', `Reconnect failed: ${e.message}`));
        }
    });

    socket.on('disconnect', () => {
        addLog('info', `WS disconnected: ${socket.id}`);
    });
});

// ════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS
// ════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] uncaughtException: ${err.message}\n${err.stack}`);
    addLog('error', `uncaughtException: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[FATAL] unhandledRejection: ${msg}`);
    addLog('error', `unhandledRejection: ${msg}`);
});

// ════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 DompetKu HQ v2.0 — port ${port}`);
    console.log(`   Dashboard : http://localhost:${port}/`);
    console.log(`   Login     : http://localhost:${port}/login`);
    console.log(`   Health    : http://localhost:${port}/health`);
    console.log(`   Session   : ${pgPool ? 'PostgreSQL' : 'Memory'}`);
    console.log(`   WA Dir    : ${WA_SESSION_DIR}\n`);
    addLog('info', `Server started — port ${port}`);
});