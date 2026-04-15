'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcodeWeb = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Import handlers (pastikan file ini ada)
const { handleMessage } = require('./src/handlers/message');
const { initSchedulers } = require('./src/jobs/scheduler');
const supabase = require('./src/config/supabase');

// ════════════════════════════════════════════════════════════
// KONFIGURASI & MIDDLEWARE
// ════════════════════════════════════════════════════════════

app.use(session({
    secret: process.env.SESSION_SECRET || 'default-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.static('public'));

// Middleware Proteksi Admin
const isAdmin = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Rate limiting sederhana untuk broadcast
const broadcastCooldown = new Map();

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT STATE
// ════════════════════════════════════════════════════════════

let botStatus = 'Memulai...';
let currentQR = '';
let clientReady = false;
let maintenanceMode = false;

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
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
        executablePath: process.env.RAILWAY_ENVIRONMENT ? undefined : process.env.PUPPETEER_EXEC_PATH
    }
});

// ════════════════════════════════════════════════════════════
// AUTHENTICATION ENDPOINTS
// ════════════════════════════════════════════════════════════

app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    
    if (username === adminUser && password === adminPass) {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/admin/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// ════════════════════════════════════════════════════════════
// DASHBOARD & API ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', isAdmin, (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/admin-login.html', (req, res) => {
    res.sendFile(__dirname + '/public/admin-login.html');
});

// Get Dashboard Data
app.get('/api/admin/data', isAdmin, async (req, res) => {
    try {
        const { data: users, error: usersError } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false });
            
        if (usersError) throw usersError;

        const { data: settings, error: settingsError } = await supabase
            .from('settings')
            .select('*');
            
        if (settingsError) throw settingsError;

        const { data: upgradeRequests, error: reqError } = await supabase
            .from('upgrade_requests')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: false });
            
        if (reqError) throw reqError;

        maintenanceMode = settings?.find(s => s.key === 'maintenance_mode')?.value === 'true';

        res.json({ 
            users: users || [], 
            upgradeRequests: upgradeRequests || [],
            stats: { 
                total: users?.length || 0, 
                pro: users?.filter(u => u.status === 'pro').length || 0,
                demo: users?.filter(u => u.status === 'demo').length || 0,
                pendingRequests: upgradeRequests?.length || 0,
                maintenance: maintenanceMode,
                botStatus: botStatus,
                clientReady: clientReady
            } 
        });
    } catch (err) { 
        console.error('Error fetching admin data:', err);
        res.status(500).json({ error: err.message }); 
    }
});

// Toggle Maintenance Mode
app.post('/api/admin/toggle-maintenance', isAdmin, async (req, res) => {
    const { enabled } = req.body;
    try {
        await supabase
            .from('settings')
            .update({ value: enabled.toString(), updated_at: new Date() })
            .eq('key', 'maintenance_mode');

        maintenanceMode = enabled;

        const pesan = enabled 
            ? "🛠️ *PEMBERITAHUAN SISTEM*\n\nMohon maaf, saat ini sistem sedang dalam perbaikan. Bot tidak dapat merespon sementara waktu.\n\n_Kami akan mengabari jika sudah normal kembali._"
            : "✅ *SISTEM KEMBALI NORMAL*\n\nLayanan sudah selesai diperbaiki dan siap digunakan kembali. Terima kasih atas kesabaran Anda!";

        if (clientReady) {
            const { data: users } = await supabase.from('users').select('id');
            if (users) {
                // Kirim dengan delay untuk menghindari spam
                for (let i = 0; i < users.length; i++) {
                    setTimeout(async () => {
                        try {
                            await client.sendMessage(users[i].id, pesan);
                        } catch (e) {
                            console.error(`Failed to send to ${users[i].id}:`, e.message);
                        }
                    }, i * 1000); // Delay 1 detik per pesan
                }
            }
        }

        io.emit('maintenance_update', { enabled });
        res.json({ success: true, message: `Mode perbaikan ${enabled ? 'diaktifkan' : 'dimatikan'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
// USER MANAGEMENT API
// ════════════════════════════════════════════════════════════

// Toggle Package (Demo ↔ Pro)
app.post('/api/admin/user/:id/toggle-package', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        // Get current user data
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();
            
        if (error || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const newStatus = user.status === 'pro' ? 'demo' : 'pro';
        const { error: updateError } = await supabase
            .from('users')
            .update({ 
                status: newStatus, 
                updated_at: new Date(),
                activated_at: newStatus === 'pro' ? new Date() : user.activated_at
            })
            .eq('id', userId);

        if (updateError) throw updateError;

        // Send notification to user
        if (clientReady) {
            const notifMsg = newStatus === 'pro' 
                ? `🎉 *SELAMAT!*\n\nStatus akun Anda telah diupgrade ke *PAKET PRO*.\n\nNikmati fitur lengkap:\n✅ Unlimited transaksi\n✅ Laporan keuangan detail\n✅ Backup otomatis\n✅ Support priority\n\nTerima kasih telah mempercayai layanan kami!`
                : `ℹ️ *INFORMASI PAKET*\n\nStatus akun Anda telah diubah ke *PAKET DEMO*.\n\nFitur demo:\n⚡ 50 transaksi/bulan\n⚡ Laporan dasar\n⚡ Support email\n\nUpgrade ke PRO kapan saja untuk fitur lengkap.`;
            
            await client.sendMessage(userId, notifMsg);
        }

        io.emit('user_updated', { userId, newStatus });
        res.json({ success: true, newStatus, message: `Status diubah ke ${newStatus}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit User
app.put('/api/admin/user/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    const { store_name, status } = req.body;
    
    try {
        const updates = { updated_at: new Date() };
        if (store_name) updates.store_name = store_name;
        if (status) updates.status = status;
        if (status === 'pro' && !updates.activated_at) updates.activated_at = new Date();

        const { error } = await supabase
            .from('users')
            .update(updates)
            .eq('id', userId);

        if (error) throw error;

        io.emit('user_updated', { userId, ...updates });
        res.json({ success: true, message: 'User updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete User
app.delete('/api/admin/user/:id', isAdmin, async (req, res) => {
    const userId = req.params.id;
    try {
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', userId);
            
        if (error) throw error;
        
        io.emit('user_deleted', { userId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
// UPGRADE REQUEST MANAGEMENT
// ════════════════════════════════════════════════════════════

// Get Upgrade Requests
app.get('/api/admin/upgrade-requests', isAdmin, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('upgrade_requests')
            .select('*, users(store_name)')
            .order('created_at', { ascending: false });
            
        if (error) throw error;
        res.json({ requests: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Approve Upgrade
app.post('/api/admin/upgrade-requests/:id/approve', isAdmin, async (req, res) => {
    const requestId = req.params.id;
    try {
        // Get request details
        const { data: request, error: reqError } = await supabase
            .from('upgrade_requests')
            .select('*')
            .eq('id', requestId)
            .single();
            
        if (reqError || !request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        // Update user status to pro
        await supabase
            .from('users')
            .update({ 
                status: 'pro', 
                activated_at: new Date(),
                updated_at: new Date()
            })
            .eq('id', request.user_id);

        // Update request status
        await supabase
            .from('upgrade_requests')
            .update({ 
                status: 'approved', 
                processed_at: new Date(),
                processed_by: req.sessionID
            })
            .eq('id', requestId);

        // Send notification
        if (clientReady) {
            await client.sendMessage(request.user_id, 
                `🎉 *PERMINTAAN UPGRADE DITERIMA!*\n\nSelamat! Permintaan upgrade Anda telah disetujui.\n\nStatus: *PAKET PRO* ✅\nTanggal: ${new Date().toLocaleDateString('id-ID')}\n\nSilakan restart chat bot Anda untuk mengaktifkan fitur PRO.\nTerima kasih!`
            );
        }

        io.emit('request_processed', { requestId, status: 'approved' });
        res.json({ success: true, message: 'Upgrade approved' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reject Upgrade
app.post('/api/admin/upgrade-requests/:id/reject', isAdmin, async (req, res) => {
    const requestId = req.params.id;
    const { reason } = req.body;
    
    try {
        const { data: request } = await supabase
            .from('upgrade_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        await supabase
            .from('upgrade_requests')
            .update({ 
                status: 'rejected', 
                processed_at: new Date(),
                processed_by: req.sessionID,
                rejection_reason: reason || 'Tidak memenuhi syarat'
            })
            .eq('id', requestId);

        if (clientReady && request) {
            await client.sendMessage(request.user_id,
                `❌ *PERMINTAAN UPGRADE DITOLAK*\n\nMohon maaf, permintaan upgrade Anda belum dapat diproses.\n\nAlasan: ${reason || 'Tidak memenuhi syarat'}\n\nSilakan hubungi admin untuk informasi lebih lanjut.`
            );
        }

        io.emit('request_processed', { requestId, status: 'rejected' });
        res.json({ success: true, message: 'Upgrade rejected' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
// BROADCAST SYSTEM
// ════════════════════════════════════════════════════════════

app.post('/api/admin/broadcast', isAdmin, async (req, res) => {
    const { message, target, userIds } = req.body;
    
    if (!message || message.trim() === '') {
        return res.status(400).json({ error: 'Message is required' });
    }

    // Rate limiting check
    const now = Date.now();
    const lastBroadcast = broadcastCooldown.get(req.sessionID) || 0;
    if (now - lastBroadcast < 60000) { // 1 menit cooldown
        return res.status(429).json({ error: 'Please wait 1 minute between broadcasts' });
    }
    broadcastCooldown.set(req.sessionID, now);

    try {
        let targets = [];
        
        if (target === 'all') {
            const { data: users } = await supabase.from('users').select('id');
            targets = users.map(u => u.id);
        } else if (target === 'pro') {
            const { data: users } = await supabase.from('users').select('id').eq('status', 'pro');
            targets = users.map(u => u.id);
        } else if (target === 'demo') {
            const { data: users } = await supabase.from('users').select('id').eq('status', 'demo');
            targets = users.map(u => u.id);
        } else if (target === 'specific' && Array.isArray(userIds)) {
            targets = userIds;
        }

        if (targets.length === 0) {
            return res.status(400).json({ error: 'No targets found' });
        }

        if (!clientReady) {
            return res.status(503).json({ error: 'WhatsApp client not ready' });
        }

        // Send with delay (anti-spam)
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < targets.length; i++) {
            setTimeout(async () => {
                try {
                    await client.sendMessage(targets[i], `📢 *PENGUMUMAN*\n\n${message}\n\n_Dikirim oleh Admin DompetKu_`);
                    successCount++;
                    io.emit('broadcast_progress', { 
                        current: i + 1, 
                        total: targets.length, 
                        success: successCount, 
                        failed: failCount 
                    });
                } catch (e) {
                    failCount++;
                    console.error(`Failed to broadcast to ${targets[i]}:`, e.message);
                }
                
                if (i === targets.length - 1) {
                    io.emit('broadcast_complete', { success: successCount, failed: failCount });
                }
            }, i * 1500); // Delay 1.5 detik antar pesan
        }

        res.json({ 
            success: true, 
            message: `Broadcast queued to ${targets.length} users`,
            totalTargets: targets.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════
// WHATSAPP CLIENT EVENTS
// ════════════════════════════════════════════════════════════

client.on('qr', async (qr) => {
    botStatus = 'Scan QR';
    currentQR = await qrcodeWeb.toDataURL(qr);
    clientReady = false;
    io.emit('bot_update', { status: botStatus, qr: currentQR, ready: false });
});

client.on('ready', () => {
    botStatus = 'Online';
    clientReady = true;
    io.emit('bot_update', { status: botStatus, qr: null, ready: true });
    initSchedulers(client);
});

client.on('message', async (msg) => {
    // Check maintenance mode
    if (maintenanceMode) {
        // Hanya balas info maintenance, tidak proses pesan lain
        if (!msg.fromMe) {
            await msg.reply('🛠️ Sistem sedang dalam perbaikan. Mohon tunggu beberapa saat.');
        }
        return;
    }
    
    try {
        await handleMessage(msg, client);
        io.emit('new_log', { 
            from: msg.from, 
            body: msg.body,
            timestamp: new Date().toISOString(),
            type: 'incoming'
        });
    } catch (err) {
        console.error('Error handling message:', err);
        io.emit('new_log', { 
            error: err.message,
            timestamp: new Date().toISOString(),
            type: 'error'
        });
    }
});

client.on('disconnected', (reason) => {
    botStatus = 'Disconnected';
    clientReady = false;
    io.emit('bot_update', { status: botStatus, qr: null, ready: false });
    console.log('Client disconnected:', reason);
});

client.on('auth_failure', (msg) => {
    botStatus = 'Auth Failed';
    clientReady = false;
    io.emit('bot_update', { status: botStatus, qr: null, ready: false });
    console.error('Auth failure:', msg);
});

// Initialize client
client.initialize();

// ════════════════════════════════════════════════════════════
// ERROR HANDLING
// ════════════════════════════════════════════════════════════

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Start server
server.listen(port, '0.0.0.0', () => {
    console.log(`🚀 DompetKu running on port ${port}`);
    console.log(`📱 Environment: ${process.env.NODE_ENV || 'development'}`);
});