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
        secret           : process.env.SESSION_SECRET || 'tbs-secret-32chars-ganti-ini!',
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
        console.warn('[SESSION] ⚠️  Memory store — set DATABASE_URL untuk session persisten');
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
// TRUST PROXY — WAJIB untuk Railway/Heroku/Render
// Tanpa ini: cookie secure tidak bisa di-set di balik reverse proxy
// Akibat: session selalu hilang → login loop → dashboard tidak bisa dibuka
// ════════════════════════════════════════════════════════════
app.set('trust proxy', 1);

// ════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Hanya expose /assets — index.html & login.html via route eksplisit
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
        level, message, data,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    };
    systemLogs.unshift(log);
    if (systemLogs.length > 1000) systemLogs.pop();
    try { io.emit('system_log', log); } catch (_) {}
    console.log(`[${level.toUpperCase()}] ${message}`);
};

// ════════════════════════════════════════════════════════════
// PING — Selalu 200, dipakai Railway healthcheck
// ════════════════════════════════════════════════════════════
app.get('/ping', (req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
});

// ════════════════════════════════════════════════════════════
// HEALTH — Detail monitoring, SELALU 200
// ════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    const used = process.memoryUsage();
    let dbStatus = 'unknown';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
    } catch (_) { dbStatus = 'error'; }

    res.status(200).json({
        status   : 'running',
        wa_ready: clientReady,
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
    if (req.session.authenticated) return res.redirect('/');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === validUser && password === validPass) {
        req.session.authenticated = true;
        
        // Simpan dulu, baru kirim OK
        req.session.save((err) => {
            if (err) return res.status(500).json({ success: false });
            return res.json({ success: true });
        });
    } else {
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
        const page   = Math.max(1, parseInt(req.query.page)   || 1);
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
                .catch(e => addLog('warn', `WA notif gagal: ${e.message}`));
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
        } catch (_) { job.failed++; }

        if (i % 5 === 0 || i === users.length - 1) {
            job.progress = Math.round(((i + 1) / users.length) * 100);
            io.emit('broadcast_progress', { jobId, current: i + 1, total: users.length, sent: job.sent, failed: job.failed });
        }
        await new Promise(r => setTimeout(r, 1200));
    }
    job.status      = 'completed';
    job.completedAt = new Date().toISOString();
    io.emit('broadcast_complete', { jobId, ...job });
    addLog('info', `Broadcast selesai: ${job.sent} terkirim, ${job.failed} gagal`);
}

app.get('/api/admin/logs', isAdmin, (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    res.json(systemLogs.slice(0, limit));
});

app.get('/api/admin/status', isAdmin, (req, res) => {
    res.json({ status: botStatus, ready: clientReady, qr: currentQR, maintenance: maintenanceMode });
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO — Share session dengan Express
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on('connection', (socket) => {
    const isAuth = socket.request.session?.authenticated;
    addLog('info', `WS: ${socket.id} [${isAuth ? 'admin' : 'guest'}]`);

    // ✅ FIX: Kirim state terkini segera saat client connect
    // Jika QR tersedia → langsung tampilkan
    // Jika sudah ready → konfirmasi status online
    socket.emit('bot_update', {
        status: botStatus,
        qr    : clientReady ? null : currentQR,  // QR hanya jika belum terhubung
        ready : clientReady,
    });

    if (isAuth) socket.emit('logs_history', systemLogs.slice(0, 50));

    socket.on('request_reconnect', async () => {
        if (!clientReady) {
            addLog('info', 'Manual reconnect diminta (Hard Reset Engine)');
            botStatus = 'Reconnecting';
            currentQR = '';
            io.emit('bot_update', { status: botStatus, qr: '', ready: false });
            
            // 1. Matikan engine WA yang lama agar tidak bentrok RAM
            if (waClient) {
                try { await waClient.destroy(); } catch (e) {}
            }
            
            // 2. Bersihkan file sesi WA yang rusak (agar QR pasti turun ulang)
            try {
                if (fs.existsSync(WA_SESSION_DIR)) {
                    fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true });
                    addLog('info', 'Folder sesi lama berhasil dibersihkan');
                }
            } catch (e) {
                console.error('[WA] Gagal hapus folder sesi lama:', e);
            }
            
            // 3. Hidupkan ulang WhatsApp dari keadaan fresh
            initWhatsApp();
        } else {
            socket.emit('bot_update', { status: 'Online', qr: null, ready: true });
        }
    });

    socket.on('disconnect', () => {
        addLog('info', `WS disconnect: ${socket.id}`);
    });
});

// ════════════════════════════════════════════════════════════
// WHATSAPP — Session dir
// ════════════════════════════════════════════════════════════
// Volume Railway di-mount ke /.wwebjs_auth — gunakan itu agar
// session WA tidak hilang saat redeploy
const WA_SESSION_DIR = process.env.WA_SESSION_DIR || path.join(__dirname, '.wwebjs_auth'); // ✅ FIX: relative path

try {
    if (!fs.existsSync(WA_SESSION_DIR)) {
        fs.mkdirSync(WA_SESSION_DIR, { recursive: true });
    }
    console.log(`[WA] Session dir: ${WA_SESSION_DIR}`);
} catch (e) {
    console.error('[WA] Gagal buat session dir:', e.message);
}

async function saveSessionToDB(sessionData) {
    if (!sessionData) return;
    try {
        await supabase.from('wa_sessions').upsert({
            id: 'main', data: JSON.stringify(sessionData), updated_at: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[WA-SESSION] Save gagal:', e.message);
    }
}

// ════════════════════════════════════════════════════════════
// INIT WHATSAPP
// ════════════════════════════════════════════════════════════
function initWhatsApp() {
    addLog('info', '🔄 Inisialisasi WhatsApp...');
    botStatus = 'Initializing';
    try { io.emit('bot_update', { status: botStatus, qr: '', ready: false }); } catch (_) {}

    // Deteksi Chromium
    const chromiumPaths = [
        process.env.PUPPETEER_EXEC_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ].filter(Boolean);

    let executablePath;
    for (const p of chromiumPaths) {
        if (fs.existsSync(p)) { executablePath = p; break; }
    }

    console.log(`[WA] Chromium: ${executablePath || 'tidak ditemukan, pakai default'}`);

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: WA_SESSION_DIR,
            clientId: 'tbs',
        }),
        puppeteer: {
            headless      : true,
            executablePath: process.env.PUPPETEER_EXEC_PATH || usr/bin/chromium,
            args          : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Sangat disarankan untuk menghemat RAM
            '--disable-gpu'
            ],
            timeout: 120_000,
        },
        restartOnAuthFail: true,
        qrMaxRetries     : 10,
    });

    client.on('qr', async (qr) => {
        botStatus   = 'Scan QR';
        clientReady = false;
        try { currentQR = await qrcodeWeb.toDataURL(qr); } catch (_) {}
        addLog('warn', '📱 QR siap — buka dashboard dan scan');
        io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
    });

    client.on('loading_screen', (percent, msg) => {
        addLog('info', `WA Loading: ${percent}% — ${msg}`);
    });

    client.on('authenticated', async (sessionData) => {
        addLog('info', '🔐 WhatsApp authenticated');
        if (sessionData) await saveSessionToDB(sessionData);
    });

    client.on('auth_failure', (reason) => {
        addLog('error', `❌ Auth failure: ${reason}`);
        botStatus = 'Auth Failed'; clientReady = false; currentQR = ''; waClient = null;
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });
    });

    client.on('ready', () => {
        botStatus = 'Online'; clientReady = true; currentQR = ''; waClient = client;
        addLog('info', '🟢 WhatsApp ONLINE');
        io.emit('bot_update', { status: botStatus, qr: null, ready: true });
        try { initSchedulers(client); } catch (e) { addLog('error', `Scheduler gagal: ${e.message}`); }
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

    client.on('disconnected', async (reason) => {
        botStatus = 'Disconnected'; clientReady = false; 
        addLog('error', `🔴 WA Terputus: ${reason}`);
        
        // Hancurkan proses browser yang hang
        if (waClient) {
            try { await waClient.destroy(); } catch (e) {}
        }
        waClient = null; currentQR = '';
        
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });
        // Reconnect dalam 3 detik
        setTimeout(() => { addLog('info', '🔄 Auto-reconnect...'); initWhatsApp(); }, 3_000);
    });

    client.initialize().catch(async (err) => {
        addLog('error', `WA init error: ${err.message}`);
        botStatus = 'Error'; clientReady = false; 
        
        // Hancurkan proses yang gagal inisialisasi
        if (client) {
            try { await client.destroy(); } catch (e) {}
        }
        waClient = null; currentQR = '';
        
        io.emit('bot_update', { status: botStatus, ready: false, qr: '' });
        setTimeout(() => { addLog('info', '🔄 Retry WA init...'); initWhatsApp(); }, 15_000);
    });
}

// ════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLERS — Jangan pernah crash process
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
// START — Server listen DULU, WA init BELAKANGAN
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', (err) => {
    if (err) { console.error('[FATAL] Listen gagal:', err); process.exit(1); }

    console.log('\n' + '═'.repeat(52));
    console.log(`  🚀 Server on Running Tata Business Suite`);
    console.log(`  📍 Port      : ${port}`);
    const _base = process.env.APP_URL || `http://localhost:${port}`;
    console.log(`  📍 Login     : ${_base}/login`);
    console.log(`  📍 Dashboard : ${_base}/`);
    console.log(`  📍 Ping      : ${_base}/ping`);
    console.log(`  📍 Health    : ${_base}/health`);
    console.log(`  💾 Session   : ${pgPool ? 'PostgreSQL ✅' : 'Memory ⚠️'}`);
    console.log(`  📁 WA Dir    : ${WA_SESSION_DIR}`);
    console.log('═'.repeat(52) + '\n');

    addLog('info', `Server berjalan di port ${port}`);

    // WA init 3 detik setelah server ready
    // Railway hit /ping lebih dulu → healthcheck PASS → pod tidak di-kill
    setTimeout(() => initWhatsApp(), 3000);
});
// ════════════════════════════════════════════════════════════
// STOCK DASHBOARD — PUBLIC USER ROUTES
// ════════════════════════════════════════════════════════════
const crypto = require('crypto');
const stockManager = require('./src/utils/stockManager');

// Serve dashboard page
app.get('/stock/:userId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stock.html'));
});

// Token auth middleware untuk stock API
const stockAuth = async (req, res, next) => {
    const token  = req.query.token || req.headers['x-stock-token'];
    // FIX: Express decodes req.params automatically, but extra safety for @c.us encoding
    const userId = decodeURIComponent(req.params.userId || '');
    if (!token || !userId) return res.status(401).json({ error: 'Token dan userId wajib' });

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('id, store_name, status, dashboard_token')
            .eq('id', userId)
            .eq('dashboard_token', token)
            .single();

        if (error || !user) {
            console.log(`[STOCK-AUTH] Gagal: userId="${userId}" token="${token?.substring(0,8)}..." error="${error?.message}"`);
            return res.status(401).json({ error: 'Token tidak valid atau sudah kadaluarsa' });
        }
        req.stockUser = user;
        req.stockUserId = userId;  // normalized userId
        next();
    } catch (e) {
        res.status(401).json({ error: 'Auth gagal' });
    }
};

// Verify token + return user info
app.get('/api/stock/:userId/verify', stockAuth, (req, res) => {
    const u = req.stockUser;
    res.json({ id: u.id, store_name: u.store_name, status: u.status });
});

// Summary / overview stats
app.get('/api/stock/:userId/summary', stockAuth, async (req, res) => {
    const userId = req.params.userId;
    try {
        const { data: products } = await supabase
            .from('products')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true);

        let totalValue = 0, lowStock = 0, outStock = 0;
        const byCategory = {};

        (products || []).forEach(p => {
            const stock = parseFloat(p.stock_current) || 0;
            const min   = parseFloat(p.stock_min) || 0;
            const val   = stock * (parseFloat(p.price_buy) || 0);
            totalValue += val;
            if (stock <= 0) outStock++;
            else if (stock <= min) lowStock++;

            const cat = p.category || 'Umum';
            if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
            byCategory[cat].count++;
            byCategory[cat].value += val;
        });

        // Recent alerts
        const { data: alertData } = await supabase
            .from('stock_alerts')
            .select('*, products(id, sku, name, unit, stock_current, stock_min)')
            .eq('user_id', userId)
            .is('resolved_at', null)
            .order('alerted_at', { ascending: false })
            .limit(10);

        res.json({
            total: (products || []).length,
            active: (products || []).length,
            totalValue,
            lowStock,
            outStock,
            byCategory,
            alerts: alertData || [],
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// List products
app.get('/api/stock/:userId/products', stockAuth, async (req, res) => {
    const userId = req.params.userId;
    try {
        const { data, error } = await supabase
            .from('products')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('name', { ascending: true });

        if (error) throw error;
        res.json({ products: data || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add product
app.post('/api/stock/:userId/products', stockAuth, async (req, res) => {
    const userId = req.params.userId;
    const { sku, name, category, unit, priceBuy, priceSell, stockInitial, stockMin, supplier, location, notes } = req.body;

    try {
        const result = await stockManager.addProduct(userId, {
            sku, name, category, unit,
            priceBuy   : parseFloat(priceBuy)     || 0,
            priceSell  : parseFloat(priceSell)    || 0,
            stockInitial: parseFloat(stockInitial) || 0,
            stockMin   : parseFloat(stockMin)     || 0,
            description: notes,
        });

        if (!result.success) return res.status(400).json({ error: result.error });

        // Extra fields not in stockManager
        if (supplier || location) {
            await supabase.from('products').update({ supplier, location })
                .eq('id', result.product.id);
        }

        addLog('info', `[STOCK-DASH] Produk baru: ${name} (${sku}) oleh ${userId}`);
        res.json({ success: true, product: result.product });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Update product (non-stock fields only)
app.put('/api/stock/:userId/products/:productId', stockAuth, async (req, res) => {
    const { userId, productId } = req.params;
    const { name, category, unit, price_buy, price_sell, stock_min, supplier, location, notes } = req.body;

    try {
        const { error } = await supabase
            .from('products')
            .update({
                name, category, unit,
                price_buy : parseFloat(price_buy)  || 0,
                price_sell: parseFloat(price_sell) || 0,
                stock_min : parseFloat(stock_min)  || 0,
                supplier  : supplier || null,
                location  : location || null,
                notes     : notes || null,
            })
            .eq('id', productId)
            .eq('user_id', userId);

        if (error) throw error;
        addLog('info', `[STOCK-DASH] Edit produk #${productId} oleh ${userId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Delete product (soft)
app.delete('/api/stock/:userId/products/:productId', stockAuth, async (req, res) => {
    const { userId, productId } = req.params;
    try {
        const result = await stockManager.deleteProduct(userId, parseInt(productId));
        if (!result.success) return res.status(400).json({ error: result.error });
        addLog('info', `[STOCK-DASH] Hapus produk #${productId} oleh ${userId}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Record stock movement (in/out/adjustment)
app.post('/api/stock/:userId/movement', stockAuth, async (req, res) => {
    const userId = req.params.userId;
    const { product_id, type, quantity, note, unit_price } = req.body;

    if (!product_id || !type || !quantity) {
        return res.status(400).json({ error: 'product_id, type, dan quantity wajib diisi' });
    }
    if (!['in','out','adjustment'].includes(type)) {
        return res.status(400).json({ error: 'type harus: in, out, atau adjustment' });
    }
    if (parseFloat(quantity) <= 0) {
        return res.status(400).json({ error: 'Jumlah harus lebih dari 0' });
    }

    try {
        const result = await stockManager.adjustStock(userId, parseInt(product_id), type, parseFloat(quantity), {
            referenceType: 'manual',
            note,
        });

        if (!result.success) return res.status(400).json({ error: result.error });

        // Update unit_price dan created_via di movement terbaru
        if (unit_price) {
            const { data: lastMov } = await supabase
                .from('stock_movements')
                .select('id')
                .eq('user_id', userId)
                .eq('product_id', product_id)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();

            if (lastMov) {
                const totalVal = parseFloat(unit_price) * parseFloat(quantity);
                await supabase.from('stock_movements')
                    .update({ unit_price: parseFloat(unit_price), total_value: totalVal, created_via: 'dashboard' })
                    .eq('id', lastMov.id);
            }
        } else {
            // Mark as dashboard via
            const { data: lastMov } = await supabase
                .from('stock_movements')
                .select('id')
                .eq('user_id', userId)
                .eq('product_id', product_id)
                .order('created_at', { ascending: false })
                .limit(1)
                .single();
            if (lastMov) {
                await supabase.from('stock_movements')
                    .update({ created_via: 'dashboard' })
                    .eq('id', lastMov.id);
            }
        }

        addLog('info', `[STOCK-DASH] Movement ${type} qty:${quantity} produk #${product_id} oleh ${userId}`);
        res.json({ success: true, stockBefore: result.stockBefore, stockAfter: result.stockAfter });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Movement history (with pagination + filter)
app.get('/api/stock/:userId/movements', stockAuth, async (req, res) => {
    const userId   = req.params.userId;
    const limit    = Math.min(100, parseInt(req.query.limit) || 30);
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const prodId   = req.query.product_id;
    const type     = req.query.type;

    try {
        let query = supabase
            .from('stock_movements')
            .select('*, products(id, sku, name, unit)', { count: 'exact' })
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range((page - 1) * limit, page * limit - 1);

        if (prodId) query = query.eq('product_id', prodId);
        if (type)   query = query.eq('type', type);
        if (req.query.via) query = query.eq('created_via', req.query.via);

        const { data, error, count } = await query;
        if (error) throw error;
        res.json({ movements: data || [], total: count || 0, page, limit });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// Stock report endpoint
app.get('/api/stock/:userId/report', stockAuth, async (req, res) => {
    const userId = decodeURIComponent(req.params.userId);
    const days   = Math.min(365, parseInt(req.query.days) || 30);
    const since  = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    try {
        // Movements in period
        const { data: movs } = await supabase
            .from('stock_movements')
            .select('*, products(id, name, sku, unit)')
            .eq('user_id', userId)
            .gte('created_at', since)
            .order('created_at', { ascending: false });

        let totalIn = 0, totalOut = 0, totalAdj = 0, count = (movs||[]).length;
        const outByProduct = {};

        (movs || []).forEach(m => {
            const val = parseFloat(m.quantity) * (parseFloat(m.unit_price) || 0);
            if (m.type === 'in')         totalIn  += val;
            else if (m.type === 'out')   totalOut += val;
            else if (m.type === 'adjustment') totalAdj++;

            if (m.type === 'out' && m.products) {
                const key = m.product_id;
                if (!outByProduct[key]) outByProduct[key] = { ...m.products, total: 0 };
                outByProduct[key].total += parseFloat(m.quantity);
            }
        });

        // Top products by out quantity
        const maxOut = Math.max(...Object.values(outByProduct).map(p=>p.total), 1);
        const topOut = Object.values(outByProduct)
            .sort((a,b) => b.total - a.total)
            .slice(0, 8)
            .map(p => ({ ...p, pct: Math.round((p.total/maxOut)*100) }));

        // By category (current stock value)
        const { data: products } = await supabase
            .from('products').select('*').eq('user_id', userId).eq('is_active', true);

        const byCategory = {};
        (products||[]).forEach(p => {
            const cat = p.category || 'Umum';
            const val = parseFloat(p.stock_current) * parseFloat(p.price_buy);
            if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0 };
            byCategory[cat].count++;
            byCategory[cat].value += val;
        });

        res.json({ totalIn, totalOut, totalAdj, count, topOut, byCategory });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ════════════════════════════════════════════════════════════
// ADMIN: Generate dashboard token untuk user
// ════════════════════════════════════════════════════════════
app.post('/api/admin/user/:id/dashboard-token', isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const token = crypto.randomBytes(16).toString('hex');
        const { error } = await supabase
            .from('users')
            .update({ dashboard_token: token, dashboard_token_created_at: new Date().toISOString() })
            .eq('id', id);
        if (error) throw error;

        // Kirim link ke user via WA
        if (clientReady && waClient) {
            const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
            const link   = `${appUrl}/stock/${id}?token=${token}`;
            waClient.sendMessage(id, `📦 *Dashboard Stok Anda*\n\nAkses dashboard stok di:\n${link}\n\n⚠️ Jaga kerahasiaan link ini. Ketik *Token baru* jika link bermasalah.`)
                .catch(e => addLog('warn', `WA token send failed: ${e.message}`));
        }

        addLog('info', `Dashboard token generated for ${id}`);
        res.json({ success: true, token });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// User request token baru via WA (dipanggil dari message.js)
app.post('/api/internal/generate-token/:userId', async (req, res) => {
    const { userId } = req.params;
    const { secret } = req.body;
    if (secret !== (process.env.INTERNAL_SECRET || 'tbs-internal')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const token = crypto.randomBytes(16).toString('hex');
        await supabase.from('users')
            .update({ dashboard_token: token, dashboard_token_created_at: new Date().toISOString() })
            .eq('id', userId);
        res.json({ success: true, token });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});