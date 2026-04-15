'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeWeb = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session = require('express-session');
const os = require('os');
require('dotenv').config();

// Existing imports
const { handleMessage } = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase = require('./src/config/supabase');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════
// SIMPLE AUTH PERSISTENCE UNTUK RAILWAY (Tanpa Folder Baru)
// ════════════════════════════════════════════════════════════
const SESSION_TABLE = 'wa_sessions';

// Helper: Save session ke Supabase
async function saveSessionToDB(sessionData) {
    try {
        const { error } = await supabase
            .from(SESSION_TABLE)
            .upsert({ 
                id: 'main', 
                data: JSON.stringify(sessionData),
                updated_at: new Date().toISOString()
            });
        if (error) console.error('Error saving session:', error);
        else console.log('✅ Session saved to database');
    } catch (e) {
        console.error('Failed to save session:', e);
    }
}

// Helper: Load session dari Supabase
async function loadSessionFromDB() {
    try {
        const { data, error } = await supabase
            .from(SESSION_TABLE)
            .select('data')
            .eq('id', 'main')
            .single();
        
        if (error || !data) return null;
        return JSON.parse(data.data);
    } catch (e) {
        console.error('Failed to load session:', e);
        return null;
    }
}

// ════════════════════════════════════════════════════════════
// SETUP MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.use(session({
    secret: process.env.SESSION_SECRET || 'dompetku-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static('public'));

// ════════════════════════════════════════════════════════════
// GLOBAL STATE & HEALTH MONITORING
// ════════════════════════════════════════════════════════════
let botStatus = 'Initializing...';
let currentQR = '';
let clientReady = false;
let maintenanceMode = false;
let systemLogs = []; // Buffer untuk terminal dashboard
let activeBroadcasts = new Map();

const addSystemLog = (level, message, data = {}) => {
    const log = {
        timestamp: new Date().toISOString(),
        level,
        message,
        data,
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    };
    systemLogs.unshift(log);
    if (systemLogs.length > 1000) systemLogs.pop(); // Keep last 1000
    
    // Broadcast ke semua admin yang online
    io.emit('system_log', log);
};

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT (Dengan Auto-Save Session)
// ════════════════════════════════════════════════════════════
const client = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: '/tmp/wa-session' // Railway temp folder (survive restart tapi tidak redeploy)
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process',
            '--no-zygote',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXEC_PATH || undefined
    },
    restartOnAuthFail: true
});

// Event: QR Generated
client.on('qr', async (qr) => {
    botStatus = 'Scan QR';
    currentQR = await qrcodeWeb.toDataURL(qr);
    clientReady = false;
    addSystemLog('warn', 'QR Code generated - Scan required');
    io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
});

// Event: Authenticated (Save ke DB untuk backup)
client.on('authenticated', async (session) => {
    addSystemLog('info', 'WhatsApp authenticated');
    await saveSessionToDB(session);
});

// Event: Ready
client.on('ready', () => {
    botStatus = 'Online';
    clientReady = true;
    addSystemLog('info', 'WhatsApp client ready');
    io.emit('bot_update', { status: botStatus, qr: null, ready: true });
    initSchedulers(client);
});

// Event: Message
client.on('message', async (msg) => {
    if (maintenanceMode && !msg.fromMe) {
        await msg.reply('🛠️ Sistem sedang dalam perbaikan.');
        return;
    }
    
    try {
        addSystemLog('info', `Message from ${msg.from}`, { body: msg.body?.substring(0, 50) });
        await handleMessage(msg, client);
        io.emit('new_log', { 
            from: msg.from, 
            body: msg.body,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        addSystemLog('error', `Message handling error: ${err.message}`);
    }
});

// Event: Disconnected (Auto reconnect)
client.on('disconnected', (reason) => {
    botStatus = 'Disconnected';
    clientReady = false;
    addSystemLog('error', `Disconnected: ${reason}`);
    io.emit('bot_update', { status: botStatus, ready: false });
    
    // Auto reconnect setelah 5 detik
    setTimeout(() => {
        addSystemLog('info', 'Attempting to reconnect...');
        client.initialize();
    }, 5000);
});

// Inisialisasi dengan cek session DB (fallback)
client.initialize();

// ════════════════════════════════════════════════════════════
// AUTHENTICATION MIDDLEWARE
// ════════════════════════════════════════════════════════════
const isAdmin = (req, res, next) => {
    if (req.session.authenticated) next();
    else res.status(401).json({ error: 'Unauthorized' });
};

// ════════════════════════════════════════════════════════════
// HEALTH CHECK & METRICS (Untuk Railway & Dashboard)
// ════════════════════════════════════════════════════════════
app.get('/health', async (req, res) => {
    const used = process.memoryUsage();
    const uptime = process.uptime();
    
    // Cek DB
    let dbStatus = 'error';
    try {
        const { error } = await supabase.from('users').select('id').limit(1);
        dbStatus = error ? 'error' : 'connected';
    } catch (e) {
        dbStatus = 'error';
    }
    
    const health = {
        status: clientReady && dbStatus === 'connected' ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        whatsapp: {
            status: botStatus,
            ready: clientReady
        },
        system: {
            memory: {
                used: Math.round(used.heapUsed / 1024 / 1024),
                total: Math.round(used.heapTotal / 1024 / 1024),
                percentage: Math.round((used.heapUsed / used.heapTotal) * 100)
            },
            cpu: os.loadavg(),
            platform: os.platform()
        },
        database: dbStatus
    };
    
    res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === (process.env.ADMIN_USERNAME || 'admin') && 
        password === (process.env.ADMIN_PASSWORD || 'admin123')) {
        req.session.authenticated = true;
        addSystemLog('info', `Admin login from ${req.ip}`);
        res.json({ success: true });
    } else {
        addSystemLog('warn', `Failed login attempt: ${username}`);
        res.status(401).json({ success: false });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// DASHBOARD API (Modern dengan Pagination & Filter)
// ════════════════════════════════════════════════════════════
app.get('/', isAdmin, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Get users dengan pagination, search, filter
app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
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
            users: data,
            pagination: {
                page, limit, total: count,
                totalPages: Math.ceil(count / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle status dengan switch (demo/pro/unlimited)
app.post('/api/admin/user/:id/status', isAdmin, async (req, res) => {
    const { id } = req.params;
    const { status } = req.body; // 'demo', 'pro', 'unlimited'
    
    try {
        const updates = { status, updated_at: new Date().toISOString() };
        
        if (status === 'pro') {
            updates.subscription_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        } else if (status === 'unlimited') {
            updates.subscription_expires_at = null;
        }
        
        const { error } = await supabase.from('users').update(updates).eq('id', id);
        if (error) throw error;
        
        // Kirim notifikasi WA
        if (clientReady) {
            const msg = status === 'demo' 
                ? 'ℹ️ Status akun Anda diubah ke DEMO (5 transaksi/hari).'
                : status === 'pro' 
                ? '🎉 Selamat! Akun Anda sekarang PRO (30 hari).'
                : '💎 Akun Anda sekarang UNLIMITED seumur hidup!';
            await client.sendMessage(id, msg);
        }
        
        addSystemLog('info', `User ${id} status changed to ${status}`);
        io.emit('user_updated', { id, status });
        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Maintenance toggle
app.post('/api/admin/maintenance', isAdmin, async (req, res) => {
    const { enabled } = req.body;
    try {
        await supabase.from('settings')
            .update({ value: enabled.toString() })
            .eq('key', 'maintenance_mode');
        
        maintenanceMode = enabled;
        
        // Broadcast ke semua user
        if (clientReady) {
            const { data: users } = await supabase.from('users').select('id');
            const msg = enabled 
                ? '🛠️ Sistem sedang maintenance.' 
                : '✅ Sistem kembali normal.';
            
            // Kirim dengan delay
            for (let i = 0; i < users.length; i++) {
                setTimeout(() => {
                    client.sendMessage(users[i].id, msg).catch(console.error);
                }, i * 1000);
            }
        }
        
        addSystemLog('info', `Maintenance mode ${enabled ? 'enabled' : 'disabled'}`);
        res.json({ success: true, maintenance: enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Broadcast dengan filter status
app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    const { message, target } = req.body; // target: 'all', 'demo', 'pro', 'unlimited'
    
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    
    try {
        let query = supabase.from('users').select('id, store_name');
        if (target && target !== 'all') query = query.eq('status', target);
        
        const { data: users, error } = await query;
        if (error) throw error;
        
        // Buat broadcast job
        const jobId = Date.now().toString();
        const job = {
            id: jobId,
            total: users.length,
            sent: 0,
            failed: 0,
            status: 'running',
            target: target || 'all'
        };
        activeBroadcasts.set(jobId, job);
        
        // Process async
        processBroadcast(jobId, users, message);
        
        addSystemLog('info', `Broadcast started: ${users.length} users (${target})`);
        res.json({ success: true, jobId, total: users.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get broadcast progress
app.get('/api/admin/broadcast/:id', isAdmin, (req, res) => {
    const job = activeBroadcasts.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    res.json(job);
});

// Async broadcast processor
async function processBroadcast(jobId, users, message) {
    const job = activeBroadcasts.get(jobId);
    
    for (let i = 0; i < users.length; i++) {
        try {
            await client.sendMessage(users[i].id, message.replace(/{nama}/g, users[i].store_name));
            job.sent++;
        } catch (err) {
            job.failed++;
        }
        
        // Update progress setiap 5 user
        if (i % 5 === 0 || i === users.length - 1) {
            job.progress = Math.round((i / users.length) * 100);
            io.emit('broadcast_progress', {
                jobId,
                current: i + 1,
                total: users.length,
                sent: job.sent,
                failed: job.failed
            });
        }
        
        // Delay 1.2 detik antar pesan (anti-ban)
        await new Promise(r => setTimeout(r, 1200));
    }
    
    job.status = 'completed';
    job.completedAt = new Date();
    io.emit('broadcast_complete', { jobId, ...job });
    addSystemLog('info', `Broadcast completed: ${job.sent} sent, ${job.failed} failed`);
}

// Get system logs untuk terminal
app.get('/api/admin/logs', isAdmin, (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    res.json(systemLogs.slice(0, limit));
});

// ════════════════════════════════════════════════════════════
// SOCKET.IO (Real-time)
// ════════════════════════════════════════════════════════════
io.use((socket, next) => {
    session(socket.request, {}, next);
});

io.use((socket, next) => {
    if (socket.request.session?.authenticated) next();
    else next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
    addSystemLog('info', `Admin connected: ${socket.id}`);
    
    // Kirim current state
    socket.emit('bot_update', { status: botStatus, qr: currentQR, ready: clientReady });
    socket.emit('logs_history', systemLogs.slice(0, 50));
    
    socket.on('request_reconnect', () => {
        if (!clientReady) {
            addSystemLog('info', 'Manual reconnect requested');
            client.initialize();
        }
    });
    
    socket.on('disconnect', () => {
        addSystemLog('info', `Admin disconnected: ${socket.id}`);
    });
});

// ════════════════════════════════════════════════════════════
// SERVER START
// ════════════════════════════════════════════════════════════
server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 DompetKu running on port ${port}`);
    addSystemLog('info', 'Server started');
});