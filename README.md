# DumCraft Ordering App 🍲

A free-to-host web application for **DumCraft**, a boutique cloud kitchen in Hyderabad, India.

Built for **₹0 hosting cost** on the Cloudflare Free Tier using **Cloudflare Pages** (static frontend) + **Pages Functions** (serverless API) + **D1** (serverless SQLite database).

---

## 🌟 Key Features

1. **Customer Ordering Experience (`/`)**:
   - Mobile-first, fast loading, zero-login ordering page.
   - Live menu with dish descriptions, prices, and portion selector.
   - Service calendar picker showing only open days with real-time remaining portion counts.
   - Form with 10-digit Indian mobile validation (`^[6-9]\d{9}$`) and honeypot bot protection.
   - Instant order confirmation screen with Order Number, breakdown, payment instructions (COD/UPI on delivery), and one-click **"Chat on WhatsApp"** button prefilled with order details.

2. **Team & Kitchen App (`/team/<TEAM_KEY>`)**:
   - Access controlled by private, unguessable URL (`TEAM_KEY` environment variable).
   - **Chef Prep Dashboard**: Big bold numbers showing **Total Portions to Cook**, active orders, and per-item preparation counts.
   - **Order Lifecycle Management**: One-tap status updates (`New` → `Confirmed` → `Preparing` → `Out for delivery` → `Delivered` / `Cancelled`). Auto-refreshes every 30 seconds.
   - **Over-Limit Detection**: Visually flags overflow orders in amber if orders exceeded daily capacity while overflow was toggled ON.
   - **Walk-in / Phone Orders**: Manual order entry modal for WhatsApp/phone orders.
   - **Kitchen & Packing Sheets**: One-click print-optimized view (`window.print()`) and CSV export.
   - **Service Calendar & Capacity**: Open/close dates, set max daily portions, toggle overflow acceptance, configure cut-off times, and add day notes.
   - **Menu Management**: Add/edit/hide items with in-browser image auto-resizing & compression (max 800px, <100 KB JPEG).
   - **Team Tasks**: Assign tasks to team members (Chef, Helper, Delivery) with one-tap completion.
   - **Financials**: Real-time tracking of Confirmed Income, Expected Income, Categorized Expenses, and Net Profit.
   - **Settings**: Brand name, WhatsApp phone number, and customizable payment instructions.

---

## 📁 Project Structure

```text
dumcraft/
├── public/
│   ├── index.html        # Customer ordering page
│   ├── team.html         # Team & chef dashboard
│   ├── style.css         # Mobile-first culinary stylesheet + print styles
│   └── team.js           # Team app client logic & image compression
├── functions/
│   ├── team/
│   │   └── [[key]].js    # Serves team.html with noindex / no-referrer headers
│   └── api/
│       └── [[route]].js  # Unified Cloudflare Pages Function API router
├── schema.sql            # SQLite D1 database schema with seed data
├── wrangler.toml         # Cloudflare Pages / D1 configuration
├── dev_server.py         # Local development server & API emulator (Python 3)
├── test_suite_inprocess.py # 10-step automated verification test suite
└── PROGRESS.md           # Progress tracking log
```

---

## 🚀 Cloudflare Pages Deployment (Step-by-Step, 100% Free)

### 1. Create Cloudflare D1 Database
Install Wrangler if needed (`npm install -g wrangler`) and run:
```bash
npx wrangler d1 create dumcraft-db
```
Note the `database_id` output by Wrangler.

### 2. Apply Schema & Seed Data
Execute `schema.sql` against your remote D1 database:
```bash
npx wrangler d1 execute dumcraft-db --remote --file=./schema.sql
```

### 3. Update `wrangler.toml`
Update `wrangler.toml` with your database id:
```toml
[[d1_databases]]
binding = "DB"
database_name = "dumcraft-db"
database_id = "YOUR_ACTUAL_D1_DATABASE_ID"
```

### 4. Deploy via Cloudflare Pages
Connect your Git repository (GitHub/GitLab) in the **Cloudflare Dashboard**:
- Go to **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
- Select the `dumcraft` repository.
- **Build settings**:
  - Framework preset: `None`
  - Build command: *(leave empty)*
  - Build output directory: `public`
- **Environment variables**:
  - Add `TEAM_KEY` = `your_strong_secret_key_here` (e.g. `dc_live_hyd_9824`)
- **D1 Database Binding**:
  - Go to your Pages project → **Settings** → **Functions** → **D1 database bindings**.
  - Variable name: `DB`
  - D1 database: Select `dumcraft-db`.

### 5. Accessing the Apps
- **Customer Link**: `https://<your-pages-subdomain>.pages.dev/`
- **Team Link**: `https://<your-pages-subdomain>.pages.dev/team/<YOUR_TEAM_KEY>`

---

## 🔄 Rotating the Team Key

To rotate the team link at any time:
1. Open **Cloudflare Dashboard** → **Workers & Pages** → Your Pages Project.
2. Go to **Settings** → **Environment variables**.
3. Edit `TEAM_KEY` and set a new random secret string.
4. Save and redeploy (or wait a few seconds for variable update).
5. Share the new URL `https://<site>/team/<NEW_KEY>` with your kitchen team. The old key will immediately return `401 Unauthorized`.

---

## 💾 Database Backup & Restore

### Backup (Export)
```bash
npx wrangler d1 export dumcraft-db --remote --output=./backup_$(date +%Y%m%d).sql
```

### Restore (Import)
```bash
npx wrangler d1 execute dumcraft-db --remote --file=./backup_YYYYMMDD.sql
```

---

## 🧪 Local Testing

You can run the built-in test suite locally using Python without needing any dependencies:
```bash
python3 test_suite_inprocess.py
```
To run the local development server:
```bash
python3 dev_server.py
```
- Customer URL: `http://127.0.0.1:8787/`
- Team URL: `http://127.0.0.1:8787/team/dc_secret_team_demo2026`
