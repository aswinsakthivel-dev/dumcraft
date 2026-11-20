// Cloudflare Pages Function: DumCraft API Router

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Team-Key',
      ...headers
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message, success: false }, status);
}

// Simple in-memory IP rate limiter for orders (Cloudflare worker execution context)
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxOrders = 10; // Max 10 orders per hour per IP

  const record = rateLimitMap.get(ip) || [];
  const recent = record.filter(timestamp => now - timestamp < windowMs);
  if (recent.length >= maxOrders) {
    return false;
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);
  return true;
}

let feedbackTableEnsured = false;
async function ensureFeedbackTable(db) {
  if (feedbackTableEnsured) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS order_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL UNIQUE,
        order_no TEXT NOT NULL,
        customer_name TEXT,
        phone TEXT,
        rating_biryani INTEGER NOT NULL,
        rating_accompaniments INTEGER NOT NULL,
        rating_packaging INTEGER NOT NULL,
        comments TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `).run();
    feedbackTableEnsured = true;
  } catch (e) {
    console.error('ensureFeedbackTable error', e);
  }
}

let schemaMigrationsChecked = false;
async function ensureSchemaMigrations(db) {
  if (schemaMigrationsChecked) return;
  try {
    try { await db.prepare("ALTER TABLE service_days ADD COLUMN batch_name TEXT").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE expenses ADD COLUMN spent_by TEXT").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE expenses ADD COLUMN batch_date TEXT").run(); } catch (e) {}
    try { await db.prepare("ALTER TABLE tasks ADD COLUMN batch_date TEXT").run(); } catch (e) {}
    try {
      await db.prepare("INSERT OR IGNORE INTO service_days (date, open, order_limit, allow_overflow, cutoff_time, note, batch_name) VALUES ('2026-11-22', 1, 50, 0, '14:00', 'Sunday Dum Biryani Service', 'Batch 2')").run();
      await db.prepare("UPDATE service_days SET batch_name = 'Batch 2' WHERE date = '2026-11-22' AND (batch_name IS NULL OR batch_name = '')").run();
    } catch (e) {}
    schemaMigrationsChecked = true;
  } catch (err) {
    console.error('Migration error', err);
  }
}

function resolveBatchName(day, allDays = []) {
  if (day.batch_name && String(day.batch_name).trim() !== '') {
    return String(day.batch_name).trim();
  }
  if (day.date === '2026-11-22') {
    return 'Batch 2';
  }
  const sorted = [...allDays].sort((a, b) => a.date.localeCompare(b.date));
  const idx22 = sorted.findIndex(d => d.date === '2026-11-22');
  const thisIdx = sorted.findIndex(d => d.date === day.date);
  if (idx22 !== -1 && thisIdx !== -1) {
    const batchNum = 2 + (thisIdx - idx22);
    return `Batch ${batchNum}`;
  }
  return `Batch ${thisIdx !== -1 ? thisIdx + 1 : 1}`;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const method = request.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Team-Key',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const db = env.DB;
  if (!db) {
    return errorResponse('Database binding (DB) not configured', 500);
  }

  // --- Auth Check for Team Endpoints ---
  const isTeamRoute = path.startsWith('/team');
  const teamKey = env.TEAM_KEY || 'dc_secret_team_demo2026';
  const providedKey = request.headers.get('X-Team-Key') || url.searchParams.get('key');

  if (isTeamRoute) {
    if (!providedKey || providedKey !== teamKey) {
      return errorResponse('Unauthorized: Invalid or missing team key', 401);
    }
  }

  try {
    // ----------------------------------------------------
    // PUBLIC CUSTOMER ROUTES
    // ----------------------------------------------------

    // GET /api/settings - Public store settings
    if (path === '/settings' && method === 'GET') {
      const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('brand_name', 'whatsapp_number', 'payment_note', 'whatsapp_template', 'whatsapp_feedback_template')").all();
      const settings = {};
      (rows.results || []).forEach(r => { settings[r.key] = r.value; });
      return jsonResponse(settings);
    }

    // GET /api/menu - Public menu
    if (path === '/menu' && method === 'GET') {
      const rows = await db.prepare("SELECT id, name, description, price, image, sort FROM menu_items WHERE available = 1 ORDER BY sort ASC, id ASC").all();
      return jsonResponse(rows.results || []);
    }

    // GET /api/service-days - Public open service days with portion availability
    if (path === '/service-days' && method === 'GET') {
      const days = await db.prepare("SELECT date, open, order_limit, allow_overflow, cutoff_time, note FROM service_days WHERE open = 1 AND date >= date('now', 'localtime', '-1 day') ORDER BY date ASC LIMIT 14").all();
      
      const results = [];
      for (const d of (days.results || [])) {
        const bookedRow = await db.prepare("SELECT COALESCE(SUM(total_portions), 0) as booked FROM orders WHERE service_date = ? AND status != 'Cancelled'").bind(d.date).first();
        const booked = bookedRow ? Number(bookedRow.booked) : 0;
        const remaining = Math.max(0, d.order_limit - booked);
        const isSoldOut = booked >= d.order_limit && d.allow_overflow === 0;

        results.push({
          date: d.date,
          remaining_portions: remaining,
          order_limit: d.order_limit,
          allow_overflow: d.allow_overflow === 1,
          is_sold_out: isSoldOut,
          cutoff_time: d.cutoff_time,
          note: d.note
        });
      }
      return jsonResponse(results);
    }

    // POST /api/orders - Customer order placement
    if (path === '/orders' && method === 'POST') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!checkRateLimit(clientIp)) {
        return errorResponse('Too many orders placed recently. Please try again later or contact us on WhatsApp.', 429);
      }

      const body = await request.json();

      // Honeypot check
      if (body.website_hp && body.website_hp.trim() !== '') {
        return errorResponse('Invalid submission', 400);
      }

      const customer_name = (body.customer_name || '').trim();
      const phone = (body.phone || '').trim();
      const address = (body.address || '').trim();
      const notes = (body.notes || '').trim();
      const service_date = (body.service_date || '').trim();
      const items = Array.isArray(body.items) ? body.items : [];

      if (!customer_name) return errorResponse('Customer name is required');
      if (!/^[6-9]\d{9}$/.test(phone)) return errorResponse('Please provide a valid 10-digit Indian mobile number');
      if (!address) return errorResponse('Delivery address is required');
      if (!service_date) return errorResponse('Please select a service day');
      if (items.length === 0) return errorResponse('Please add at least one item to your order');

      // Verify service day is open
      const day = await db.prepare("SELECT date, open, order_limit, allow_overflow, cutoff_time FROM service_days WHERE date = ?").bind(service_date).first();
      if (!day || day.open !== 1) {
        return errorResponse('Selected service day is not accepting orders');
      }

      // Check cutoff time if set
      if (day.cutoff_time) {
        // Asia/Kolkata date & time
        const nowKolkata = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        const yyyy = nowKolkata.getFullYear();
        const mm = String(nowKolkata.getMonth() + 1).padStart(2, '0');
        const dd = String(nowKolkata.getDate()).padStart(2, '0');
        const todayStr = `${yyyy}-${mm}-${dd}`;
        if (service_date === todayStr) {
          const currentHourMin = `${String(nowKolkata.getHours()).padStart(2, '0')}:${String(nowKolkata.getMinutes()).padStart(2, '0')}`;
          if (currentHourMin > day.cutoff_time) {
            return errorResponse(`Orders for today closed at ${day.cutoff_time}`);
          }
        }
      }

      // Fetch valid menu items to verify prices and calculate totals
      const menuRows = await db.prepare("SELECT id, name, price, available FROM menu_items").all();
      const menuMap = new Map();
      (menuRows.results || []).forEach(m => menuMap.set(m.id, m));

      let orderTotal = 0;
      let orderPortions = 0;
      const verifiedItems = [];

      for (const it of items) {
        const menuItem = menuMap.get(Number(it.item_id));
        const qty = parseInt(it.qty, 10);
        if (!menuItem || isNaN(qty) || qty <= 0) continue;
        if (menuItem.available !== 1) {
          return errorResponse(`Item "${menuItem.name}" is currently unavailable`);
        }
        const itemTotal = menuItem.price * qty;
        orderTotal += itemTotal;
        orderPortions += qty;
        verifiedItems.push({
          item_id: menuItem.id,
          name: menuItem.name,
          unit_price: menuItem.price,
          qty
        });
      }

      if (verifiedItems.length === 0) {
        return errorResponse('No valid items in order');
      }

      // Atomic limit check
      const bookedRow = await db.prepare("SELECT COALESCE(SUM(total_portions), 0) as booked FROM orders WHERE service_date = ? AND status != 'Cancelled'").bind(service_date).first();
      const currentBooked = bookedRow ? Number(bookedRow.booked) : 0;
      let overLimit = 0;

      if (currentBooked + orderPortions > day.order_limit) {
        if (day.allow_overflow === 1) {
          overLimit = 1;
        } else {
          const remaining = Math.max(0, day.order_limit - currentBooked);
          return errorResponse(`Sold out! Only ${remaining} portion(s) remaining for ${service_date}.`);
        }
      }

      // Generate unique order number (e.g. DC-20261120-4821)
      const datePart = service_date.replace(/-/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderNo = `DC-${datePart}-${randomSuffix}`;

      // Insert Order
      const insertOrder = await db.prepare(
        "INSERT INTO orders (order_no, service_date, customer_name, phone, address, notes, status, total, total_portions, over_limit, source) VALUES (?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, 'web')"
      ).bind(orderNo, service_date, customer_name, phone, address, notes, orderTotal, orderPortions, overLimit).run();

      const orderId = insertOrder.meta.last_row_id;

      // Insert Order Items
      const batchInserts = verifiedItems.map(item =>
        db.prepare("INSERT INTO order_items (order_id, item_id, item_name, unit_price, qty) VALUES (?, ?, ?, ?, ?)")
          .bind(orderId, item.item_id, item.name, item.unit_price, item.qty)
      );
      await db.batch(batchInserts);

      // Fetch store whatsapp & payment note
      const settingsRows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('whatsapp_number', 'payment_note')").all();
      const settings = {};
      (settingsRows.results || []).forEach(r => { settings[r.key] = r.value; });

      return jsonResponse({
        success: true,
        order_no: orderNo,
        service_date,
        customer_name,
        phone,
        address,
        notes,
        total: orderTotal,
        total_portions: orderPortions,
        over_limit: overLimit === 1,
        items: verifiedItems,
        whatsapp_number: settings.whatsapp_number || '',
        payment_note: settings.payment_note || ''
      }, 201);
    }

    // GET /api/feedback/order?order_no=...
    if (path === '/feedback/order' && method === 'GET') {
      await ensureFeedbackTable(db);
      const orderNo = (url.searchParams.get('order_no') || '').trim();
      if (!orderNo) {
        return errorResponse('Order number is required');
      }

      const order = await db.prepare("SELECT id, order_no, service_date, customer_name, phone, status, total, total_portions FROM orders WHERE order_no = ?").bind(orderNo).first();
      if (!order) {
        return errorResponse('Order not found. Please verify your order number.', 404);
      }

      const itemsRes = await db.prepare("SELECT item_name, qty FROM order_items WHERE order_id = ?").bind(order.id).all();
      const items = (itemsRes.results || []).map(it => `${it.qty}x ${it.item_name}`);

      const fb = await db.prepare("SELECT rating_biryani, rating_accompaniments, rating_packaging, comments, created_at FROM order_feedback WHERE order_id = ?").bind(order.id).first();

      return jsonResponse({
        success: true,
        order: {
          id: order.id,
          order_no: order.order_no,
          customer_name: order.customer_name,
          service_date: order.service_date,
          total: order.total,
          total_portions: order.total_portions,
          items
        },
        feedback: fb || null
      });
    }

    // POST /api/feedback - Customer submits rating and comments
    if (path === '/feedback' && method === 'POST') {
      await ensureFeedbackTable(db);
      const body = await request.json();
      const orderNo = (body.order_no || '').trim();
      const ratingBiryani = parseInt(body.rating_biryani, 10);
      const ratingAccompaniments = parseInt(body.rating_accompaniments, 10);
      const ratingPackaging = parseInt(body.rating_packaging, 10);
      const comments = (body.comments || '').trim();

      if (!orderNo) return errorResponse('Order number is required');
      if (isNaN(ratingBiryani) || ratingBiryani < 1 || ratingBiryani > 5) return errorResponse('Please rate Biryani (1-5 stars)');
      if (isNaN(ratingAccompaniments) || ratingAccompaniments < 1 || ratingAccompaniments > 5) return errorResponse('Please rate Accompaniments (1-5 stars)');
      if (isNaN(ratingPackaging) || ratingPackaging < 1 || ratingPackaging > 5) return errorResponse('Please rate Packaging (1-5 stars)');

      const order = await db.prepare("SELECT id, order_no, customer_name, phone FROM orders WHERE order_no = ?").bind(orderNo).first();
      if (!order) {
        return errorResponse('Order not found', 404);
      }

      await db.prepare(`
        INSERT INTO order_feedback (order_id, order_no, customer_name, phone, rating_biryani, rating_accompaniments, rating_packaging, comments, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET
          rating_biryani = excluded.rating_biryani,
          rating_accompaniments = excluded.rating_accompaniments,
          rating_packaging = excluded.rating_packaging,
          comments = excluded.comments,
          created_at = CURRENT_TIMESTAMP
      `).bind(order.id, order.order_no, order.customer_name, order.phone, ratingBiryani, ratingAccompaniments, ratingPackaging, comments).run();

      return jsonResponse({
        success: true,
        message: 'Thank you so much! Your feedback has been received.'
      });
    }

    // ----------------------------------------------------
    // TEAM AUTHENTICATED ROUTES (/api/team/*)
    // ----------------------------------------------------

    // GET /api/team/verify - Verify key validity
    if (path === '/team/verify' && method === 'GET') {
      return jsonResponse({ valid: true });
    }

    // --- Menu Management ---
    // GET /api/team/menu
    if (path === '/team/menu' && method === 'GET') {
      const rows = await db.prepare("SELECT id, name, description, price, image, available, sort, created_at FROM menu_items ORDER BY sort ASC, id ASC").all();
      return jsonResponse(rows.results || []);
    }

    // POST /api/team/menu - Add item
    if (path === '/team/menu' && method === 'POST') {
      const b = await request.json();
      const name = (b.name || '').trim();
      const description = (b.description || '').trim();
      const price = parseFloat(b.price) || 0;
      const image = b.image || null;
      const available = b.available ? 1 : 0;
      const sort = parseInt(b.sort, 10) || 0;

      if (!name) return errorResponse('Name is required');
      if (price <= 0) return errorResponse('Price must be greater than 0');

      const res = await db.prepare(
        "INSERT INTO menu_items (name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(name, description, price, image, available, sort).run();

      return jsonResponse({ success: true, id: res.meta.last_row_id }, 201);
    }

    // PUT /api/team/menu/:id - Edit item
    const menuMatch = path.match(/^\/team\/menu\/(\d+)$/);
    if (menuMatch && method === 'PUT') {
      const id = parseInt(menuMatch[1], 10);
      const b = await request.json();
      const name = (b.name || '').trim();
      const description = (b.description || '').trim();
      const price = parseFloat(b.price) || 0;
      const image = b.image !== undefined ? b.image : null;
      const available = b.available ? 1 : 0;
      const sort = parseInt(b.sort, 10) || 0;

      if (!name) return errorResponse('Name is required');
      if (price <= 0) return errorResponse('Price must be greater than 0');

      if (image !== null) {
        await db.prepare(
          "UPDATE menu_items SET name = ?, description = ?, price = ?, image = ?, available = ?, sort = ? WHERE id = ?"
        ).bind(name, description, price, image, available, sort, id).run();
      } else {
        await db.prepare(
          "UPDATE menu_items SET name = ?, description = ?, price = ?, available = ?, sort = ? WHERE id = ?"
        ).bind(name, description, price, available, sort, id).run();
      }

      return jsonResponse({ success: true });
    }

    // DELETE /api/team/menu/:id
    if (menuMatch && method === 'DELETE') {
      const id = parseInt(menuMatch[1], 10);
      await db.prepare("DELETE FROM menu_items WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true });
    }

    // --- Service Calendar & Limits ---
    // GET /api/team/service-days
    if (path === '/team/service-days' && method === 'GET') {
      await ensureSchemaMigrations(db);
      const rows = await db.prepare("SELECT date, open, order_limit, allow_overflow, cutoff_time, note, batch_name FROM service_days ORDER BY date ASC").all();
      const allDays = rows.results || [];
      const results = [];
      for (const d of allDays) {
        const bookedRow = await db.prepare("SELECT COALESCE(SUM(total_portions), 0) as booked, COUNT(id) as order_count FROM orders WHERE service_date = ? AND status != 'Cancelled'").bind(d.date).first();
        results.push({
          ...d,
          batch_name: resolveBatchName(d, allDays),
          open: d.open === 1,
          allow_overflow: d.allow_overflow === 1,
          booked_portions: bookedRow ? Number(bookedRow.booked) : 0,
          order_count: bookedRow ? Number(bookedRow.order_count) : 0
        });
      }
      return jsonResponse(results);
    }

    // POST /api/team/service-days - Upsert service day
    if (path === '/team/service-days' && method === 'POST') {
      await ensureSchemaMigrations(db);
      const b = await request.json();
      const date = (b.date || '').trim();
      const open = b.open ? 1 : 0;
      const order_limit = parseInt(b.order_limit, 10) || 50;
      const allow_overflow = b.allow_overflow ? 1 : 0;
      const cutoff_time = b.cutoff_time ? b.cutoff_time.trim() : null;
      const note = b.note ? b.note.trim() : null;
      const batch_name = b.batch_name ? b.batch_name.trim() : null;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return errorResponse('Valid date (YYYY-MM-DD) is required');
      }

      await db.prepare(`
        INSERT INTO service_days (date, open, order_limit, allow_overflow, cutoff_time, note, batch_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          open = excluded.open,
          order_limit = excluded.order_limit,
          allow_overflow = excluded.allow_overflow,
          cutoff_time = excluded.cutoff_time,
          note = excluded.note,
          batch_name = excluded.batch_name
      `).bind(date, open, order_limit, allow_overflow, cutoff_time, note, batch_name).run();

      return jsonResponse({ success: true, date, batch_name });
    }

    // --- Orders Dashboard ---
    // GET /api/team/orders?date=YYYY-MM-DD
    if (path === '/team/orders' && method === 'GET') {
      const dateParam = url.searchParams.get('date');
      let ordersQuery = "SELECT id, order_no, service_date, customer_name, phone, address, notes, status, total, total_portions, over_limit, source, created_at FROM orders";
      const bindings = [];

      if (dateParam) {
        ordersQuery += " WHERE service_date = ? ORDER BY id DESC";
        bindings.push(dateParam);
      } else {
        ordersQuery += " ORDER BY service_date DESC, id DESC LIMIT 200";
      }

      const stmt = db.prepare(ordersQuery);
      const ordersRes = bindings.length > 0 ? await stmt.bind(...bindings).all() : await stmt.all();
      const orders = ordersRes.results || [];

      // Attach items & feedback to each order
      await ensureFeedbackTable(db);
      const orderIds = orders.map(o => o.id);
      const itemsMap = new Map();
      const feedbackMap = new Map();

      if (orderIds.length > 0) {
        // D1 handles multiple items query
        const itemsRes = await db.prepare("SELECT order_id, item_id, item_name, unit_price, qty FROM order_items WHERE order_id IN (" + orderIds.join(',') + ")").all();
        (itemsRes.results || []).forEach(it => {
          if (!itemsMap.has(it.order_id)) itemsMap.set(it.order_id, []);
          itemsMap.get(it.order_id).push(it);
        });

        try {
          const fbRes = await db.prepare("SELECT order_id, rating_biryani, rating_accompaniments, rating_packaging, comments, created_at FROM order_feedback WHERE order_id IN (" + orderIds.join(',') + ")").all();
          (fbRes.results || []).forEach(fb => {
            feedbackMap.set(fb.order_id, fb);
          });
        } catch (e) {
          // Ignore if empty
        }
      }

      // Chef Totals & Summary for selected date
      let totalPortionsToCook = 0;
      let totalActiveOrders = 0;
      const itemTotals = {};
      const statusCounts = { New: 0, Confirmed: 0, Preparing: 0, 'Out for delivery': 0, Delivered: 0, Cancelled: 0, 'Dunzo-ED': 0 };

      orders.forEach(o => {
        o.items = itemsMap.get(o.id) || [];
        o.feedback = feedbackMap.get(o.id) || null;
        o.over_limit = o.over_limit === 1;
        statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;

        if (o.status !== 'Cancelled') {
          totalPortionsToCook += Number(o.total_portions || 0);
          totalActiveOrders += 1;
          o.items.forEach(it => {
            itemTotals[it.item_name] = (itemTotals[it.item_name] || 0) + it.qty;
          });
        }
      });

      return jsonResponse({
        orders,
        summary: {
          total_portions_to_cook: totalPortionsToCook,
          total_active_orders: totalActiveOrders,
          item_totals: itemTotals,
          status_counts: statusCounts
        }
      });
    }

    // PATCH /api/team/orders/:id - Status or Payment update
    const orderPatchMatch = path.match(/^\/team\/orders\/(\d+)$/);
    if (orderPatchMatch && method === 'PATCH') {
      const id = parseInt(orderPatchMatch[1], 10);
      const b = await request.json();

      // Toggle Payment Status
      if (b.toggle_payment) {
        const orderRow = await db.prepare("SELECT notes FROM orders WHERE id = ?").bind(id).first();
        const currentNotes = (orderRow ? orderRow.notes : '') || '';
        let newNotes;
        if (currentNotes.includes('[PAID]')) {
          newNotes = currentNotes.replace('[PAID]', '').trim();
        } else {
          newNotes = ('[PAID] ' + currentNotes).trim();
        }
        await db.prepare("UPDATE orders SET notes = ? WHERE id = ?").bind(newNotes, id).run();
        const isPaid = newNotes.includes('[PAID]');
        return jsonResponse({ success: true, id, is_paid: isPaid });
      }

      const status = b.status;
      const validStatuses = ['New', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled', 'Dunzo-ED'];

      if (!validStatuses.includes(status)) {
        return errorResponse('Invalid status. Allowed: ' + validStatuses.join(', '));
      }

      await db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(status, id).run();
      return jsonResponse({ success: true, id, status });
    }

    // POST /api/team/orders/batch - Batch update order statuses for a service date
    if (path === '/team/orders/batch' && method === 'POST') {
      const b = await request.json();
      const date = (b.date || '').trim();
      const targetStatus = b.target_status;
      const fromStatus = b.from_status;

      const validStatuses = ['New', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled', 'Dunzo-ED'];
      if (!validStatuses.includes(targetStatus)) {
        return errorResponse('Invalid target status. Allowed: ' + validStatuses.join(', '));
      }
      if (!date) {
        return errorResponse('Date is required for batch update');
      }

      let res;
      if (fromStatus && validStatuses.includes(fromStatus)) {
        res = await db.prepare("UPDATE orders SET status = ? WHERE service_date = ? AND status = ?").bind(targetStatus, date, fromStatus).run();
      } else {
        res = await db.prepare("UPDATE orders SET status = ? WHERE service_date = ? AND status NOT IN ('Cancelled', 'Delivered')").bind(targetStatus, date).run();
      }

      return jsonResponse({ success: true, updated: res.meta.changes, target_status: targetStatus });
    }

    // POST /api/team/orders - Manual order entry by team
    if (path === '/team/orders' && method === 'POST') {
      const b = await request.json();
      const customer_name = (b.customer_name || '').trim();
      const phone = (b.phone || '').trim();
      const address = (b.address || '').trim();
      const notes = (b.notes || '').trim();
      const service_date = (b.service_date || '').trim();
      const items = Array.isArray(b.items) ? b.items : [];
      const forceOverLimit = b.over_limit ? 1 : 0;

      if (!customer_name) return errorResponse('Customer name is required');
      if (!service_date) return errorResponse('Service date is required');
      if (items.length === 0) return errorResponse('At least one item required');

      let orderTotal = 0;
      let orderPortions = 0;
      const orderItemsToInsert = [];

      for (const it of items) {
        const qty = parseInt(it.qty, 10);
        const price = parseFloat(it.unit_price) || 0;
        const name = (it.item_name || 'Item').trim();
        if (qty <= 0) continue;
        orderTotal += price * qty;
        orderPortions += qty;
        orderItemsToInsert.push({
          item_id: it.item_id || null,
          name,
          unit_price: price,
          qty
        });
      }

      const datePart = service_date.replace(/-/g, '');
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const orderNo = `DC-M${datePart}-${randomSuffix}`;

      const insertOrder = await db.prepare(
        "INSERT INTO orders (order_no, service_date, customer_name, phone, address, notes, status, total, total_portions, over_limit, source) VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', ?, ?, ?, 'manual')"
      ).bind(orderNo, service_date, customer_name, phone, address, notes, orderTotal, orderPortions, forceOverLimit).run();

      const orderId = insertOrder.meta.last_row_id;
      const batchInserts = orderItemsToInsert.map(it =>
        db.prepare("INSERT INTO order_items (order_id, item_id, item_name, unit_price, qty) VALUES (?, ?, ?, ?, ?)")
          .bind(orderId, it.item_id, it.name, it.unit_price, it.qty)
      );
      await db.batch(batchInserts);

      return jsonResponse({ success: true, id: orderId, order_no: orderNo }, 201);
    }

    // --- Tasks Management ---
    // GET /api/team/tasks
    if (path === '/team/tasks' && method === 'GET') {
      await ensureSchemaMigrations(db);
      const batchDate = url.searchParams.get('batch_date');
      let query = "SELECT id, title, assignee, due_date, batch_date, status, created_at, completed_at FROM tasks";
      const params = [];
      if (batchDate && batchDate !== 'ALL') {
        query += " WHERE batch_date = ?";
        params.push(batchDate);
      }
      query += " ORDER BY CASE WHEN status = 'Pending' THEN 0 ELSE 1 END, id DESC";
      const rows = params.length > 0 ? await db.prepare(query).bind(...params).all() : await db.prepare(query).all();
      return jsonResponse(rows.results || []);
    }

    // POST /api/team/tasks
    if (path === '/team/tasks' && method === 'POST') {
      await ensureSchemaMigrations(db);
      const b = await request.json();
      const title = (b.title || '').trim();
      const assignee = (b.assignee || '').trim() || null;
      const due_date = (b.due_date || '').trim() || null;
      const batch_date = (b.batch_date || '').trim() || null;

      if (!title) return errorResponse('Task title is required');

      const res = await db.prepare(
        "INSERT INTO tasks (title, assignee, due_date, batch_date, status) VALUES (?, ?, ?, ?, 'Pending')"
      ).bind(title, assignee, due_date, batch_date).run();

      return jsonResponse({ success: true, id: res.meta.last_row_id }, 201);
    }

    // PATCH /api/team/tasks/:id
    const taskMatch = path.match(/^\/team\/tasks\/(\d+)$/);
    if (taskMatch && method === 'PATCH') {
      const id = parseInt(taskMatch[1], 10);
      const b = await request.json();
      const status = b.status === 'Done' ? 'Done' : 'Pending';
      const completedAt = status === 'Done' ? new Date().toISOString() : null;

      await db.prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?").bind(status, completedAt, id).run();
      return jsonResponse({ success: true, id, status });
    }

    // DELETE /api/team/tasks/:id
    if (taskMatch && method === 'DELETE') {
      const id = parseInt(taskMatch[1], 10);
      await db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true });
    }

    // --- Team Members ---
    // GET /api/team/members
    if (path === '/team/members' && method === 'GET') {
      const rows = await db.prepare("SELECT id, name FROM team_members ORDER BY name ASC").all();
      return jsonResponse(rows.results || []);
    }

    // POST /api/team/members
    if (path === '/team/members' && method === 'POST') {
      const b = await request.json();
      const name = (b.name || '').trim();
      if (!name) return errorResponse('Name is required');

      const res = await db.prepare("INSERT OR IGNORE INTO team_members (name) VALUES (?)").bind(name).run();
      return jsonResponse({ success: true, id: res.meta.last_row_id });
    }

    // DELETE /api/team/members/:id
    const memberMatch = path.match(/^\/team\/members\/(\d+)$/);
    if (memberMatch && method === 'DELETE') {
      const id = parseInt(memberMatch[1], 10);
      await db.prepare("DELETE FROM team_members WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true });
    }

    // --- Finances (Expenses & Income with Batch & Member Tracking) ---
    // GET /api/team/finances?batch_date=...
    if (path === '/team/finances' && method === 'GET') {
      await ensureSchemaMigrations(db);
      const batchDateParam = url.searchParams.get('batch_date');

      // Fetch all service days to construct batches list
      const daysRows = await db.prepare("SELECT date, open, order_limit, allow_overflow, cutoff_time, note, batch_name FROM service_days ORDER BY date ASC").all();
      const allDays = daysRows.results || [];
      const batches = [];

      for (const d of allDays) {
        const bName = resolveBatchName(d, allDays);
        const bookedRow = await db.prepare("SELECT COALESCE(SUM(total_portions), 0) as booked, COUNT(id) as count FROM orders WHERE service_date = ? AND status != 'Cancelled'").bind(d.date).first();
        batches.push({
          date: d.date,
          batch_name: bName,
          open: d.open === 1,
          order_limit: d.order_limit,
          booked_portions: bookedRow ? Number(bookedRow.booked) : 0,
          order_count: bookedRow ? Number(bookedRow.count) : 0
        });
      }

      // Batch Comparison Table Data
      const batchComparison = [];
      for (const b of batches) {
        const confRow = await db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE service_date = ? AND status IN ('Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Dunzo-ED')").bind(b.date).first();
        const expRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE batch_date = ? OR (batch_date IS NULL AND date = ?)").bind(b.date, b.date).first();
        const topSpenderRow = await db.prepare("SELECT spent_by, COALESCE(SUM(amount), 0) as total FROM expenses WHERE (batch_date = ? OR (batch_date IS NULL AND date = ?)) AND spent_by IS NOT NULL AND spent_by != '' GROUP BY spent_by ORDER BY total DESC LIMIT 1").bind(b.date, b.date).first();

        const confInc = Number(confRow ? confRow.total : 0);
        const expAmt = Number(expRow ? expRow.total : 0);
        const netProf = confInc - expAmt;
        const margin = confInc > 0 ? ((netProf / confInc) * 100).toFixed(1) : '0.0';
        const costPerPortion = b.booked_portions > 0 ? (expAmt / b.booked_portions).toFixed(1) : '0.0';

        batchComparison.push({
          batch_name: b.batch_name,
          date: b.date,
          open: b.open,
          portions: b.booked_portions,
          confirmed_income: confInc,
          total_expenses: expAmt,
          profit: netProf,
          margin: Number(margin),
          cost_per_portion: Number(costPerPortion),
          top_spender: topSpenderRow ? `${topSpenderRow.spent_by} (₹${topSpenderRow.total})` : '-'
        });
      }

      const isSingleBatch = batchDateParam && batchDateParam !== 'ALL';
      let confirmedIncome = 0;
      let expectedIncome = 0;
      let totalExpenses = 0;
      let portionsCount = 0;
      let categoryBreakdown = {};
      let spentBySummary = [];
      let expensesList = [];
      let manualIncomeList = [];
      let selectedBatch = null;

      if (isSingleBatch) {
        const foundBatch = batches.find(b => b.date === batchDateParam) || { date: batchDateParam, batch_name: `Batch for ${batchDateParam}` };
        selectedBatch = foundBatch;

        // Income for single batch
        const confIncomeRow = await db.prepare(`
          SELECT COALESCE(SUM(total), 0) as total, COALESCE(SUM(total_portions), 0) as portions FROM orders 
          WHERE service_date = ? AND status IN ('Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Dunzo-ED')
        `).bind(batchDateParam).first();

        const expIncomeRow = await db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE service_date = ? AND status = 'New'").bind(batchDateParam).first();

        confirmedIncome = Number(confIncomeRow ? confIncomeRow.total : 0);
        expectedIncome = Number(expIncomeRow ? expIncomeRow.total : 0);
        portionsCount = Number(confIncomeRow ? confIncomeRow.portions : 0);

        // Expenses for single batch
        const expensesRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE batch_date = ? OR (batch_date IS NULL AND date = ?)").bind(batchDateParam, batchDateParam).first();
        totalExpenses = Number(expensesRow ? expensesRow.total : 0);

        // Category breakdown
        const catRows = await db.prepare("SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses WHERE batch_date = ? OR (batch_date IS NULL AND date = ?) GROUP BY category").bind(batchDateParam, batchDateParam).all();
        (catRows.results || []).forEach(c => { categoryBreakdown[c.category] = Number(c.total); });

        // Spent by member summary
        const spentRows = await db.prepare(`
          SELECT COALESCE(spent_by, 'Unassigned / Shared') as member, COALESCE(SUM(amount), 0) as total, COUNT(id) as count 
          FROM expenses 
          WHERE batch_date = ? OR (batch_date IS NULL AND date = ?)
          GROUP BY COALESCE(spent_by, 'Unassigned / Shared')
          ORDER BY total DESC
        `).bind(batchDateParam, batchDateParam).all();

        spentBySummary = (spentRows.results || []).map(r => ({
          member: r.member,
          amount: Number(r.total),
          count: Number(r.count),
          percentage: totalExpenses > 0 ? Math.round((Number(r.total) / totalExpenses) * 100) : 0
        }));

        // Expenses list
        const expListRes = await db.prepare("SELECT id, date, batch_date, spent_by, category, amount, note FROM expenses WHERE batch_date = ? OR (batch_date IS NULL AND date = ?) ORDER BY date DESC, id DESC LIMIT 100").bind(batchDateParam, batchDateParam).all();
        expensesList = expListRes.results || [];

      } else {
        // Overall / Lifetime
        const confIncomeRow = await db.prepare(`
          SELECT COALESCE(SUM(total), 0) as total, COALESCE(SUM(total_portions), 0) as portions FROM orders 
          WHERE status IN ('Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Dunzo-ED')
        `).first();
        const expIncomeRow = await db.prepare("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status = 'New'").first();
        const manualIncomeRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM income_entries").first();
        const expensesRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses").first();

        confirmedIncome = Number(confIncomeRow ? confIncomeRow.total : 0) + Number(manualIncomeRow ? manualIncomeRow.total : 0);
        expectedIncome = Number(expIncomeRow ? expIncomeRow.total : 0);
        totalExpenses = Number(expensesRow ? expensesRow.total : 0);
        portionsCount = Number(confIncomeRow ? confIncomeRow.portions : 0);

        const catRows = await db.prepare("SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY category").all();
        (catRows.results || []).forEach(c => { categoryBreakdown[c.category] = Number(c.total); });

        const spentRows = await db.prepare(`
          SELECT COALESCE(spent_by, 'Unassigned / Shared') as member, COALESCE(SUM(amount), 0) as total, COUNT(id) as count 
          FROM expenses 
          GROUP BY COALESCE(spent_by, 'Unassigned / Shared')
          ORDER BY total DESC
        `).all();

        spentBySummary = (spentRows.results || []).map(r => ({
          member: r.member,
          amount: Number(r.total),
          count: Number(r.count),
          percentage: totalExpenses > 0 ? Math.round((Number(r.total) / totalExpenses) * 100) : 0
        }));

        const expListRes = await db.prepare("SELECT id, date, batch_date, spent_by, category, amount, note FROM expenses ORDER BY date DESC, id DESC LIMIT 100").all();
        expensesList = expListRes.results || [];

        const incListRes = await db.prepare("SELECT id, date, amount, note FROM income_entries ORDER BY date DESC, id DESC LIMIT 50").all();
        manualIncomeList = incListRes.results || [];
      }

      const profit = confirmedIncome - totalExpenses;
      const profitMargin = confirmedIncome > 0 ? Number(((profit / confirmedIncome) * 100).toFixed(1)) : 0;
      const costPerPortion = portionsCount > 0 ? Number((totalExpenses / portionsCount).toFixed(1)) : 0;

      return jsonResponse({
        is_single_batch: isSingleBatch,
        selected_batch: selectedBatch,
        batches,
        batch_comparison: batchComparison,
        confirmed_income: confirmedIncome,
        expected_income: expectedIncome,
        total_expenses: totalExpenses,
        profit,
        profit_margin: profitMargin,
        portions_count: portionsCount,
        cost_per_portion: costPerPortion,
        category_breakdown: categoryBreakdown,
        spent_by_summary: spentBySummary,
        expenses: expensesList,
        manual_income: manualIncomeList
      });
    }

    // POST /api/team/expenses
    if (path === '/team/expenses' && method === 'POST') {
      await ensureSchemaMigrations(db);
      const b = await request.json();
      const date = (b.date || '').trim();
      const category = (b.category || 'other').trim();
      const amount = parseFloat(b.amount) || 0;
      const note = (b.note || '').trim();
      const spent_by = (b.spent_by || '').trim() || null;
      const batch_date = (b.batch_date || '').trim() || date;

      if (!date) return errorResponse('Date is required');
      if (amount <= 0) return errorResponse('Amount must be greater than 0');

      const res = await db.prepare(
        "INSERT INTO expenses (date, batch_date, spent_by, category, amount, note) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(date, batch_date, spent_by, category, amount, note).run();

      return jsonResponse({ success: true, id: res.meta.last_row_id }, 201);
    }

    // DELETE /api/team/expenses/:id
    const expenseMatch = path.match(/^\/team\/expenses\/(\d+)$/);
    if (expenseMatch && method === 'DELETE') {
      const id = parseInt(expenseMatch[1], 10);
      await db.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true });
    }

    // POST /api/team/income
    if (path === '/team/income' && method === 'POST') {
      const b = await request.json();
      const date = (b.date || '').trim();
      const amount = parseFloat(b.amount) || 0;
      const note = (b.note || '').trim();

      if (!date) return errorResponse('Date is required');
      if (amount <= 0) return errorResponse('Amount must be greater than 0');

      const res = await db.prepare(
        "INSERT INTO income_entries (date, amount, note) VALUES (?, ?, ?)"
      ).bind(date, amount, note).run();

      return jsonResponse({ success: true, id: res.meta.last_row_id }, 201);
    }

    // DELETE /api/team/income/:id
    const incomeMatch = path.match(/^\/team\/income\/(\d+)$/);
    if (incomeMatch && method === 'DELETE') {
      const id = parseInt(incomeMatch[1], 10);
      await db.prepare("DELETE FROM income_entries WHERE id = ?").bind(id).run();
      return jsonResponse({ success: true });
    }

    // --- Customer Feedback & Reviews ---
    // GET /api/team/feedback - Fetch all customer reviews & overall averages
    if (path === '/team/feedback' && method === 'GET') {
      await ensureFeedbackTable(db);
      const rows = await db.prepare(`
        SELECT f.id, f.order_id, f.order_no, f.customer_name, f.phone, f.rating_biryani, f.rating_accompaniments, f.rating_packaging, f.comments, f.created_at, o.service_date
        FROM order_feedback f
        LEFT JOIN orders o ON f.order_id = o.id
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT 200
      `).all();

      const reviews = rows.results || [];
      const total = reviews.length;

      let sumBiryani = 0;
      let sumAccompaniments = 0;
      let sumPackaging = 0;

      reviews.forEach(r => {
        sumBiryani += Number(r.rating_biryani || 0);
        sumAccompaniments += Number(r.rating_accompaniments || 0);
        sumPackaging += Number(r.rating_packaging || 0);
      });

      const avgBiryani = total > 0 ? (sumBiryani / total).toFixed(1) : '0.0';
      const avgAccompaniments = total > 0 ? (sumAccompaniments / total).toFixed(1) : '0.0';
      const avgPackaging = total > 0 ? (sumPackaging / total).toFixed(1) : '0.0';
      const overallAvg = total > 0 ? (((sumBiryani + sumAccompaniments + sumPackaging) / (total * 3))).toFixed(1) : '0.0';

      return jsonResponse({
        reviews,
        summary: {
          total_reviews: total,
          overall_avg: overallAvg,
          avg_biryani: avgBiryani,
          avg_accompaniments: avgAccompaniments,
          avg_packaging: avgPackaging
        }
      });
    }

    // --- Settings Management ---
    // GET /api/team/settings
    if (path === '/team/settings' && method === 'GET') {
      const rows = await db.prepare("SELECT key, value FROM settings").all();
      const settings = {};
      (rows.results || []).forEach(r => { settings[r.key] = r.value; });
      return jsonResponse(settings);
    }

    // PUT /api/team/settings
    if (path === '/team/settings' && method === 'PUT') {
      const b = await request.json();
      const allowedKeys = ['brand_name', 'whatsapp_number', 'payment_note', 'whatsapp_template', 'whatsapp_feedback_template'];
      const stmts = [];

      for (const key of allowedKeys) {
        if (b[key] !== undefined) {
          stmts.push(
            db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
              .bind(key, String(b[key]))
          );
        }
      }

      if (stmts.length > 0) {
        await db.batch(stmts);
      }

      return jsonResponse({ success: true });
    }

    return errorResponse(`Route not found: ${method} ${path}`, 404);

  } catch (err) {
    return errorResponse(`Server Error: ${err.message}`, 500);
  }
}
