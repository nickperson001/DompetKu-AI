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

/**
 * Tambah produk baru
 * @returns {object} { success, product, error }
 */
async function addProduct(userId, data) {
    const { sku, name, category, unit, priceBuy, priceSell, stockInitial, stockMin, description } = data;

    // Validasi
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
            .single();

        if (existing) {
            return { success: false, error: `SKU "${sku}" sudah digunakan. Gunakan SKU lain.` };
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

        // Log initial stock jika > 0
        if (stockInitial > 0) {
            await logStockMovement(userId, product.id, {
                type         : 'in',
                quantity     : stockInitial,
                stockBefore  : 0,
                stockAfter   : stockInitial,
                referenceType: 'initial',
                note         : 'Stock awal saat produk ditambahkan',
            });
        }

        return { success: true, product, error: null };
    } catch (err) {
        console.error('[STOCK] addProduct error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Update produk (harga, nama, dll — BUKAN stock)
 */
async function updateProduct(userId, productId, updates) {
    try {
        const allowed = ['name', 'category', 'unit', 'price_buy', 'price_sell', 'stock_min', 'description', 'is_active'];
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

/**
 * Hapus produk (soft delete)
 */
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

/**
 * Get produk by SKU atau ID
 */
async function getProduct(userId, skuOrId) {
    try {
        let query = supabase.from('products').select('*').eq('user_id', userId);

        if (isNaN(skuOrId)) {
            // SKU
            query = query.eq('sku', skuOrId.toUpperCase());
        } else {
            // ID
            query = query.eq('id', parseInt(skuOrId));
        }

        const { data, error } = await query.single();
        if (error) throw error;
        return { success: true, product: data, error: null };
    } catch (err) {
        return { success: false, product: null, error: err.message };
    }
}

/**
 * List semua produk user (dengan filter)
 */
async function listProducts(userId, filters = {}) {
    try {
        let query = supabase
            .from('products')
            .select('*')
            .eq('user_id', userId);

        if (filters.active !== undefined) {
            query = query.eq('is_active', filters.active);
        }

        if (filters.category) {
            query = query.eq('category', filters.category);
        }

        if (filters.lowStock) {
            // Stock di bawah minimum
            query = query.lt('stock_current', supabase.raw('stock_min'));
        }

        query = query.order('name', { ascending: true });

        const { data, error } = await query;
        if (error) throw error;

        return { success: true, products: data || [], error: null };
    } catch (err) {
        return { success: false, products: [], error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// STOCK MOVEMENT
// ════════════════════════════════════════════════════════════

/**
 * Adjust stock (IN/OUT/ADJUSTMENT)
 * @param {string} type - 'in', 'out', 'adjustment'
 */
async function adjustStock(userId, productId, type, quantity, options = {}) {
    const { referenceType, referenceId, note } = options;

    try {
        // Get current product
        const { data: product, error: prodErr } = await supabase
            .from('products')
            .select('*')
            .eq('id', productId)
            .eq('user_id', userId)
            .single();

        if (prodErr || !product) {
            return { success: false, error: 'Produk tidak ditemukan.' };
        }

        const stockBefore = parseFloat(product.stock_current) || 0;
        let stockAfter = stockBefore;

        if (type === 'in') {
            stockAfter = stockBefore + parseFloat(quantity);
        } else if (type === 'out') {
            stockAfter = stockBefore - parseFloat(quantity);
            if (stockAfter < 0) {
                return { success: false, error: `Stock tidak cukup. Stock saat ini: ${formatQty(stockBefore, product.unit)} ${product.unit}` };
            }
        } else if (type === 'adjustment') {
            stockAfter = parseFloat(quantity);
        }

        // Update stock di produk
        const { error: updateErr } = await supabase
            .from('products')
            .update({ stock_current: stockAfter })
            .eq('id', productId);

        if (updateErr) throw updateErr;

        // Log movement
        await logStockMovement(userId, productId, {
            type,
            quantity     : Math.abs(parseFloat(quantity)),
            stockBefore,
            stockAfter,
            referenceType: referenceType || 'manual',
            referenceId  : referenceId || null,
            note         : note || null,
        });

        // Check alert
        if (stockAfter <= product.stock_min && stockAfter > 0) {
            await createStockAlert(userId, productId, 'low_stock', stockAfter);
        } else if (stockAfter <= 0) {
            await createStockAlert(userId, productId, 'out_of_stock', stockAfter);
        }

        return {
            success    : true,
            stockBefore,
            stockAfter,
            product,
            error      : null,
        };
    } catch (err) {
        console.error('[STOCK] adjustStock error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Log stock movement (internal)
 */
async function logStockMovement(userId, productId, data) {
    try {
        await supabase.from('stock_movements').insert([{
            user_id       : userId,
            product_id    : productId,
            type          : data.type,
            quantity      : data.quantity,
            stock_before  : data.stockBefore,
            stock_after   : data.stockAfter,
            reference_type: data.referenceType,
            reference_id  : data.referenceId,
            note          : data.note,
            created_by    : data.createdBy || 'system',
        }]);
    } catch (err) {
        console.error('[STOCK] logStockMovement error:', err.message);
    }
}

/**
 * Get history pergerakan stock produk
 */
async function getStockHistory(userId, productId, limit = 50) {
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
        // Cek apakah sudah pernah dikirim dalam 24 jam terakhir (prevent spam)
        const { data: recent } = await supabase
            .from('stock_alerts')
            .select('id')
            .eq('product_id', productId)
            .eq('alert_type', alertType)
            .is('resolved_at', null)
            .gte('alerted_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .single();

        if (recent) return; // Sudah ada alert yang belum resolved

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

/**
 * Resolve alert (saat stock kembali aman)
 */
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

/**
 * Get pending alerts untuk user
 */
async function getPendingAlerts(userId) {
    try {
        const { data, error } = await supabase
            .from('stock_alerts')
            .select(`
                *,
                products (id, sku, name, unit, stock_current, stock_min)
            `)
            .eq('user_id', userId)
            .is('resolved_at', null)
            .order('alerted_at', { ascending: false });

        if (error) throw error;
        return { success: true, alerts: data || [], error: null };
    } catch (err) {
        return { success: false, alerts: [], error: err.message };
    }
}

// ════════════════════════════════════════════════════════════
// LAPORAN STOCK
// ════════════════════════════════════════════════════════════

/**
 * Generate laporan stock (snapshot saat ini)
 */
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

        let totalValue = 0;
        const byCategory = {};

        (products || []).forEach(p => {
            const value = parseFloat(p.stock_current) * parseFloat(p.price_buy);
            totalValue += value;

            if (!byCategory[p.category]) {
                byCategory[p.category] = { count: 0, value: 0, items: [] };
            }
            byCategory[p.category].count++;
            byCategory[p.category].value += value;
            byCategory[p.category].items.push(p);
        });

        return {
            success     : true,
            totalProducts: products.length,
            totalValue,
            byCategory,
            products,
            error       : null,
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