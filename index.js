'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeWeb = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session = require('express-session'); // Tambahkan ini
require('dotenv').config();

const { handleMessage, invalidateMaintenanceCache } = require('./src/handlers/message');
const { initSchedulers, sendUpgradeNotification }   = require('./src/jobs/scheduler');
const supabase = require('./src/config/supabase');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT;

// 1. SETUP SESSION (Penting untuk Login)
app.use(session({
    secret: 'kawancuan-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set true jika pakai HTTPS
}));

app.use(express.json());

// 2. PROTEKSI DASHBOARD (Mencegah akses tanpa login)
const authMiddleware = (req, res, next) => {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin-login.html');
    }
};

// Endpoint Login
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Password default: admin123
    if (username === 'admin' && password === 'admin123') {
        req.session.isAdmin = true;
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: 'Salah password Bos!' });
});

// Endpoint Logout
app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Dashboard hanya bisa dibuka jika sudah login
app.get('/index.html', authMiddleware, (req, res, next) => {
    next();
});

app.use(express.static('public'));

// ════════════════════════════════════════════════════════════
// API ENDPOINTS (Hanya bisa diakses jika sudah login)
// ════════════════════════════════════════════════════════════

app.get('/api/admin/data', authMiddleware, async (req, res) => {
    try {
        const { data: users, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
        const { data: settings } = await supabase.from('settings').select('*');
        const maintenanceMode = settings?.find(s => s.key === 'maintenance_mode')?.value === 'true';
        res.json({ users, stats: { total: users.length, pro: users.filter(u => u.status !== 'demo').length, maintenance: maintenanceMode } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ... (Simpan API Update User & Broadcast Mas yang lama di sini, tapi tambahkan authMiddleware) ...

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT
// ════════════════════════════════════════════════════════════
let botStatus = 'Memulai...';
let currentQR = '';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process'
        ],
        // Jika jalan di Railway, biarkan undefined agar Puppeteer mencari Chromium bawaannya otomatis.
        // Jika di lokal, tetap gunakan Brave.
        executablePath: process.env.RAILWAY_ENVIRONMENT 
            ? undefined 
            : 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    }
});

client.on('qr', async (qr) => {
    botStatus = 'Scan QR';
    currentQR = await qrcodeWeb.toDataURL(qr);
    io.emit('bot_update', { status: botStatus, qr: currentQR });
});

client.on('ready', () => {
    botStatus = 'Online';
    io.emit('bot_update', { status: botStatus, qr: null });
    initSchedulers(client);
});

client.on('message', async (msg) => {
    await handleMessage(msg, client);
    io.emit('new_log', { from: msg.from, body: msg.body });
});

client.initialize();

server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 DompetKu siap di http://localhost:${port}`);
});