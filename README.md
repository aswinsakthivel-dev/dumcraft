# DumCraft Ordering & Kitchen Management App 🍲

A lightweight, serverless web application built for **DumCraft**, a boutique cloud kitchen in Hyderabad, India.

Engineered for **₹0/month hosting cost** on the Cloudflare Free Tier using **Cloudflare Workers with Static Assets** + **Cloudflare D1** (distributed serverless SQLite database).

---

## 🌟 Key Features

### 1. Customer Ordering Portal (`/`)
- **Fast & Responsive**: Pure Vanilla JavaScript with zero framework bloat; loads instantaneously on mobile 4G/5G connections.
- **Dynamic Service Calendar**: Visual date picker showing only open kitchen dates with real-time portion availability.
- **Address & Notes**: Clear, helpful prompt for delivery notes (*"e.g. call on arrival, landmark, extra salad/salan"*).
- **Honeypot & Validation**: Indian phone number verification (`^[6-9]\d{9}$`) and hidden bot-trap protection.
- **Instant WhatsApp Confirmation**: Generates a clean, formatted WhatsApp order summary for the customer to confirm with the kitchen in one tap.

### 2. Team & Kitchen Dashboard (`/team/<TEAM_KEY>`)
Protected by unguessable URL routing and private key verification (`X-Team-Key`).

- **Chef Prep Totals**: Real-time counter of total portions to cook, active orders count, and per-item dish breakdowns.
- **Simplified Order Pipeline**:
  - Four straightforward action buttons: **Confirm**, **Payment Done**, **Dunzo-ED**, and **Cancel**.
  - Cancelled orders turn red and automatically move to the bottom.
  - One-tap clipboard copy icon for delivery addresses to quickly paste into Dunzo, Porter, or Google Maps.
  - Quick navigation buttons: **Today** and **📅 Next Service Day ⏭** to jump straight to the upcoming cook date.
- **Batch Management & Tracking**:
  - Automatic batch sequencing: November 22nd is anchored as **Batch 2**, subsequent dates sequence into **Batch 3, 4, 5...**, with support for custom batch names.
  - Batch badges displayed across Orders, Calendar, Tasks, and Expenses.
- **Customer Feedback & Review System (`/feedback`)**:
  - One-click **"⭐ Ask Feedback"** button on each order card generates a personalized WhatsApp message with a direct link.
  - Customers rate **Biryani**, **Accompaniments (Salan & Raita)**, and **Packaging & Warmth** with optional comments.
  - Dedicated **Reviews Hub** in the team app showing category averages and verified reviews linked to order details.
- **Finances, Batch Margins & Spender Tracking**:
  - **Batch Switcher**: Filter financial metrics by any individual batch or view overall lifetime numbers.
  - **Profit & Margins**: Calculates Actual Income, Pending Income, Total Expenses, Net Profit, Profit Margin (%), and Cost per Portion (₹).
  - **Team Member Spendings**: Records which team member paid for each expense, featuring an interactive stacked color distribution bar chart and individual member spending cards.
  - **Wastage & Spillage Tracking**: Dedicated category to record burnt portions, dropped boxes, or spoiled ingredients with warning badges.
  - **Batch Comparison Table**: Compares all batches side-by-side with booked portions, expenses, net profit, margin %, and top spender.
- **Service Calendar & Capacity Management**:
  - Open/close specific dates, set max daily portion limits, toggle overflow allowance, set cutoff times, and assign batch labels.
- **Team Tasks & Rostering**:
  - Assign preparation and delivery tasks to specific team members and map them to batches with one-tap status toggling.
- **Menu Management**:
  - Add, edit, or hide dishes with automatic in-browser client-side image resizing and compression (max 800px, <100 KB JPEG).

---

## 🛠️ Tech Stack & Architecture

| Layer | Technology | Description |
| :--- | :--- | :--- |
| **Frontend** | HTML5, CSS3, Vanilla JS (ES6+) | Zero build-step static web app (`<100 KB` total weight). |
| **Edge Compute** | Cloudflare Workers | V8 isolate serverless edge runtime with 0 ms cold starts. |
| **Database** | Cloudflare D1 | Globally distributed SQLite database queried via SQL. |
| **Storage / CDN** | Cloudflare Static Assets | Edge CDN serving cached static files closest to the user. |
| **Testing** | Python 3 (`sqlite3`, `http.server`) | 12-suite in-process test harness and mock server for rapid local dev. |

---

## 📁 Project Structure

```text
dumcraft/
├── public/
│   ├── index.html            # Customer ordering portal
│   ├── team.html             # Kitchen & team management dashboard
│   ├── feedback.html         # Customer rating & review form
│   ├── style.css             # Mobile-first culinary stylesheet + print CSS
│   └── team.js               # Team app client logic, charts & batch handling
├── functions/
│   └── api/
│       └── [[route]].js      # Unified edge API router with D1 queries & migrations
├── worker.js                 # Cloudflare Worker entry point with static asset routing
├── schema.sql                # SQLite D1 database schema with initial seed data
├── wrangler.toml             # Cloudflare Workers, Assets & D1 configuration
├── dev_server.py             # Local Python development server & API emulator
├── test_suite_inprocess.py   # 12-suite automated end-to-end test suite
└── test_static.py            # Static asset endpoint verification test
```

---

## 🚀 Deployment Guide (100% Free on Cloudflare)

### 1. Create Cloudflare D1 Database
If using Wrangler locally:
```bash
npx wrangler d1 create dumcraft-db
```
Copy the resulting `database_id` into your `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "dumcraft-db"
database_id = "YOUR_ACTUAL_D1_DATABASE_ID"
```

### 2. Apply Schema & Seed Data
```bash
npx wrangler d1 execute dumcraft-db --remote --file=./schema.sql
```

### 3. Connect to Cloudflare Dashboard
1. Go to **Workers & Pages** → **Create** → **Connect to Git**.
2. Select the `dumcraft` repository.
3. In **Build Settings**:
   - **Deploy command**: `npx wrangler deploy`
4. Under **Settings → Bindings**:
   - Ensure D1 Database `dumcraft-db` is bound to variable name **`DB`**.
5. Under **Settings → Variables and Secrets**:
   - Add `TEAM_KEY` = your private secret key (e.g. `dc_secret_hyd_2026`).

Whenever you push to `main` (`git push origin main`), Cloudflare automatically builds and deploys your changes in seconds!

---

## 🧪 Local Development & Testing

Run the test suite without any external dependencies:
```bash
python3 test_suite_inprocess.py && python3 test_static.py
```

To run the local development server:
```bash
python3 dev_server.py
```
- Customer Portal: `http://127.0.0.1:8787/`
- Team Dashboard: `http://127.0.0.1:8787/team/dc_secret_team_demo2026`
- Customer Feedback: `http://127.0.0.1:8787/feedback`

---

## 🔄 Rotating the Team Dashboard Key

To change the private team link:
1. Open Cloudflare Dashboard → **Workers & Pages** → `dumcraft`.
2. Go to **Settings** → **Variables and Secrets**.
3. Update `TEAM_KEY` to a new secret string.
4. Share `https://<your-subdomain>.workers.dev/team/<NEW_KEY>` with your kitchen team. The old URL will immediately be rejected.
