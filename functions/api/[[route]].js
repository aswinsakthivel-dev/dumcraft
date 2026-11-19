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
      const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('brand_name', 'whatsapp_number', 'payment_note', 'whatsapp_template')").all();
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
      const rows = await db.prepare("SELECT date, open, order_limit, allow_overflow, cutoff_time, note FROM service_days ORDER BY date ASC").all();
      
      const results = [];
      for (const d of (rows.results || [])) {
        const bookedRow = await db.prepare("SELECT COALESCE(SUM(total_portions), 0) as booked, COUNT(id) as order_count FROM orders WHERE service_date = ? AND status != 'Cancelled'").bind(d.date).first();
        results.push({
          ...d,
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
      const b = await request.json();
      const date = (b.date || '').trim();
      const open = b.open ? 1 : 0;
      const order_limit = parseInt(b.order_limit, 10) || 50;
      const allow_overflow = b.allow_overflow ? 1 : 0;
      const cutoff_time = b.cutoff_time ? b.cutoff_time.trim() : null;
      const note = b.note ? b.note.trim() : null;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return errorResponse('Valid date (YYYY-MM-DD) is required');
      }

      await db.prepare(`
        INSERT INTO service_days (date, open, order_limit, allow_overflow, cutoff_time, note)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          open = excluded.open,
          order_limit = excluded.order_limit,
          allow_overflow = excluded.allow_overflow,
          cutoff_time = excluded.cutoff_time,
          note = excluded.note
      `).bind(date, open, order_limit, allow_overflow, cutoff_time, note).run();

      return jsonResponse({ success: true, date });
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

      // Attach items to each order
      const orderIds = orders.map(o => o.id);
      const itemsMap = new Map();

      if (orderIds.length > 0) {
        // D1 handles multiple items query
        const itemsRes = await db.prepare("SELECT order_id, item_id, item_name, unit_price, qty FROM order_items WHERE order_id IN (" + orderIds.join(',') + ")").all();
        (itemsRes.results || []).forEach(it => {
          if (!itemsMap.has(it.order_id)) itemsMap.set(it.order_id, []);
          itemsMap.get(it.order_id).push(it);
        });
      }

      // Chef Totals & Summary for selected date
      let totalPortionsToCook = 0;
      let totalActiveOrders = 0;
      const itemTotals = {};
      const statusCounts = { New: 0, Confirmed: 0, Preparing: 0, 'Out for delivery': 0, Delivered: 0, Cancelled: 0, 'Dunzo-ED': 0 };

      orders.forEach(o => {
        o.items = itemsMap.get(o.id) || [];
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
      const rows = await db.prepare("SELECT id, title, assignee, due_date, status, created_at, completed_at FROM tasks ORDER BY CASE WHEN status = 'Pending' THEN 0 ELSE 1 END, id DESC").all();
      return jsonResponse(rows.results || []);
    }

    // POST /api/team/tasks
    if (path === '/team/tasks' && method === 'POST') {
      const b = await request.json();
      const title = (b.title || '').trim();
      const assignee = (b.assignee || '').trim() || null;
      const due_date = (b.due_date || '').trim() || null;

      if (!title) return errorResponse('Task title is required');

      const res = await db.prepare(
        "INSERT INTO tasks (title, assignee, due_date, status) VALUES (?, ?, ?, 'Pending')"
      ).bind(title, assignee, due_date).run();

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

    // --- Finances (Expenses & Income) ---
    // GET /api/team/finances
    if (path === '/team/finances' && method === 'GET') {
      // Calculate Confirmed Income: orders with Confirmed, Preparing, Out for delivery, Delivered
      const confIncomeRow = await db.prepare(`
        SELECT COALESCE(SUM(total), 0) as total FROM orders 
        WHERE status IN ('Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Dunzo-ED')
      `).first();

      // Expected Income: 'New' orders
      const expIncomeRow = await db.prepare(`
        SELECT COALESCE(SUM(total), 0) as total FROM orders 
        WHERE status = 'New'
      `).first();

      // Manual Income entries
      const manualIncomeRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM income_entries").first();

      // Expenses Total
      const expensesRow = await db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses").first();

      // Category breakdown for expenses
      const catRows = await db.prepare("SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY category").all();
      const categoryBreakdown = {};
      (catRows.results || []).forEach(c => { categoryBreakdown[c.category] = Number(c.total); });

      // Recent expenses
      const expensesList = await db.prepare("SELECT id, date, category, amount, note FROM expenses ORDER BY date DESC, id DESC LIMIT 50").all();

      // Recent manual income
      const incomeList = await db.prepare("SELECT id, date, amount, note FROM income_entries ORDER BY date DESC, id DESC LIMIT 50").all();

      const confirmedIncome = Number(confIncomeRow ? confIncomeRow.total : 0) + Number(manualIncomeRow ? manualIncomeRow.total : 0);
      const expectedIncome = Number(expIncomeRow ? expIncomeRow.total : 0);
      const totalExpenses = Number(expensesRow ? expensesRow.total : 0);
      const profit = confirmedIncome - totalExpenses;

      return jsonResponse({
        confirmed_income: confirmedIncome,
        expected_income: expectedIncome,
        total_expenses: totalExpenses,
        profit,
        category_breakdown: categoryBreakdown,
        expenses: expensesList.results || [],
        manual_income: incomeList.results || []
      });
    }

    // POST /api/team/expenses
    if (path === '/team/expenses' && method === 'POST') {
      const b = await request.json();
      const date = (b.date || '').trim();
      const category = (b.category || 'other').trim();
      const amount = parseFloat(b.amount) || 0;
      const note = (b.note || '').trim();

      if (!date) return errorResponse('Date is required');
      if (amount <= 0) return errorResponse('Amount must be greater than 0');

      const res = await db.prepare(
        "INSERT INTO expenses (date, category, amount, note) VALUES (?, ?, ?, ?)"
      ).bind(date, category, amount, note).run();

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
      const allowedKeys = ['brand_name', 'whatsapp_number', 'payment_note', 'whatsapp_template'];
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
