'use strict';

const supabase = require('../config/supabase');

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function formatQty(qty, unit) {
    const num = parseFloat(qty) || 0;
    if (['kg', 'liter', 'gram', 'ml'].includes(unit)) {
        return num.toFixed(2).replace(/\.?0+$/, '');
    }
    return Math.floor(num).toString();
}

function formatRupiah(amount) {
    return `Rp ${Number(amount).toLocaleString('id-ID')}`;
}

// ════════════════════════════════════════════════════════════
// PRODUCT MANAGEMENT
// ════════════════════════════════════════════════════════════

async function addProduct(userId, data) {
    const {
        sku, name, category, unit,
        priceBuy, priceSell, stockInitial, stockMin, description,
    } = data;

    if (!sku || !name) {
        return { success: false, error: 'SKU dan nama produk wajib diisi.' };
    }

    try {
        // Cek duplikasi SKU
        const { data: existing } = await supabase
            .from('products')
            .select('id')
            .eq('user_id', userId)
            .eq('sku', sku.toUpperCase())
            .maybeSingle();

        if (existing) {
            return { success: false, error: `SKU "${sku.toUpperCase()}" sudah digunakan. Gunakan SKU lain.` };
        }

        const { data: product, error } = await supabase
            .from('products')
            .insert([{
                user_id      : userId,
                sku          : sku.toUpperCase(),
                name,
                category     : category || 'Umum',
                unit         : unit || 'pcs',
                price_buy    : priceBuy || 0,
                price_sell   : priceSell || 0,
                stock_current: stockInitial || 0,
                stock_min    : stockMin || 0,
                description  : description || null,
            }])
            .select()
            .single();

        if (error) throw error;

        // ── Log initial stock via RPC jika > 0 ──────────────────
        if (parseFloat(stockInitial) > 0) {
            await supabase.rpc('adjust_stock_atomic', {
                p_product_id    : product.id,
                p_user_id       : userId,
                p_type          : 'adjustment',
                p_quantity      : parseFloat(stockInitial),
                p_reference_type: 'initial',
                p_note          : 'Stock awal saat produk ditambahkan',
            });
        }

        return { success: true, product, error: null };
    } catch (err) {
        console.error('[STOCK] addProduct error:', err.message);
        return { success: false, error: err.message };
    }
}

async function updateProduct(userId, productId, updates) {
    try {
        const allowed = [
            'name', 'category', 'unit', 'price_buy',
            'price_sell', 'stock_min', 'description', 'is_active',
        ];
        const payload = {};
        Object.keys(updates).forEach(k => {
            if (allowed.includes(k)) payload[k] = updates[k];
        });

        if (Object.keys(payload).length === 0) {
            return { success: false, error: 'Tidak ada data yang diupdate.' };
        }

        const { data, error } = await supabase
            .from('products')
            .update(payload)
            .eq('id', productId)
            .eq('user_id', userId)
            .select()
            .single();

        if (error) throw error;
        return { success: true, product: data, error: null };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function deleteProduct(userId, productId) {
    try {
        const { error } = await supabase
            .from('products')
            .update({ is_active: false })
            .eq('id', productId)
            .eq('user_id', userId);

        if (error) throw error;
        return { success: true, error: null };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function getProduct(userId, skuOrId) {
    try {
        let query = supabase
            .from('products')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true);

        if (isNaN(skuOrId)) {
            query = query.eq('sku', String(skuOrId).toUpperCase());
        } else {
            query = query.eq('id', parseInt(skuOrId));
        }

        const { data, error } = await query.maybeSingle();
        if (error) throw error;
        if (!data) return { success: false, product: null, error: 'Produk tidak ditemukan.' };
        return { success: true, product: data, error: null };
    } catch (err) {
        return { success: false, product: null, error: err.message };
    }
}

async function listProducts(userId, filters = {}) {
    try {
        let query = supabase
            .from('products')
            .select('*')
            .eq('user_id', userId);

        if (filters.active !== undefined) {
            query = query.eq('is_active', filters.active);
        } else {
            query = query.eq('is_active', true); // default hanya tampilkan aktif
        }

        if (filters.category) {
            query = query.eq('category', filters.category);
        }

        // lowStock: filter di aplikasi karena Supabase tidak support column comparison langsung
        query = query.order('name', { ascending: true });

        const { data, error } = await query;
        if (error) throw error;

        let products = data || [];

        // Filter low stock di sisi Node jika diminta
        if (filters.lowStock) {
            products = products.filter(p =>
                parseFloat(p.stock_current) <= parseFloat(p.stock_min)
            );
        }

        return { success: true, products, error: null };
    } catch (err) {
        return { success: false, products: [], error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// STOCK ADJUSTMENT — ATOMIC via RPC (FIX RACE CONDITION)
// Semua kalkulasi dilakukan di PostgreSQL dalam satu transaksi
// Node.js TIDAK melakukan kalkulasi stok apapun
// ════════════════════════════════════════════════════════════

async function adjustStock(userId, productId, type, quantity, options = {}) {
    const { referenceType = 'manual', referenceId, note } = options;

    try {
        // ── Panggil RPC atomic — satu roundtrip, zero race condition ──
        const { data: rpcResult, error: rpcErr } = await supabase.rpc('adjust_stock_atomic', {
            p_product_id    : productId,
            p_user_id       : userId,
            p_type          : type,
            p_quantity      : parseFloat(quantity),
            p_reference_type: referenceType,
            p_note          : note || null,
        });

        if (rpcErr) {
            console.error('[STOCK] RPC error:', rpcErr.message);
            return { success: false, error: rpcErr.message };
        }

        // RPC mengembalikan JSON object
        const result = typeof rpcResult === 'string' ? JSON.parse(rpcResult) : rpcResult;

        if (!result.success) {
            return { success: false, error: result.error };
        }

        // ── Cek alert setelah update berhasil ──────────────────
        const stockAfter = parseFloat(result.stock_after);
        const stockMin   = parseFloat(result.stock_min);

        if (stockAfter <= 0) {
            await createStockAlert(userId, productId, 'out_of_stock', stockAfter);
        } else if (stockAfter <= stockMin) {
            await createStockAlert(userId, productId, 'low_stock', stockAfter);
        } else {
            // Stock kembali aman — resolve alert lama
            await resolveStockAlerts(productId);
        }

        return {
            success    : true,
            stockBefore: parseFloat(result.stock_before),
            stockAfter,
            product    : {
                id        : productId,
                name      : result.name,
                sku       : result.sku,
                unit      : result.unit,
                stock_min : stockMin,
                price_buy : parseFloat(result.price_buy),
                price_sell: parseFloat(result.price_sell),
            },
            error: null,
        };
    } catch (err) {
        console.error('[STOCK] adjustStock error:', err.message);
        return { success: false, error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// STOCK HISTORY
// ════════════════════════════════════════════════════════════

async function getStockHistory(userId, productId, limit = 20) {
    try {
        const { data, error } = await supabase
            .from('stock_movements')
            .select('*')
            .eq('user_id', userId)
            .eq('product_id', productId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return { success: true, movements: data || [], error: null };
    } catch (err) {
        return { success: false, movements: [], error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// STOCK ALERTS
// ════════════════════════════════════════════════════════════

async function createStockAlert(userId, productId, alertType, stockLevel) {
    try {
        // Cek apakah alert serupa sudah ada dalam 24 jam (prevent spam)
        const { data: recent } = await supabase
            .from('stock_alerts')
            .select('id')
            .eq('product_id', productId)
            .eq('alert_type', alertType)
            .is('resolved_at', null)
            .gte('alerted_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .maybeSingle();

        if (recent) return; // Sudah ada, skip

        await supabase.from('stock_alerts').insert([{
            user_id    : userId,
            product_id : productId,
            alert_type : alertType,
            stock_level: stockLevel,
        }]);
    } catch (err) {
        console.error('[STOCK] createStockAlert error:', err.message);
    }
}

async function resolveStockAlerts(productId) {
    try {
        await supabase
            .from('stock_alerts')
            .update({ resolved_at: new Date().toISOString() })
            .eq('product_id', productId)
            .is('resolved_at', null);
    } catch (err) {
        console.error('[STOCK] resolveStockAlerts error:', err.message);
    }
}

async function getPendingAlerts(userId) {
    try {
        let query = supabase
            .from('stock_alerts')
            .select(`*, products (id, sku, name, unit, stock_current, stock_min)`)
            .is('resolved_at', null)
            .order('alerted_at', { ascending: false });

        // Jika userId null → ambil semua (untuk scheduler)
        if (userId) query = query.eq('user_id', userId);

        const { data, error } = await query;
        if (error) throw error;
        return { success: true, alerts: data || [], error: null };
    } catch (err) {
        return { success: false, alerts: [], error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// STOCK REPORT
// ════════════════════════════════════════════════════════════

async function generateStockReport(userId) {
    try {
        const { data: products, error } = await supabase
            .from('products')
            .select('*')
            .eq('user_id', userId)
            .eq('is_active', true)
            .order('category', { ascending: true })
            .order('name', { ascending: true });

        if (error) throw error;

        let totalValue    = 0;
        let totalItems    = 0;
        let lowStockCount = 0;
        let outStockCount = 0;
        const byCategory  = {};

        (products || []).forEach(p => {
            const stockVal = parseFloat(p.stock_current) * parseFloat(p.price_buy);
            totalValue += stockVal;
            totalItems++;

            if (parseFloat(p.stock_current) <= 0)              outStockCount++;
            else if (parseFloat(p.stock_current) <= parseFloat(p.stock_min)) lowStockCount++;

            if (!byCategory[p.category]) {
                byCategory[p.category] = { count: 0, value: 0, items: [] };
            }
            byCategory[p.category].count++;
            byCategory[p.category].value += stockVal;
            byCategory[p.category].items.push(p);
        });

        return {
            success      : true,
            totalProducts: totalItems,
            totalValue,
            lowStockCount,
            outStockCount,
            byCategory,
            products,
            error        : null,
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    addProduct,
    updateProduct,
    deleteProduct,
    getProduct,
    listProducts,
    adjustStock,
    getStockHistory,
    getPendingAlerts,
    resolveStockAlerts,
    generateStockReport,
    formatQty,
    formatRupiah,
};