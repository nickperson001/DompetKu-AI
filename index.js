'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const qrcodeWeb  = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session    = require('express-session');
const { Pool }   = require('pg');          // FIX #4: hapus duplicate require
const pgSession  = require('connect-pg-simple')(session);
const os         = require('os');
const path       = require('path');
require('dotenv').config();

const { handleMessage }  = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase           = require('./src/config/supabase');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const port   = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// SESSION STORE (PostgreSQL — anti-logout saat redeploy)
// ════════════════════════════════════════════════════════════
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// FIX #3: Buat satu sessionMiddleware yang dipakai BERSAMA express DAN socket.io
const sessionMiddleware = session({
    store: new pgSession({
        pool              : pgPool,
        tableName         : 'user_sessions',
        createTableIfMissing: true,
    }),
    secret           : process.env.SESSION_SECRET || 'dompetku-secret-ganti-ini-32char!!',
    resave           : false,
    saveUninitialized: false,
    cookie: {
        secure  : process.env.NODE_ENV === 'production',
        maxAge  : 30 * 24 * 60 * 60 * 1000, // 30 hari
        httpOnly: true,
    },
});

app.use(sessionMiddleware);
app.use(express.json());

// FIX #7: Serve static HANYA untuk asset (css/js/img), bukan HTML
// HTML pages dilayani lewat route eksplisit agar auth bisa dikontrol
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));
// Socket.io client
app.use('/socket.io', express.static(path.join(__dirname, 'node_modules', 'socket.io', 'client-dist')));

// ════════════════════════════════════════════════════════════
// WA SESSION PERSISTENCE (Supabase)
// ════════════════════════════════════════════════════════════
async function saveSessionToDB(sessionData) {
    try {
        const { error } = await supabase.from('wa_sessions').upsert({
            id        : 'main',
            data      : JSON.stringify(sessionData),
            updated_at: new Date().toISOString(),
        });
        if (error) console.error('[SESSION] Save error:', error.message);
        else console.log('[SESSION] ✅ Saved to DB');
    } catch (e) { console.error('[SESSION] Save failed:', e.message); }
}

// ════════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════════
let botStatus       = 'Initializing';
let currentQR       = '';
let clientReady     = false;
let maintenanceMode = false;
let systemLogs      = [];
let activeBroadcasts = new Map();

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
// ════════════════════════════════════════════════════════════
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/tmp/wa-session' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--single-process',
            '--no-zygote', '--disable-gpu',
        ],
        executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
    },
    restartOnAuthFail: true,
});

client.on('qr', async (qr) => {
    botStatus  = 'Scan QR';
    currentQR  = await qrcodeWeb.toDataURL(qr);
    clientReady = false;
    addLog('warn', 'QR Code generated — scan required');
    io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
});

client.on('authenticated', async (sessionData) => {
    addLog('info', 'WhatsApp authenticated');
    if (sessionData) await saveSessionToDB(sessionData);
});

client.on('ready', () => {
    botStatus   = 'Online';
    clientReady = true;
    currentQR   = '';
    addLog('info', '✅ WhatsApp client ready & online');
    io.emit('bot_update', { status: botStatus, qr: null, ready: true });
    initSchedulers(client);
});

client.on('message', async (msg) => {
    if (maintenanceMode && !msg.fromMe) {
        await msg.reply('🛠️ Sistem sedang dalam perbaikan. Harap tunggu sebentar.').catch(() => {});
        return;
    }
    try {
        addLog('info', `MSG from ${msg.from}`, { body: (msg.body || '').substring(0, 50) });
        await handleMessage(msg, client);
        io.emit('new_log', { from: msg.from, body: msg.body, timestamp: new Date().toISOString() });
    } catch (err) {
        addLog('error', `Message error: ${err.message}`);
    }
});

client.on('auth_failure', (reason) => {
    addLog('error', `Auth failure: ${reason}`);
    botStatus   = 'Auth Failed';
    clientReady = false;
    io.emit('bot_update', { status: botStatus, ready: false });
});

client.on('disconnected', (reason) => {
    botStatus   = 'Disconnected';
    clientReady = false;
    addLog('error', `Disconnected: ${reason}`);
    io.emit('bot_update', { status: botStatus, ready: false });
    setTimeout(() => {
        addLog('info', 'Attempting reconnect...');
        client.initialize().catch(e => addLog('error', `Reinit failed: ${e.message}`));
    }, 5000);
});

client.initialize().catch(e => addLog('error', `Initialize failed: ${e.message}`));

// ════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// FIX #1: Browser request → redirect ke /login, bukan JSON 401
// ════════════════════════════════════════════════════════════
const isAdmin = (req, res, next) => {
    if (req.session && req.session.authenticated) return next();
    // Cek apakah request dari browser atau API
    const wantsJSON = req.xhr || req.headers['accept']?.includes('application/json') || req.path.startsWith('/api/');
    if (wantsJSON) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');          // Browser → redirect ke halaman login
};

// ════════════════════════════════════════════════════════════
// ROUTES — PUBLIC (tanpa auth)
// ════════════════════════════════════════════════════════════

// FIX #2: Tambah route eksplisit untuk halaman login
app.get('/login', (req, res) => {
    if (req.session && req.session.authenticated) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health check (tidak butuh auth — untuk Railway healthcheck)
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
        database: dbStatus,
    };
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validUser = process.env.ADMIN_USERNAME || 'admin';
    const validPass = process.env.ADMIN_PASSWORD || 'admin123';

    if (username === validUser && password === validPass) {
        req.session.authenticated = true;
        req.session.loginAt = new Date().toISOString();
        addLog('info', `Admin login from ${req.ip}`);
        res.json({ success: true });
    } else {
        addLog('warn', `Failed login: ${username} from ${req.ip}`);
        res.status(401).json({ success: false });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

// ════════════════════════════════════════════════════════════
// ROUTES — PROTECTED (butuh auth)
// ════════════════════════════════════════════════════════════
app.get('/', isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Users list dengan pagination + search + filter
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
        res.json({ users: data || [], pagination: { page, limit, total: count || 0, totalPages: Math.ceil((count || 0) / limit) } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update status user
app.post('/api/admin/user/:id/status', isAdmin, async (req, res) => {
    const { id }     = req.params;
    const { status } = req.body;

    if (!['demo', 'pro', 'unlimited'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    try {
        const updates = {
            status,
            upgrade_notified: false,
            is_upgrading    : false,
            upgrade_package : null,
        };

        if (status === 'pro') {
            updates.subscription_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        } else if (status === 'unlimited') {
            updates.subscription_expires_at = null;
        } else {
            updates.subscription_expires_at = null;
        }

        const { error } = await supabase.from('users').update(updates).eq('id', id);
        if (error) throw error;

        // Kirim notif WA jika bot online
        if (clientReady) {
            const msgs = {
                demo     : 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).',
                pro      : '🎉 Selamat! Akun Anda sekarang PRO aktif 30 hari. ⭐',
                unlimited: '💎 Selamat! Akun Anda sekarang UNLIMITED seumur hidup!',
            };
            client.sendMessage(id, msgs[status]).catch(e => addLog('warn', `WA notif failed: ${e.message}`));
        }

        addLog('info', `User ${id} → ${status}`);
        io.emit('user_updated', { id, status });
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle maintenance
app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
    const { enabled } = req.body;
    try {
        await supabase.from('settings')
            .upsert({ key: 'maintenance_mode', value: String(Boolean(enabled)) });

        maintenanceMode = Boolean(enabled);
        addLog('info', `Maintenance: ${enabled ? 'ON' : 'OFF'}`);
        res.json({ success: true, maintenance: maintenanceMode });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Broadcast
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    const { message, target } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    if (!clientReady)     return res.status(503).json({ error: 'Bot belum online. Scan QR dulu.' });

    try {
        let query = supabase.from('users').select('id, store_name');
        if (target && target !== 'all') query = query.eq('status', target);
        const { data: users, error } = await query;
        if (error) throw error;

        const jobId = Date.now().toString();
        const job = { id: jobId, total: users.length, sent: 0, failed: 0, status: 'running', target: target || 'all' };
        activeBroadcasts.set(jobId, job);

        // Proses async — response langsung
        processBroadcast(jobId, users, message);

        addLog('info', `Broadcast started → ${users.length} users [${target}]`);
        res.json({ success: true, jobId, total: users.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/broadcast/:id', isAdmin, (req, res) => {
    const job = activeBroadcasts.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
});

async function processBroadcast(jobId, users, message) {
    const job = activeBroadcasts.get(jobId);
    for (let i = 0; i < users.length; i++) {
        try {
            const text = message.replace(/\{nama\}/g, users[i].store_name)
                                .replace(/\{nama_toko\}/gi, users[i].store_name);
            await client.sendMessage(users[i].id, text);
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
    addLog('info', `Broadcast done: ${job.sent} sent, ${job.failed} failed`);
}

// System logs
app.get('/api/admin/logs', isAdmin, (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    res.json(systemLogs.slice(0, limit));
});

// Bot status (untuk dashboard realtime)
app.get('/api/admin/status', isAdmin, (req, res) => {
    res.json({ status: botStatus, ready: clientReady, qr: currentQR, maintenance: maintenanceMode });
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO
// FIX #3: Gunakan sessionMiddleware yang SAMA dengan express
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.use((socket, next) => {
    if (socket.request.session?.authenticated) return next();
    // Jangan block socket — kirim state awal tapi tandai belum auth
    // Dashboard butuh QR bahkan sebelum login
    next();
});

io.on('connection', (socket) => {
    const isAuth = socket.request.session?.authenticated;
    addLog('info', `Client connected: ${socket.id} [${isAuth ? 'admin' : 'guest'}]`);

    // Kirim state awal — QR harus tampil meski belum login
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
        addLog('info', `Client disconnected: ${socket.id}`);
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
    console.error(`[FATAL] unhandledRejection: ${reason}`);
    addLog('error', `unhandledRejection: ${reason}`);
});

// ════════════════════════════════════════════════════════════
// START SERVER
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', () => {
    console.log(`\n🚀 DompetKu HQ running on port ${port}`);
    console.log(`   Dashboard : http://localhost:${port}`);
    console.log(`   Login     : http://localhost:${port}/login`);
    console.log(`   Health    : http://localhost:${port}/health\n`);
    addLog('info', `Server started on port ${port}`);
});
