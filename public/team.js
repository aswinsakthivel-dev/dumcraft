// DumCraft Team App Logic

let currentTab = 'orders';
let teamKey = '';
let ordersData = [];
let menuItems = [];
let serviceDays = [];
let teamMembers = [];
let currentStatusFilter = 'ALL';
let pollTimer = null;
let compressedImageData = null;

// Initialize
async function initTeam() {
  extractTeamKey();
  const valid = await verifyKey();
  if (valid) {
    document.getElementById('keyPromptModal').style.display = 'none';
    setTodayDate();
    await loadInitialData();
    startPolling();
  } else {
    document.getElementById('keyPromptModal').style.display = 'flex';
  }
}

function extractTeamKey() {
  // 1. From path: /team/<key>
  const pathParts = window.location.pathname.split('/');
  const teamIdx = pathParts.indexOf('team');
  if (teamIdx !== -1 && pathParts[teamIdx + 1]) {
    teamKey = pathParts[teamIdx + 1];
    localStorage.setItem('dumcraft_team_key', teamKey);
    return;
  }

  // 2. From query param: ?key=...
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('key')) {
    teamKey = urlParams.get('key');
    localStorage.setItem('dumcraft_team_key', teamKey);
    return;
  }

  // 3. From localStorage
  teamKey = localStorage.getItem('dumcraft_team_key') || '';
}

async function verifyKey() {
  if (!teamKey) return false;
  try {
    const res = await apiFetch('/api/team/verify');
    return res.valid === true;
  } catch (err) {
    return false;
  }
}

async function saveManualKey(e) {
  e.preventDefault();
  const input = document.getElementById('manualKeyInput').value.trim();
  teamKey = input;
  const valid = await verifyKey();
  if (valid) {
    localStorage.setItem('dumcraft_team_key', teamKey);
    document.getElementById('keyPromptModal').style.display = 'none';
    setTodayDate();
    await loadInitialData();
    startPolling();
  } else {
    const errEl = document.getElementById('keyError');
    errEl.textContent = 'Invalid key. Please check and try again.';
    errEl.style.display = 'block';
  }
}

// API Helper with Team Key header
async function apiFetch(endpoint, options = {}) {
  const opts = { ...options };
  opts.headers = {
    'Content-Type': 'application/json',
    'X-Team-Key': teamKey,
    ...(opts.headers || {})
  };
  const res = await fetch(endpoint, opts);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function showAlert(message, type = 'success') {
  const alertEl = document.getElementById('globalAlert');
  alertEl.className = `alert alert-${type}`;
  alertEl.textContent = message;
  alertEl.style.display = 'block';
  setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
}

// Tab Switching
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');

  const activeContent = document.getElementById(`tab-${tab}`);
  if (activeContent) activeContent.style.display = 'block';

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabNames = ['orders', 'calendar', 'menu', 'tasks', 'finances', 'feedback', 'settings'];
  const idx = tabNames.indexOf(tab);
  if (idx !== -1 && tabButtons[idx]) {
    tabButtons[idx].classList.add('active');
  }

  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (currentTab === 'orders') loadOrders();
  else if (currentTab === 'calendar') loadCalendar();
  else if (currentTab === 'menu') loadMenu();
  else if (currentTab === 'tasks') loadTasks();
  else if (currentTab === 'finances') loadFinances();
  else if (currentTab === 'feedback') loadFeedback();
  else if (currentTab === 'settings') loadSettings();
}

async function loadInitialData() {
  await Promise.all([
    loadSettings(),
    loadMembers(),
    loadMenu(),
    loadOrders(),
    apiFetch('/api/team/service-days').then(d => { serviceDays = d; }).catch(() => {})
  ]);
}

function setTodayDate() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  document.getElementById('orderDateFilter').value = todayStr;
}

async function goToNextServiceDay() {
  if (!serviceDays || serviceDays.length === 0) {
    try {
      serviceDays = await apiFetch('/api/team/service-days');
    } catch (e) {
      console.error(e);
    }
  }
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;

  const openFutureDays = (serviceDays || [])
    .filter(d => (d.open === 1 || d.open === true) && d.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (openFutureDays.length > 0) {
    const current = document.getElementById('orderDateFilter').value;
    let nextDay = openFutureDays.find(d => d.date > current);
    if (!nextDay) nextDay = openFutureDays[0];
    document.getElementById('orderDateFilter').value = nextDay.date;
    loadOrders();
    showAlert(`Switched to: ${nextDay.date}`);
  } else {
    showAlert('No upcoming open service days found. You can open a date in the Calendar tab.', 'warning');
  }
}

// Polling (auto-refresh every 30s)
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (currentTab === 'orders') {
      loadOrders(true); // silent refresh
    }
  }, 30000);
}

// ==========================================
// ORDERS & CHEF METRICS
// ==========================================
async function loadOrders(silent = false) {
  const dateVal = document.getElementById('orderDateFilter').value;
  const listEl = document.getElementById('ordersList');
  if (!silent) listEl.innerHTML = '<div class="muted" style="text-align:center; padding:20px;">Loading orders...</div>';

  try {
    const url = dateVal ? `/api/team/orders?date=${dateVal}` : '/api/team/orders';
    const data = await apiFetch(url);
    ordersData = data.orders || [];

    // Render Chef Metrics
    const summary = data.summary || {};
    document.getElementById('metricPortions').textContent = summary.total_portions_to_cook || 0;
    document.getElementById('metricOrders').textContent = summary.total_active_orders || 0;
    document.getElementById('chefDateLabel').textContent = dateVal || 'All Dates';

    // Item breakdown
    const breakdownEl = document.getElementById('chefItemBreakdown');
    breakdownEl.innerHTML = '';
    const itemTotals = summary.item_totals || {};
    if (Object.keys(itemTotals).length === 0) {
      breakdownEl.innerHTML = '<span class="muted" style="font-size:0.85rem;">No active orders to cook for this date.</span>';
    } else {
      Object.entries(itemTotals).forEach(([name, count]) => {
        const pill = document.createElement('span');
        pill.className = 'badge';
        pill.style.background = '#ffedd5';
        pill.style.color = '#c2410c';
        pill.style.fontSize = '0.85rem';
        pill.style.fontWeight = '700';
        pill.textContent = `${name}: ${count} portion(s)`;
        breakdownEl.appendChild(pill);
      });
    }

    // Update filter counts
    const counts = summary.status_counts || {};
    const confirmedCount = (counts.Confirmed || 0) + (counts.Preparing || 0);
    const dunzoCount = (counts['Dunzo-ED'] || 0) + (counts['Out for delivery'] || 0) + (counts.Delivered || 0);
    const newCount = counts.New || 0;
    const cancelledCount = counts.Cancelled || 0;

    document.getElementById('count-ALL').textContent = ordersData.length;
    document.getElementById('count-New').textContent = newCount;
    document.getElementById('count-Confirmed').textContent = confirmedCount;
    if (document.getElementById('count-Dunzo')) {
      document.getElementById('count-Dunzo').textContent = dunzoCount;
    }
    if (document.getElementById('count-Cancelled')) {
      document.getElementById('count-Cancelled').textContent = cancelledCount;
    }

    renderOrders();
  } catch (err) {
    if (!silent) listEl.innerHTML = `<div class="alert alert-danger">Error loading orders: ${err.message}</div>`;
  }
}

function filterOrderStatus(status) {
  currentStatusFilter = status;
  document.querySelectorAll('.filter-tab-pill').forEach(btn => btn.classList.remove('active'));
  let btnId = `filter-btn-${status}`;
  if (status === 'Dunzo-ED') btnId = 'filter-btn-Dunzo';
  const activeBtn = document.getElementById(btnId);
  if (activeBtn) activeBtn.classList.add('active');
  renderOrders();
}

function copyAddress(btn, encodedAddr) {
  const addr = decodeURIComponent(encodedAddr);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(addr).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = '✅ Copied!';
      btn.classList.add('btn-success');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('btn-success');
      }, 2000);
    }).catch(() => fallbackCopy(btn, addr));
  } else {
    fallbackCopy(btn, addr);
  }
}

function fallbackCopy(btn, text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  const orig = btn.innerHTML;
  btn.innerHTML = '✅ Copied!';
  setTimeout(() => { btn.innerHTML = orig; }, 2000);
}

function renderOrders() {
  const listEl = document.getElementById('ordersList');

  // Filter orders
  let filtered = ordersData.filter(o => {
    if (currentStatusFilter === 'ALL') return true;
    if (currentStatusFilter === 'New') return o.status === 'New';
    if (currentStatusFilter === 'Confirmed') return o.status === 'Confirmed' || o.status === 'Preparing';
    if (currentStatusFilter === 'Dunzo-ED') return o.status === 'Dunzo-ED' || o.status === 'Out for delivery' || o.status === 'Delivered';
    if (currentStatusFilter === 'Cancelled') return o.status === 'Cancelled';
    return o.status === currentStatusFilter;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="card" style="text-align:center; padding:24px; color:var(--text-muted);">No orders found for this selection.</div>';
    return;
  }

  // Sort orders so Cancelled always stays at the bottom
  // Priority: 1. New (Yet to Confirm) -> 2. Confirmed/Preparing -> 3. Dunzo-ED/Delivered -> 4. Cancelled
  const getPriority = (status) => {
    if (status === 'New') return 1;
    if (status === 'Confirmed' || status === 'Preparing') return 2;
    if (status === 'Dunzo-ED' || status === 'Out for delivery' || status === 'Delivered') return 3;
    if (status === 'Cancelled') return 4;
    return 2;
  };

  filtered.sort((a, b) => getPriority(a.status) - getPriority(b.status) || b.id - a.id);

  listEl.innerHTML = '';
  let lastGroup = null;

  filtered.forEach(o => {
    const card = document.createElement('div');
    card.className = 'order-card';

    // Group Header when viewing ALL
    if (currentStatusFilter === 'ALL') {
      let groupName = '';
      if (o.status === 'New') groupName = '⏳ Yet to Confirm';
      else if (o.status === 'Confirmed' || o.status === 'Preparing') groupName = '👨‍🍳 Confirmed Orders';
      else if (o.status === 'Dunzo-ED' || o.status === 'Out for delivery' || o.status === 'Delivered') groupName = '🛵 Dunzo-ED / Dispatched';
      else if (o.status === 'Cancelled') groupName = '❌ Cancelled Orders';

      if (groupName && groupName !== lastGroup) {
        lastGroup = groupName;
        const groupHeader = document.createElement('div');
        groupHeader.style.cssText = 'font-weight:700; font-size:0.95rem; color:var(--secondary); margin:16px 0 8px; padding-bottom:4px; border-bottom:2px solid var(--border); display:flex; align-items:center; gap:6px;';
        groupHeader.innerHTML = groupName;
        listEl.appendChild(groupHeader);
      }
    }

    // Cancelled Styling
    const isCancelled = o.status === 'Cancelled';
    if (isCancelled) {
      card.style.background = '#fef2f2';
      card.style.borderColor = '#fca5a5';
      card.style.opacity = '0.85';
    }

    // Status badge class & text
    let badgeClass = 'badge-new';
    let statusLabel = o.status;
    if (o.status === 'New') {
      statusLabel = 'Yet to Confirm';
      badgeClass = 'badge-new';
    } else if (o.status === 'Confirmed' || o.status === 'Preparing') {
      statusLabel = 'Confirmed';
      badgeClass = 'badge-confirmed';
    } else if (o.status === 'Dunzo-ED' || o.status === 'Out for delivery' || o.status === 'Delivered') {
      statusLabel = 'Dunzo-ED';
      badgeClass = 'badge-delivery';
    } else if (isCancelled) {
      statusLabel = 'Cancelled';
      badgeClass = 'badge-cancelled';
    }

    // Over limit warning badge
    const overLimitBadge = o.over_limit 
      ? `<span class="badge badge-overlimit">⚠️ OVER LIMIT</span>` 
      : '';

    // Items list
    const itemsHtml = (o.items || []).map(it => `
      <div class="order-item-row">
        <span><strong>${it.qty}x</strong> ${it.item_name}</span>
        <span>₹${it.unit_price * it.qty}</span>
      </div>
    `).join('');

    // Payment status check
    const isPaid = (o.notes && o.notes.includes('[PAID]')) || (o.payment_status === 'Paid');
    const paymentButtonHtml = isPaid
      ? `<button class="btn btn-sm" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; font-weight:700; padding:4px 8px;" onclick="togglePayment(${o.id})" title="Click to undo payment">✅ Paid</button>`
      : `<button class="btn btn-sm" style="background:#ecfdf5; color:#047857; border:1px solid #6ee7b7; font-weight:700; padding:4px 8px;" onclick="togglePayment(${o.id})">💵 Payment Done</button>`;

    // Clean notes (remove [PAID] tag from display)
    const cleanNotes = (o.notes || '').replace(/\[PAID\]/g, '').trim();

    // Phone links (Call + WhatsApp)
    const phoneClean = (o.phone || '').replace(/[^0-9]/g, '');
    const phoneLinks = phoneClean ? `
      <a href="tel:${phoneClean}">📞 Call ${o.phone}</a>
      <span>•</span>
      <a href="https://wa.me/91${phoneClean}" target="_blank">💬 WhatsApp</a>
    ` : `<span class="muted">No phone</span>`;

    const encodedAddr = encodeURIComponent(o.address || '');

    // Feedback banner if review already received
    let feedbackBannerHtml = '';
    if (o.feedback) {
      const avg = ((o.feedback.rating_biryani + o.feedback.rating_accompaniments + o.feedback.rating_packaging) / 3).toFixed(1);
      feedbackBannerHtml = `
        <div style="margin-top:8px; padding:8px 10px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; font-size:0.85rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <strong style="color:#b45309; display:flex; align-items:center; gap:4px;">
              <span>⭐ Customer Review:</span>
              <span class="badge" style="background:#fef3c7; color:#92400e; font-size:0.75rem;">⭐ ${avg}/5</span>
            </strong>
            <span style="font-size:0.75rem; color:#92400e;">${new Date(o.feedback.created_at).toLocaleDateString('en-IN')}</span>
          </div>
          <div style="display:flex; gap:10px; flex-wrap:wrap; font-size:0.8rem; margin-bottom:4px;">
            <span>🍗 Biryani: <strong>${o.feedback.rating_biryani}★</strong></span>
            <span>🥣 Salan: <strong>${o.feedback.rating_accompaniments}★</strong></span>
            <span>📦 Packaging: <strong>${o.feedback.rating_packaging}★</strong></span>
          </div>
          ${o.feedback.comments ? `<div style="font-style:italic; color:#78350f; background:rgba(255,255,255,0.7); padding:4px 8px; border-radius:4px; margin-top:4px;">"${o.feedback.comments}"</div>` : ''}
        </div>
      `;
    }

    card.innerHTML = `
      <div class="order-header">
        <div>
          <span class="order-no">${o.order_no}</span>
          <span style="font-size:0.75rem; color:var(--text-muted); margin-left:6px;">(${o.source})</span>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          ${paymentButtonHtml}
          ${overLimitBadge}
          <span class="badge ${badgeClass}">${statusLabel}</span>
        </div>
      </div>

      <div class="order-customer" style="font-size:1rem; font-weight:700; color:var(--secondary);">${o.customer_name}</div>
      <div class="order-contact">${phoneLinks}</div>

      <!-- Address with Copy Button -->
      <div style="font-size:0.88rem; margin-bottom:8px; background:#f8fafc; border:1px solid var(--border); border-radius:6px; padding:8px 10px; display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div style="word-break:break-word;">
          <strong style="color:var(--secondary);">📍 Address:</strong>
          <div style="margin-top:2px;">${o.address}</div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="copyAddress(this, '${encodedAddr}')" style="padding:4px 8px; font-size:0.75rem; flex-shrink:0; white-space:nowrap;" title="Copy address to clipboard">
          📋 Copy
        </button>
      </div>

      ${cleanNotes ? `<div style="font-size:0.8rem; background:#fffbeb; color:#92400e; padding:4px 8px; border-radius:4px; margin-bottom:8px;">
        📝 <strong>Note:</strong> ${cleanNotes}
      </div>` : ''}

      <div class="order-items-list">
        ${itemsHtml}
        <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px solid #e2e8f0; padding-top:4px; margin-top:4px;">
          <span>Total (${o.total_portions} portions):</span>
          <span>₹${o.total}</span>
        </div>
      </div>

      ${feedbackBannerHtml}

      <!-- Status & WhatsApp Action Buttons -->
      <div class="order-status-actions" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:10px; padding-top:8px; border-top:1px solid var(--border);">
        ${o.status === 'New' ? `
          <button class="btn btn-primary btn-sm" onclick="updateOrderStatus(${o.id}, 'Confirmed')" style="font-weight:700;">
            ✨ Confirm
          </button>
        ` : ''}

        ${o.status !== 'Dunzo-ED' && !isCancelled ? `
          <button class="btn btn-sm" style="background:#fef08a; color:#854d0e; border:1px solid #fde047; font-weight:700;" onclick="updateOrderStatus(${o.id}, 'Dunzo-ED')">
            🛵 Dunzo-ED
          </button>
        ` : ''}

        ${!isCancelled ? `
          <button class="btn btn-outline-danger btn-sm" onclick="updateOrderStatus(${o.id}, 'Cancelled')">
            ❌ Cancel
          </button>
        ` : `
          <button class="btn btn-secondary btn-sm" onclick="updateOrderStatus(${o.id}, 'Confirmed')" style="font-size:0.75rem;">
            🔄 Reopen Order
          </button>
        `}

        <!-- WhatsApp Feedback Trigger Button -->
        ${o.feedback ? `
          <button type="button" class="btn btn-sm" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-weight:700; padding:4px 8px;" onclick="switchTab('feedback')">
            ✅ Feedback Received
          </button>
        ` : `
          <button type="button" class="btn btn-sm" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-weight:700; padding:4px 8px;" onclick="sendWaFeedback(${o.id})" title="Send customer WhatsApp feedback request">
            ⭐ Ask Feedback
          </button>
        `}

        <!-- Full WhatsApp Message Actions Modal Trigger -->
        <button type="button" class="btn btn-secondary btn-sm" style="font-weight:600; padding:4px 8px;" onclick="openWaModal(${o.id})" title="Message customer on WhatsApp">
          💬 WhatsApp
        </button>
      </div>
    `;

    listEl.appendChild(card);
  });
}

async function updateOrderStatus(orderId, status) {
  try {
    await apiFetch(`/api/team/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    loadOrders(true);
    showAlert(`Order status updated to ${status}`);
  } catch (err) {
    showAlert(`Failed to update status: ${err.message}`, 'danger');
  }
}

// Toggle Payment Status
async function togglePayment(orderId) {
  try {
    const res = await apiFetch(`/api/team/orders/${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ toggle_payment: true })
    });
    loadOrders(true);
    showAlert(res.is_paid ? 'Marked as Paid ✅' : 'Marked as Unpaid');
  } catch (err) {
    showAlert(`Payment update failed: ${err.message}`, 'danger');
  }
}

// Batch Update Orders for current date
async function batchUpdateOrders(targetStatus, fromStatus = null) {
  const dateVal = document.getElementById('orderDateFilter').value;
  if (!dateVal) {
    alert('Please select a specific date for batch actions.');
    return;
  }

  const promptText = fromStatus 
    ? `Mark ALL "${fromStatus}" orders for ${dateVal} as "${targetStatus}"?`
    : `Mark ALL active orders for ${dateVal} as "${targetStatus}"?`;

  if (!confirm(promptText)) return;

  try {
    const res = await apiFetch('/api/team/orders/batch', {
      method: 'POST',
      body: JSON.stringify({
        date: dateVal,
        target_status: targetStatus,
        from_status: fromStatus
      })
    });
    loadOrders(true);
    showAlert(`Updated ${res.updated || 0} order(s) to "${targetStatus}"!`);
  } catch (err) {
    showAlert(`Batch update failed: ${err.message}`, 'danger');
  }
}

// Print Orders Kitchen Sheet
function printOrdersSheet() {
  const dateVal = document.getElementById('orderDateFilter').value || 'All Dates';
  const sheet = document.getElementById('printSheet');
  
  let rowsHtml = ordersData.map((o, idx) => {
    const items = (o.items || []).map(it => `${it.qty}x ${it.item_name}`).join(', ');
    return `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${o.order_no}</strong>${o.over_limit ? ' [OVER LIMIT]' : ''}</td>
        <td><strong>${o.customer_name}</strong><br>${o.phone}</td>
        <td>${o.address}</td>
        <td>${items}</td>
        <td><strong>${o.total_portions}</strong></td>
        <td>₹${o.total}</td>
        <td>${o.status}</td>
      </tr>
    `;
  }).join('');

  sheet.innerHTML = `
    <div style="padding: 20px;">
      <h1>DumCraft Kitchen & Delivery Sheet</h1>
      <p style="margin-bottom: 14px;">Date: <strong>${dateVal}</strong> | Total Orders: <strong>${ordersData.length}</strong> | Total Portions: <strong>${document.getElementById('metricPortions').textContent}</strong></p>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Order No</th>
            <th>Customer</th>
            <th>Address</th>
            <th>Items</th>
            <th>Portions</th>
            <th>Total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;

  window.print();
}

// Export CSV
function exportOrdersCSV() {
  if (ordersData.length === 0) {
    showAlert('No orders to export', 'warning');
    return;
  }
  const dateVal = document.getElementById('orderDateFilter').value || 'all-dates';
  let csv = 'Order No,Date,Customer Name,Phone,Address,Notes,Status,Total Portions,Total Amount,Over Limit,Items\n';

  ordersData.forEach(o => {
    const items = (o.items || []).map(it => `${it.qty}x ${it.item_name}`).join(' | ');
    const row = [
      `"${o.order_no}"`,
      `"${o.service_date}"`,
      `"${(o.customer_name || '').replace(/"/g, '""')}"`,
      `"${o.phone || ''}"`,
      `"${(o.address || '').replace(/"/g, '""')}"`,
      `"${(o.notes || '').replace(/"/g, '""')}"`,
      `"${o.status}"`,
      o.total_portions,
      o.total,
      o.over_limit ? 'YES' : 'NO',
      `"${items.replace(/"/g, '""')}"`
    ];
    csv += row.join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dumcraft-orders-${dateVal}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ==========================================
// WHATSAPP TRIGGER & FEEDBACK REQUESTS
// ==========================================
let currentWaOrderId = null;
let appSettings = {};

function sendWaFeedback(orderId) {
  const o = ordersData.find(x => x.id === orderId);
  if (!o) return;
  const phoneClean = (o.phone || '').replace(/[^0-9]/g, '');
  if (!phoneClean) {
    showAlert('Customer has no phone number recorded', 'warning');
    return;
  }

  // Construct personalized feedback link
  const origin = window.location.origin;
  const feedbackUrl = `${origin}/feedback?order=${encodeURIComponent(o.order_no)}`;

  let template = (appSettings && appSettings.whatsapp_feedback_template)
    ? appSettings.whatsapp_feedback_template
    : `Hi {name}, thank you for ordering with DumCraft today! 🍗✨\n\nWe hope you enjoyed your Biryani! We'd love 30 seconds of your feedback so Chef and team can make your next meal even better:\n👉 {feedback_url}\n\nThank you,\nTeam DumCraft`;

  const msg = template
    .replace(/{name}/g, o.customer_name || 'there')
    .replace(/{order_no}/g, o.order_no)
    .replace(/{feedback_url}/g, feedbackUrl)
    .replace(/{date}/g, o.service_date);

  const waUrl = `https://wa.me/91${phoneClean}?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
  showAlert(`Opened WhatsApp feedback request for ${o.customer_name}!`);
}

function openWaModal(orderId) {
  const o = ordersData.find(x => x.id === orderId);
  if (!o) return;
  currentWaOrderId = orderId;

  document.getElementById('waModalCustomer').textContent = o.customer_name;
  document.getElementById('waModalPhone').textContent = o.phone || 'No phone';
  document.getElementById('waModalOrderNo').textContent = o.order_no;
  const itemsText = (o.items || []).map(it => `${it.qty}x ${it.item_name}`).join(', ');
  document.getElementById('waModalItems').textContent = itemsText || 'Dum Biryani';

  document.getElementById('waActionModal').style.display = 'flex';
}

function closeWaModal() {
  document.getElementById('waActionModal').style.display = 'none';
  currentWaOrderId = null;
}

function sendWaFeedbackFromModal() {
  if (currentWaOrderId) {
    sendWaFeedback(currentWaOrderId);
    closeWaModal();
  }
}

function sendWaDeliveryFromModal() {
  const o = ordersData.find(x => x.id === currentWaOrderId);
  if (!o) return;
  const phoneClean = (o.phone || '').replace(/[^0-9]/g, '');
  if (!phoneClean) return;

  const itemsText = (o.items || []).map(it => `${it.qty}x ${it.item_name}`).join(', ');
  const isPaid = (o.notes && o.notes.includes('[PAID]'));
  const payNotice = isPaid ? '✅ Payment already received. Thank you!' : `Please keep ₹${o.total} ready (Cash or UPI) on arrival.`;

  const msg = `Hi ${o.customer_name}, your DumCraft order #${o.order_no} is OUT FOR DELIVERY! 🛵💨\n\nItems: ${itemsText}\nTotal: ₹${o.total}\n${payNotice}\n\nOur delivery rider is on the way. Enjoy your meal! 🍗✨`;
  
  window.open(`https://wa.me/91${phoneClean}?text=${encodeURIComponent(msg)}`, '_blank');
  closeWaModal();
  showAlert(`Opened Out for Delivery WhatsApp alert for ${o.customer_name}!`);
}

function sendWaConfirmedFromModal() {
  const o = ordersData.find(x => x.id === currentWaOrderId);
  if (!o) return;
  const phoneClean = (o.phone || '').replace(/[^0-9]/g, '');
  if (!phoneClean) return;

  const itemsText = (o.items || []).map(it => `${it.qty}x ${it.item_name}`).join(', ');
  const msg = `Hi ${o.customer_name}! Your DumCraft order #${o.order_no} for ${o.service_date} is CONFIRMED! 👨‍🍳🔥\n\nItems: ${itemsText}\nTotal: ₹${o.total}\n\nWe will freshly cook and pack your dum biryani on ${o.service_date}. Thank you for ordering with us!`;

  window.open(`https://wa.me/91${phoneClean}?text=${encodeURIComponent(msg)}`, '_blank');
  closeWaModal();
  showAlert(`Opened Order Confirmation WhatsApp alert for ${o.customer_name}!`);
}

function sendWaDirectChat() {
  const o = ordersData.find(x => x.id === currentWaOrderId);
  if (!o) return;
  const phoneClean = (o.phone || '').replace(/[^0-9]/g, '');
  if (phoneClean) {
    window.open(`https://wa.me/91${phoneClean}`, '_blank');
  }
  closeWaModal();
}

// Manual Order Modal
function openManualOrderModal() {
  document.getElementById('manDate').value = document.getElementById('orderDateFilter').value || '';
  document.getElementById('manOrderItemsList').innerHTML = '';
  addManualOrderItemRow();
  document.getElementById('manualOrderModal').style.display = 'flex';
}

function closeManualOrderModal() {
  document.getElementById('manualOrderModal').style.display = 'none';
}

function addManualOrderItemRow() {
  const container = document.getElementById('manOrderItemsList');
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.gap = '8px';
  div.style.marginBottom = '6px';

  let options = menuItems.map(m => `<option value="${m.id}" data-name="${m.name}" data-price="${m.price}">${m.name} (₹${m.price})</option>`).join('');

  div.innerHTML = `
    <select class="man-item-select" style="flex: 3;">${options}</select>
    <input type="number" class="man-item-qty" value="1" min="1" style="flex: 1;" placeholder="Qty">
    <button type="button" class="btn btn-secondary btn-sm" onclick="this.parentElement.remove()">✕</button>
  `;
  container.appendChild(div);
}

async function submitManualOrder(e) {
  e.preventDefault();
  const rows = document.querySelectorAll('#manOrderItemsList > div');
  const items = [];
  rows.forEach(r => {
    const sel = r.querySelector('.man-item-select');
    const opt = sel.options[sel.selectedIndex];
    const qty = parseInt(r.querySelector('.man-item-qty').value, 10);
    if (qty > 0) {
      items.push({
        item_id: parseInt(opt.value, 10),
        item_name: opt.getAttribute('data-name'),
        unit_price: parseFloat(opt.getAttribute('data-price')),
        qty
      });
    }
  });

  if (items.length === 0) {
    alert('Please add at least one item');
    return;
  }

  const payload = {
    service_date: document.getElementById('manDate').value,
    customer_name: document.getElementById('manCustName').value.trim(),
    phone: document.getElementById('manCustPhone').value.trim(),
    address: document.getElementById('manCustAddress').value.trim(),
    notes: document.getElementById('manCustNotes').value.trim(),
    items,
    over_limit: document.getElementById('manForceOverLimit').checked
  };

  try {
    await apiFetch('/api/team/orders', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    closeManualOrderModal();
    loadOrders();
    showAlert('Manual order recorded successfully');
  } catch (err) {
    alert(`Failed to save manual order: ${err.message}`);
  }
}

// ==========================================
// CALENDAR & LIMITS
// ==========================================
async function loadCalendar() {
  const tbody = document.getElementById('calTableBody');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Loading calendar...</td></tr>';

  try {
    const data = await apiFetch('/api/team/service-days');
    serviceDays = data;
    renderCalendar();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="alert alert-danger">${err.message}</td></tr>`;
  }
}

function renderCalendar() {
  const tbody = document.getElementById('calTableBody');
  if (serviceDays.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">No service days scheduled yet. Add one above!</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  serviceDays.forEach(d => {
    const tr = document.createElement('tr');
    const isFull = d.booked_portions >= d.order_limit;
    const statusText = !d.open ? '<span class="badge badge-cancelled">Closed</span>' 
      : (isFull ? '<span class="badge badge-overlimit">Limit Reached</span>' : '<span class="badge badge-delivered">Open</span>');

    tr.innerHTML = `
      <td><strong>${d.date}</strong></td>
      <td>${statusText}</td>
      <td><strong>${d.booked_portions}</strong> / ${d.order_limit} portions (${d.order_count || 0} orders)</td>
      <td>${d.allow_overflow ? '<span class="badge badge-confirmed">Yes (Overflow ON)</span>' : '<span class="muted">No</span>'}</td>
      <td>${d.cutoff_time ? `Cutoff: ${d.cutoff_time}` : ''} ${d.note ? `<br><small class="muted">${d.note}</small>` : ''}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick='editCalDay(${JSON.stringify(d)})'>Edit</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function editCalDay(d) {
  document.getElementById('calDate').value = d.date;
  document.getElementById('calLimit').value = d.order_limit;
  document.getElementById('calCutoff').value = d.cutoff_time || '';
  document.getElementById('calNote').value = d.note || '';
  document.getElementById('calOpen').checked = !!d.open;
  document.getElementById('calOverflow').checked = !!d.allow_overflow;
  document.getElementById('calFormTitle').textContent = `Update Service Day (${d.date})`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function saveServiceDay(e) {
  e.preventDefault();
  const payload = {
    date: document.getElementById('calDate').value,
    order_limit: parseInt(document.getElementById('calLimit').value, 10),
    cutoff_time: document.getElementById('calCutoff').value || null,
    note: document.getElementById('calNote').value || null,
    open: document.getElementById('calOpen').checked,
    allow_overflow: document.getElementById('calOverflow').checked
  };

  try {
    await apiFetch('/api/team/service-days', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    showAlert(`Service day ${payload.date} saved`);
    loadCalendar();
  } catch (err) {
    showAlert(`Error saving service day: ${err.message}`, 'danger');
  }
}

// ==========================================
// MENU MANAGEMENT & BROWSER IMAGE RESIZE
// ==========================================
async function loadMenu() {
  const listEl = document.getElementById('teamMenuList');
  listEl.innerHTML = '<div class="muted">Loading menu items...</div>';

  try {
    const data = await apiFetch('/api/team/menu');
    menuItems = data;
    renderTeamMenu();
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderTeamMenu() {
  const listEl = document.getElementById('teamMenuList');
  if (menuItems.length === 0) {
    listEl.innerHTML = '<div class="muted">No menu items found. Click "+ Add Item" above.</div>';
    return;
  }

  listEl.innerHTML = '';
  menuItems.forEach(item => {
    const card = document.createElement('div');
    card.className = 'menu-card';

    const imgHtml = item.image 
      ? `<img src="${item.image}" alt="${item.name}" class="menu-img">`
      : `<div class="menu-img">🍲</div>`;

    card.innerHTML = `
      ${imgHtml}
      <div class="menu-info">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong class="menu-title">${item.name}</strong>
          <span class="badge ${item.available ? 'badge-delivered' : 'badge-cancelled'}">${item.available ? 'Available' : 'Hidden'}</span>
        </div>
        ${item.description ? `<p class="menu-desc">${item.description}</p>` : ''}
        <div class="menu-price">₹${item.price} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">(Sort: ${item.sort})</span></div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <button class="btn btn-secondary btn-sm" onclick='openMenuItemModal(${JSON.stringify(item)})'>Edit</button>
        <button class="btn btn-outline-danger btn-sm" onclick="deleteMenuItem(${item.id})">Delete</button>
      </div>
    `;
    listEl.appendChild(card);
  });
}

function openMenuItemModal(item = null) {
  compressedImageData = null;
  document.getElementById('imagePreviewContainer').style.display = 'none';
  document.getElementById('itemFormImageFile').value = '';

  if (item) {
    document.getElementById('menuModalTitle').textContent = 'Edit Menu Item';
    document.getElementById('menuItemId').value = item.id;
    document.getElementById('itemFormName').value = item.name;
    document.getElementById('itemFormDesc').value = item.description || '';
    document.getElementById('itemFormPrice').value = item.price;
    document.getElementById('itemFormSort').value = item.sort;
    document.getElementById('itemFormAvailable').checked = !!item.available;

    if (item.image) {
      document.getElementById('imagePreview').src = item.image;
      document.getElementById('imageSizeBadge').textContent = 'Current Photo';
      document.getElementById('imagePreviewContainer').style.display = 'block';
    }
  } else {
    document.getElementById('menuModalTitle').textContent = 'Add Menu Item';
    document.getElementById('menuItemId').value = '';
    document.getElementById('itemFormName').value = '';
    document.getElementById('itemFormDesc').value = '';
    document.getElementById('itemFormPrice').value = '';
    document.getElementById('itemFormSort').value = menuItems.length + 1;
    document.getElementById('itemFormAvailable').checked = true;
  }

  document.getElementById('menuItemModal').style.display = 'flex';
}

function closeMenuItemModal() {
  document.getElementById('menuItemModal').style.display = 'none';
}

// Client-side image resizing and compression using HTML5 Canvas (<100KB, max 800px)
function handleImageCompress(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(event) {
    const img = new Image();
    img.onload = function() {
      const maxDim = 800;
      let width = img.width;
      let height = img.height;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);

      // Export compressed JPEG at 0.72 quality
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      compressedImageData = dataUrl;

      // Calculate approximate KB size
      const approxKb = Math.round((dataUrl.length * 3 / 4) / 1024);

      document.getElementById('imagePreview').src = dataUrl;
      document.getElementById('imageSizeBadge').textContent = `Compressed: ${width}x${height}px (~${approxKb} KB)`;
      document.getElementById('imagePreviewContainer').style.display = 'block';
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

async function saveMenuItem(e) {
  e.preventDefault();
  const id = document.getElementById('menuItemId').value;
  const payload = {
    name: document.getElementById('itemFormName').value.trim(),
    description: document.getElementById('itemFormDesc').value.trim(),
    price: parseFloat(document.getElementById('itemFormPrice').value),
    sort: parseInt(document.getElementById('itemFormSort').value, 10),
    available: document.getElementById('itemFormAvailable').checked
  };

  if (compressedImageData) {
    payload.image = compressedImageData;
  }

  try {
    if (id) {
      await apiFetch(`/api/team/menu/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showAlert('Menu item updated');
    } else {
      await apiFetch('/api/team/menu', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showAlert('Menu item created');
    }
    closeMenuItemModal();
    loadMenu();
  } catch (err) {
    alert(`Failed to save menu item: ${err.message}`);
  }
}

async function deleteMenuItem(id) {
  if (!confirm('Are you sure you want to delete this menu item?')) return;
  try {
    await apiFetch(`/api/team/menu/${id}`, { method: 'DELETE' });
    showAlert('Menu item deleted');
    loadMenu();
  } catch (err) {
    showAlert(`Delete failed: ${err.message}`, 'danger');
  }
}

// ==========================================
// TASKS MANAGEMENT
// ==========================================
let allTasks = [];

async function loadTasks() {
  const listEl = document.getElementById('tasksList');
  listEl.innerHTML = '<div class="muted">Loading tasks...</div>';

  try {
    allTasks = await apiFetch('/api/team/tasks');
    renderTasks();
  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderTasks() {
  const listEl = document.getElementById('tasksList');
  const assigneeFilter = document.getElementById('taskFilterAssignee').value;
  const statusFilter = document.getElementById('taskFilterStatus').value;

  const filtered = allTasks.filter(t => {
    const matchAssignee = assigneeFilter === 'ALL' || t.assignee === assigneeFilter;
    const matchStatus = statusFilter === 'ALL' || t.status === statusFilter;
    return matchAssignee && matchStatus;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="muted" style="padding:14px; text-align:center;">No tasks matching criteria.</div>';
    return;
  }

  listEl.innerHTML = '';
  filtered.forEach(t => {
    const div = document.createElement('div');
    const isDone = t.status === 'Done';
    div.className = `task-item ${isDone ? 'done' : ''}`;

    div.innerHTML = `
      <div class="task-left">
        <input type="checkbox" class="task-checkbox" ${isDone ? 'checked' : ''} onchange="toggleTaskStatus(${t.id}, this.checked)">
        <div>
          <div style="font-weight:600; font-size:0.95rem;">${t.title}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">
            ${t.assignee ? `👤 ${t.assignee}` : '👤 Unassigned'}
            ${t.due_date ? ` • 📅 Due: ${t.due_date}` : ''}
          </div>
        </div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="deleteTask(${t.id})" title="Delete">✕</button>
    `;
    listEl.appendChild(div);
  });
}

async function saveTask(e) {
  e.preventDefault();
  const payload = {
    title: document.getElementById('taskTitle').value.trim(),
    assignee: document.getElementById('taskAssignee').value,
    due_date: document.getElementById('taskDueDate').value || null
  };

  try {
    await apiFetch('/api/team/tasks', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    document.getElementById('taskTitle').value = '';
    loadTasks();
    showAlert('Task created');
  } catch (err) {
    showAlert(`Failed to create task: ${err.message}`, 'danger');
  }
}

async function toggleTaskStatus(taskId, isChecked) {
  try {
    await apiFetch(`/api/team/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: isChecked ? 'Done' : 'Pending' })
    });
    loadTasks();
  } catch (err) {
    showAlert(`Status change failed: ${err.message}`, 'danger');
  }
}

async function deleteTask(taskId) {
  try {
    await apiFetch(`/api/team/tasks/${taskId}`, { method: 'DELETE' });
    loadTasks();
  } catch (err) {
    showAlert(`Delete failed: ${err.message}`, 'danger');
  }
}

// ==========================================
// FINANCES (EXPENSES & INCOME)
// ==========================================
async function loadFinances() {
  try {
    const data = await apiFetch('/api/team/finances');
    document.getElementById('finConfirmedIncome').textContent = `₹${data.confirmed_income || 0}`;
    document.getElementById('finExpectedIncome').textContent = `₹${data.expected_income || 0}`;
    document.getElementById('finTotalExpenses').textContent = `₹${data.total_expenses || 0}`;
    document.getElementById('finProfit').textContent = `₹${data.profit || 0}`;

    // Category pills
    const pillsContainer = document.getElementById('finCategoryPills');
    pillsContainer.innerHTML = '';
    const breakdown = data.category_breakdown || {};
    if (Object.keys(breakdown).length === 0) {
      pillsContainer.innerHTML = '<span class="muted">No expenses recorded yet.</span>';
    } else {
      Object.entries(breakdown).forEach(([cat, amt]) => {
        const pill = document.createElement('span');
        pill.className = 'badge';
        if (cat === 'wastage') {
          pill.style.background = '#fef3c7';
          pill.style.color = '#b45309';
          pill.style.border = '1px solid #fde68a';
          pill.style.fontSize = '0.85rem';
          pill.style.fontWeight = '700';
          pill.textContent = `⚠️ WASTAGE: ₹${amt}`;
        } else {
          pill.style.background = '#fee2e2';
          pill.style.color = '#b91c1c';
          pill.style.fontSize = '0.85rem';
          pill.textContent = `${cat.toUpperCase()}: ₹${amt}`;
        }
        pillsContainer.appendChild(pill);
      });
    }

    // Expenses Table
    const tbody = document.getElementById('expensesTableBody');
    tbody.innerHTML = '';
    const expenses = data.expenses || [];
    if (expenses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">No expenses recorded yet.</td></tr>';
    } else {
      expenses.forEach(e => {
        const tr = document.createElement('tr');
        const isWastage = e.category === 'wastage';
        const badgeStyle = isWastage
          ? 'background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-weight:700;'
          : 'background:#fee2e2; color:#b91c1c;';
        const catLabel = isWastage ? '⚠️ wastage' : e.category;
        tr.innerHTML = `
          <td>${e.date}</td>
          <td><span class="badge" style="${badgeStyle}">${catLabel}</span></td>
          <td><strong style="${isWastage ? 'color:#b45309;' : ''}">₹${e.amount}</strong></td>
          <td>${e.note || ''}</td>
          <td><button class="btn btn-outline-danger btn-sm" onclick="deleteExpense(${e.id})">Delete</button></td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    showAlert(`Error loading finances: ${err.message}`, 'danger');
  }
}

async function saveExpense(e) {
  e.preventDefault();
  const payload = {
    date: document.getElementById('expDate').value,
    category: document.getElementById('expCategory').value,
    amount: parseFloat(document.getElementById('expAmount').value),
    note: document.getElementById('expNote').value.trim()
  };

  try {
    await apiFetch('/api/team/expenses', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    document.getElementById('expAmount').value = '';
    document.getElementById('expNote').value = '';
    showAlert('Expense recorded');
    loadFinances();
  } catch (err) {
    showAlert(`Failed to record expense: ${err.message}`, 'danger');
  }
}

async function deleteExpense(id) {
  if (!confirm('Delete this expense entry?')) return;
  try {
    await apiFetch(`/api/team/expenses/${id}`, { method: 'DELETE' });
    showAlert('Expense deleted');
    loadFinances();
  } catch (err) {
    showAlert(`Delete failed: ${err.message}`, 'danger');
  }
}

async function saveIncome(e) {
  e.preventDefault();
  const payload = {
    date: document.getElementById('incDate').value,
    amount: parseFloat(document.getElementById('incAmount').value),
    note: document.getElementById('incNote').value.trim()
  };

  try {
    await apiFetch('/api/team/income', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    document.getElementById('incAmount').value = '';
    document.getElementById('incNote').value = '';
    showAlert('Manual income recorded');
    loadFinances();
  } catch (err) {
    showAlert(`Failed to record income: ${err.message}`, 'danger');
  }
}

// ==========================================
// CUSTOMER FEEDBACK & REVIEWS
// ==========================================
async function loadFeedback() {
  const listEl = document.getElementById('feedbackList');
  listEl.innerHTML = '<div class="muted" style="text-align:center; padding:24px;">Loading customer reviews...</div>';

  try {
    const data = await apiFetch('/api/team/feedback');
    const summary = data.summary || {};
    document.getElementById('fbAvgOverall').textContent = `⭐ ${summary.overall_avg || '0.0'}`;
    document.getElementById('fbAvgBiryani').textContent = `🍗 ${summary.avg_biryani || '0.0'}`;
    document.getElementById('fbAvgAccompaniments').textContent = `🥣 ${summary.avg_accompaniments || '0.0'}`;
    document.getElementById('fbAvgPackaging').textContent = `📦 ${summary.avg_packaging || '0.0'}`;
    document.getElementById('fbTotalCount').textContent = summary.total_reviews || 0;

    const reviews = data.reviews || [];
    if (reviews.length === 0) {
      listEl.innerHTML = '<div class="muted" style="text-align:center; padding:24px;">No reviews received yet. Use the "⭐ Ask Feedback" button on any order to request a review!</div>';
      return;
    }

    listEl.innerHTML = '';
    reviews.forEach(r => {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'padding:14px; margin-bottom:12px; border-left:4px solid #f59e0b; background:#fff;';

      const phoneClean = (r.phone || '').replace(/[^0-9]/g, '');
      const thanksMsg = `Hi ${r.customer_name}! Thank you so much for your kind review and rating of DumCraft Biryani. We really appreciate your feedback! 🍗✨`;
      const waThanksUrl = phoneClean ? `https://wa.me/91${phoneClean}?text=${encodeURIComponent(thanksMsg)}` : '#';

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
          <div>
            <span style="font-weight:700; font-size:1rem; color:var(--secondary);">${r.customer_name}</span>
            <span style="font-size:0.8rem; color:var(--text-muted); margin-left:6px;">(${r.order_no})</span>
            ${r.service_date ? `<span class="badge" style="background:#ffedd5; color:#c2410c; margin-left:6px; font-size:0.75rem;">${r.service_date}</span>` : ''}
          </div>
          <div style="display:flex; gap:6px; align-items:center;">
            <span style="font-size:0.75rem; color:var(--text-muted);">${new Date(r.created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}</span>
            ${phoneClean ? `<a href="${waThanksUrl}" target="_blank" class="btn btn-sm" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; font-size:0.75rem; font-weight:700; padding:2px 8px;">💬 Say Thanks</a>` : ''}
          </div>
        </div>

        <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:0.88rem; margin-bottom:8px; background:#f8fafc; padding:8px 10px; border-radius:6px; border:1px solid var(--border);">
          <span>🍗 Biryani: <strong style="color:#b45309;">${'★'.repeat(r.rating_biryani)}${'☆'.repeat(5 - r.rating_biryani)} (${r.rating_biryani}/5)</strong></span>
          <span>🥣 Accompaniments: <strong style="color:#0284c7;">${'★'.repeat(r.rating_accompaniments)}${'☆'.repeat(5 - r.rating_accompaniments)} (${r.rating_accompaniments}/5)</strong></span>
          <span>📦 Packaging: <strong style="color:#059669;">${'★'.repeat(r.rating_packaging)}${'☆'.repeat(5 - r.rating_packaging)} (${r.rating_packaging}/5)</strong></span>
        </div>

        ${r.comments ? `
          <div style="font-size:0.88rem; color:#451a03; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px 10px; line-height:1.4;">
            💬 <strong>Customer Note:</strong> "${r.comments}"
          </div>
        ` : '<div style="font-size:0.8rem; color:var(--text-muted); font-style:italic;">No written comments provided.</div>'}
      `;
      listEl.appendChild(card);
    });

  } catch (err) {
    listEl.innerHTML = `<div class="alert alert-danger">Error loading reviews: ${err.message}</div>`;
  }
}

// ==========================================
// SETTINGS & TEAM MEMBERS
// ==========================================
async function loadSettings() {
  try {
    const settings = await apiFetch('/api/team/settings');
    appSettings = settings || {};
    if (settings.brand_name) document.getElementById('settingBrand').value = settings.brand_name;
    if (settings.whatsapp_number) document.getElementById('settingWhatsapp').value = settings.whatsapp_number;
    if (settings.payment_note) document.getElementById('settingPayment').value = settings.payment_note;
    if (settings.whatsapp_template) document.getElementById('settingWaTemplate').value = settings.whatsapp_template;
    if (settings.whatsapp_feedback_template) document.getElementById('settingWaFeedbackTemplate').value = settings.whatsapp_feedback_template;
  } catch (err) {}
}

async function saveStoreSettings(e) {
  e.preventDefault();
  const payload = {
    brand_name: document.getElementById('settingBrand').value.trim(),
    whatsapp_number: document.getElementById('settingWhatsapp').value.trim(),
    payment_note: document.getElementById('settingPayment').value.trim(),
    whatsapp_template: document.getElementById('settingWaTemplate').value.trim(),
    whatsapp_feedback_template: document.getElementById('settingWaFeedbackTemplate').value.trim()
  };

  try {
    await apiFetch('/api/team/settings', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    appSettings = { ...appSettings, ...payload };
    showAlert('Settings updated successfully');
  } catch (err) {
    showAlert(`Failed to save settings: ${err.message}`, 'danger');
  }
}

async function loadMembers() {
  try {
    teamMembers = await apiFetch('/api/team/members');
    const container = document.getElementById('membersList');
    container.innerHTML = '';

    const taskSelect = document.getElementById('taskAssignee');
    const filterSelect = document.getElementById('taskFilterAssignee');
    taskSelect.innerHTML = '<option value="">Unassigned</option>';
    filterSelect.innerHTML = '<option value="ALL">All Assignees</option>';

    teamMembers.forEach(m => {
      // Badge in settings
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.background = '#e0f2fe';
      badge.style.color = '#0369a1';
      badge.style.padding = '6px 10px';
      badge.style.fontSize = '0.9rem';
      badge.innerHTML = `${m.name} <button onclick="deleteMember(${m.id})" style="border:none; background:none; cursor:pointer; color:#ef4444; font-weight:bold; margin-left:6px;">✕</button>`;
      container.appendChild(badge);

      // Add to task dropdowns
      const opt1 = document.createElement('option');
      opt1.value = m.name;
      opt1.textContent = m.name;
      taskSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = m.name;
      opt2.textContent = m.name;
      filterSelect.appendChild(opt2);
    });
  } catch (err) {}
}

async function addTeamMember(e) {
  e.preventDefault();
  const name = document.getElementById('newMemberName').value.trim();
  if (!name) return;

  try {
    await apiFetch('/api/team/members', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    document.getElementById('newMemberName').value = '';
    loadMembers();
    showAlert('Member added');
  } catch (err) {
    showAlert(`Failed: ${err.message}`, 'danger');
  }
}

async function deleteMember(id) {
  if (!confirm('Remove this team member?')) return;
  try {
    await apiFetch(`/api/team/members/${id}`, { method: 'DELETE' });
    loadMembers();
  } catch (err) {
    showAlert(`Delete failed: ${err.message}`, 'danger');
  }
}

// Start App
initTeam();
