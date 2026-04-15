'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeWeb = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session = require('express-session');
require('dotenv').config();

// Pastikan file handler & scheduler ini sudah ada di folder src Anda
const { handleMessage } = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase = require('./src/config/supabase');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// 1. SETUP SESSION (Proteksi Login)
app.use(session({
    secret: 'kuncirahasia-dompetku-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Login aktif 24 jam
}));

app.use(express.json());

// 2. MIDDLEWARE PROTEKSI
// Fungsi ini menjaga agar orang asing tidak bisa langsung masuk ke dashboard
const isAdmin = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/admin-login.html');
    }
};

// 3. ENDPOINT AUTHENTICATION
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Gunakan username & password ini (Bisa dipindah ke .env nantinya)
    if (username === 'admin' && password === 'admin123') {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// 4. ROUTING DASHBOARD (Hanya bisa dibuka jika sudah login)
app.get('/', isAdmin, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Melayani file statis (css, js, gambar)
app.use(express.static('public'));

// 5. API DATA UNTUK DASHBOARD
app.get('/api/admin/data', isAdmin, async (req, res) => {
    try {
        const { data: users } = await supabase.from('users').select('*').order('created_at', { ascending: false });
        const { data: settings } = await supabase.from('settings').select('*');
        const isMaint = settings?.find(s => s.key === 'maintenance_mode')?.value === 'true';

        res.json({ 
            users, 
            stats: { 
                total: users.length, 
                pro: users.filter(u => u.status !== 'demo').length,
                maintenance: isMaint
            } 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Tambahkan endpoint ini di bagian API ENDPOINTS di index.js
app.post('/api/admin/toggle-maintenance', isAdmin, async (req, res) => {
    const { enabled } = req.body;
    try {
        // 1. Update status di database Supabase
        await supabase
            .from('settings')
            .update({ value: enabled.toString() })
            .eq('key', 'maintenance_mode');

        // 2. Ambil semua user untuk dikirimkan pesan otomatis
        const { data: users } = await supabase.from('users').select('id');
        
        const pesan = enabled 
            ? "🛠️ *PEMBERITAHUAN SISTEM*\n\nMohon maaf, saat ini sistem DompetKu sedang dalam perbaikan untuk meningkatkan layanan. Bot tidak dapat merespon sementara waktu. Kami akan mengabari jika sudah normal kembali."
            : "✅ *SISTEM KEMBALI NORMAL*\n\nLayanan DompetKu sudah selesai diperbaiki dan siap digunakan kembali. Terima kasih atas kesabaran Anda!";

        // 3. Kirim pesan otomatis (Hanya jika bot Online)
        if (botStatus === 'Online' && users) {
            for (const user of users) {
                await client.sendMessage(user.id, pesan);
            }
        }

        res.json({ success: true, message: `Mode perbaikan berhasil di${enabled ? 'aktifkan' : 'matikan'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT (OPTIMIZED FOR RAILWAY)
// ════════════════════════════════════════════════════════════
let botStatus = 'Memulai...';
let currentQR = '';

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' // Folder ini akan tersimpan permanen di Volume
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--single-process', // Menghemat RAM drastis di Railway
            '--no-zygote',
            '--disable-gpu'
        ],
        executablePath: process.env.RAILWAY_ENVIRONMENT ? undefined : 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
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
    // Kirim data ke Terminal Log di Dashboard secara realtime
    io.emit('new_log', { from: msg.from, body: msg.body });
});

client.initialize();

// BIND KE 0.0.0.0 agar Railway bisa mengakses aplikasi
server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 HQ DompetKu mengudara di port ${port}`);
});