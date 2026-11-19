#!/usr/bin/env python3
"""
DumCraft Local Development Server & API Emulator
Simulates Cloudflare Pages Functions + D1 SQLite for local testing and development.
"""

import os
import sys
import json
import sqlite3
import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse

PORT = 8787
DB_FILE = os.path.join(os.path.dirname(__file__), "dumcraft_local.db")
SCHEMA_FILE = os.path.join(os.path.dirname(__file__), "schema.sql")
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")
TEAM_KEY = os.environ.get("TEAM_KEY", "dc_secret_team_demo2026")

def init_db():
    conn = sqlite3.connect(DB_FILE)
    with open(SCHEMA_FILE, "r") as f:
        conn.executescript(f.read())
    conn.commit()
    conn.close()

def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn

class DumCraftHandler(BaseHTTPRequestHandler):
    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Team-Key")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))

    def send_error_json(self, message, status=400):
        self.send_json({"error": message, "success": False}, status)

    def parse_body(self):
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            raw = self.rfile.read(content_length).decode("utf-8")
            return json.loads(raw)
        return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # Team page route: /team/<key>
        if path == "/team" or path.startswith("/team/"):
            self.serve_file(os.path.join(PUBLIC_DIR, "team.html"), "text/html", extra_headers=[
                ("X-Robots-Tag", "noindex, nofollow"),
                ("Referrer-Policy", "no-referrer")
            ])
            return

        # Static assets
        if not path.startswith("/api"):
            rel_path = path.lstrip("/") or "index.html"
            file_path = os.path.join(PUBLIC_DIR, rel_path)
            if os.path.exists(file_path) and os.path.isfile(file_path):
                content_type = "text/html"
                if file_path.endswith(".css"): content_type = "text/css"
                elif file_path.endswith(".js"): content_type = "application/javascript"
                elif file_path.endswith(".json"): content_type = "application/json"
                elif file_path.endswith(".png"): content_type = "image/png"
                elif file_path.endswith(".jpg") or file_path.endswith(".jpeg"): content_type = "image/jpeg"
                elif file_path.endswith(".svg"): content_type = "image/svg+xml"
                self.serve_file(file_path, content_type)
                return
            else:
                # Default to index.html for SPA/customer routes
                self.serve_file(os.path.join(PUBLIC_DIR, "index.html"), "text/html")
                return

        # Check API team auth
        if path.startswith("/api/team"):
            req_key = self.headers.get("X-Team-Key") or (query.get("key", [None])[0])
            if req_key != TEAM_KEY:
                self.send_error_json("Unauthorized: Invalid or missing team key", 401)
                return

        conn = get_db()
        try:
            # Public GET /api/settings
            if path == "/api/settings":
                cur = conn.cursor()
                cur.execute("SELECT key, value FROM settings WHERE key IN ('brand_name', 'whatsapp_number', 'payment_note', 'whatsapp_template')")
                rows = cur.fetchall()
                data = {r["key"]: r["value"] for r in rows}
                self.send_json(data)
                return

            # Public GET /api/menu
            if path == "/api/menu":
                cur = conn.cursor()
                cur.execute("SELECT id, name, description, price, image, sort FROM menu_items WHERE available = 1 ORDER BY sort ASC, id ASC")
                rows = [dict(r) for r in cur.fetchall()]
                self.send_json(rows)
                return

            # Public GET /api/service-days
            if path == "/api/service-days":
                cur = conn.cursor()
                cur.execute("SELECT date, open, order_limit, allow_overflow, cutoff_time, note FROM service_days WHERE open = 1 ORDER BY date ASC LIMIT 14")
                days = [dict(r) for r in cur.fetchall()]
                results = []
                for d in days:
                    cur.execute("SELECT COALESCE(SUM(total_portions), 0) as booked FROM orders WHERE service_date = ? AND status != 'Cancelled'", (d["date"],))
                    booked = cur.fetchone()["booked"]
                    remaining = max(0, d["order_limit"] - booked)
                    is_sold_out = booked >= d["order_limit"] and d["allow_overflow"] == 0
                    results.append({
                        "date": d["date"],
                        "remaining_portions": remaining,
                        "order_limit": d["order_limit"],
                        "allow_overflow": bool(d["allow_overflow"]),
                        "is_sold_out": is_sold_out,
                        "cutoff_time": d["cutoff_time"],
                        "note": d["note"]
                    })
                self.send_json(results)
                return

            # Team GET /api/team/verify
            if path == "/api/team/verify":
                self.send_json({"valid": True})
                return

            # Team GET /api/team/menu
            if path == "/api/team/menu":
                cur = conn.cursor()
                cur.execute("SELECT id, name, description, price, image, available, sort, created_at FROM menu_items ORDER BY sort ASC, id ASC")
                self.send_json([dict(r) for r in cur.fetchall()])
                return

            # Team GET /api/team/service-days
            if path == "/api/team/service-days":
                cur = conn.cursor()
                cur.execute("SELECT date, open, order_limit, allow_overflow, cutoff_time, note FROM service_days ORDER BY date ASC")
                days = [dict(r) for r in cur.fetchall()]
                results = []
                for d in days:
                    cur.execute("SELECT COALESCE(SUM(total_portions), 0) as booked, COUNT(id) as order_count FROM orders WHERE service_date = ? AND status != 'Cancelled'", (d["date"],))
                    row = cur.fetchone()
                    results.append({
                        **d,
                        "open": bool(d["open"]),
                        "allow_overflow": bool(d["allow_overflow"]),
                        "booked_portions": row["booked"],
                        "order_count": row["order_count"]
                    })
                self.send_json(results)
                return

            # Team GET /api/team/orders
            if path == "/api/team/orders":
                date_param = query.get("date", [None])[0]
                cur = conn.cursor()
                if date_param:
                    cur.execute("SELECT * FROM orders WHERE service_date = ? ORDER BY id DESC", (date_param,))
                else:
                    cur.execute("SELECT * FROM orders ORDER BY service_date DESC, id DESC LIMIT 200")
                orders = [dict(r) for r in cur.fetchall()]

                total_portions_to_cook = 0
                total_active_orders = 0
                item_totals = {}
                status_counts = {"New": 0, "Confirmed": 0, "Preparing": 0, "Out for delivery": 0, "Delivered": 0, "Cancelled": 0}

                for o in orders:
                    cur.execute("SELECT item_id, item_name, unit_price, qty FROM order_items WHERE order_id = ?", (o["id"],))
                    items = [dict(it) for it in cur.fetchall()]
                    o["items"] = items
                    o["over_limit"] = bool(o["over_limit"])
                    status_counts[o["status"]] = status_counts.get(o["status"], 0) + 1

                    if o["status"] != "Cancelled":
                        total_portions_to_cook += o.get("total_portions", 0)
                        total_active_orders += 1
                        for it in items:
                            name = it["item_name"]
                            item_totals[name] = item_totals.get(name, 0) + it["qty"]

                self.send_json({
                    "orders": orders,
                    "summary": {
                        "total_portions_to_cook": total_portions_to_cook,
                        "total_active_orders": total_active_orders,
                        "item_totals": item_totals,
                        "status_counts": status_counts
                    }
                })
                return

            # Team GET /api/team/tasks
            if path == "/api/team/tasks":
                cur = conn.cursor()
                cur.execute("SELECT id, title, assignee, due_date, status, created_at, completed_at FROM tasks ORDER BY CASE WHEN status = 'Pending' THEN 0 ELSE 1 END, id DESC")
                self.send_json([dict(r) for r in cur.fetchall()])
                return

            # Team GET /api/team/members
            if path == "/api/team/members":
                cur = conn.cursor()
                cur.execute("SELECT id, name FROM team_members ORDER BY name ASC")
                self.send_json([dict(r) for r in cur.fetchall()])
                return

            # Team GET /api/team/finances
            if path == "/api/team/finances":
                cur = conn.cursor()
                cur.execute("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status IN ('Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Dunzo-ED')")
                conf_income = cur.fetchone()["total"]

                cur.execute("SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE status = 'New'")
                exp_income = cur.fetchone()["total"]

                cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM income_entries")
                manual_income = cur.fetchone()["total"]

                cur.execute("SELECT COALESCE(SUM(amount), 0) as total FROM expenses")
                total_expenses = cur.fetchone()["total"]

                cur.execute("SELECT category, COALESCE(SUM(amount), 0) as total FROM expenses GROUP BY category")
                cat_breakdown = {r["category"]: r["total"] for r in cur.fetchall()}

                cur.execute("SELECT id, date, category, amount, note FROM expenses ORDER BY date DESC, id DESC LIMIT 50")
                expenses_list = [dict(r) for r in cur.fetchall()]

                cur.execute("SELECT id, date, amount, note FROM income_entries ORDER BY date DESC, id DESC LIMIT 50")
                income_list = [dict(r) for r in cur.fetchall()]

                total_confirmed = conf_income + manual_income
                profit = total_confirmed - total_expenses

                self.send_json({
                    "confirmed_income": total_confirmed,
                    "expected_income": exp_income,
                    "total_expenses": total_expenses,
                    "profit": profit,
                    "category_breakdown": cat_breakdown,
                    "expenses": expenses_list,
                    "manual_income": income_list
                })
                return

            # Team GET /api/team/settings
            if path == "/api/team/settings":
                cur = conn.cursor()
                cur.execute("SELECT key, value FROM settings")
                data = {r["key"]: r["value"] for r in cur.fetchall()}
                self.send_json(data)
                return

            self.send_error_json(f"Not found: GET {path}", 404)
        finally:
            conn.close()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.parse_body()

        # Check API team auth
        if path.startswith("/api/team"):
            req_key = self.headers.get("X-Team-Key")
            if req_key != TEAM_KEY:
                self.send_error_json("Unauthorized: Invalid or missing team key", 401)
                return

        conn = get_db()
        try:
            # Customer POST /api/orders
            if path == "/api/orders":
                if body.get("website_hp"):
                    self.send_error_json("Invalid submission", 400)
                    return

                customer_name = (body.get("customer_name") or "").strip()
                phone = (body.get("phone") or "").strip()
                address = (body.get("address") or "").strip()
                notes = (body.get("notes") or "").strip()
                service_date = (body.get("service_date") or "").strip()
                items = body.get("items") or []

                if not customer_name: return self.send_error_json("Customer name is required")
                if len(phone) != 10 or not phone.isdigit() or phone[0] not in "6789":
                    return self.send_error_json("Please provide a valid 10-digit Indian mobile number")
                if not address: return self.send_error_json("Delivery address is required")
                if not service_date: return self.send_error_json("Please select a service day")
                if not items: return self.send_error_json("Please add at least one item to your order")

                cur = conn.cursor()
                cur.execute("BEGIN IMMEDIATE")

                # Verify service day
                cur.execute("SELECT date, open, order_limit, allow_overflow, cutoff_time FROM service_days WHERE date = ?", (service_date,))
                day = cur.fetchone()
                if not day or day["open"] != 1:
                    conn.rollback()
                    return self.send_error_json("Selected service day is not accepting orders")

                # Verify menu items and prices
                cur.execute("SELECT id, name, price, available FROM menu_items")
                menu_dict = {m["id"]: m for m in cur.fetchall()}

                order_total = 0
                order_portions = 0
                verified_items = []

                for it in items:
                    item_id = int(it.get("item_id", 0))
                    qty = int(it.get("qty", 0))
                    menu_item = menu_dict.get(item_id)
                    if not menu_item or qty <= 0: continue
                    if menu_item["available"] != 1:
                        conn.rollback()
                        return self.send_error_json(f'Item "{menu_item["name"]}" is currently unavailable')
                    order_total += menu_item["price"] * qty
                    order_portions += qty
                    verified_items.append({
                        "item_id": menu_item["id"],
                        "name": menu_item["name"],
                        "unit_price": menu_item["price"],
                        "qty": qty
                    })

                if not verified_items:
                    conn.rollback()
                    return self.send_error_json("No valid items in order")

                # Atomic portion limit check
                cur.execute("SELECT COALESCE(SUM(total_portions), 0) as booked FROM orders WHERE service_date = ? AND status != 'Cancelled'", (service_date,))
                current_booked = cur.fetchone()["booked"]
                over_limit = 0

                if current_booked + order_portions > day["order_limit"]:
                    if day["allow_overflow"]:
                        over_limit = 1
                    else:
                        remaining = max(0, day["order_limit"] - current_booked)
                        conn.rollback()
                        return self.send_error_json(f"Sold out! Only {remaining} portion(s) remaining for {service_date}.")

                date_part = service_date.replace("-", "")
                import random
                order_no = f"DC-{date_part}-{random.randint(1000, 9999)}"

                cur.execute(
                    "INSERT INTO orders (order_no, service_date, customer_name, phone, address, notes, status, total, total_portions, over_limit, source) VALUES (?, ?, ?, ?, ?, ?, 'New', ?, ?, ?, 'web')",
                    (order_no, service_date, customer_name, phone, address, notes, order_total, order_portions, over_limit)
                )
                order_id = cur.lastrowid

                for it in verified_items:
                    cur.execute(
                        "INSERT INTO order_items (order_id, item_id, item_name, unit_price, qty) VALUES (?, ?, ?, ?, ?)",
                        (order_id, it["item_id"], it["name"], it["unit_price"], it["qty"])
                    )

                conn.commit()

                cur.execute("SELECT key, value FROM settings WHERE key IN ('whatsapp_number', 'payment_note')")
                settings_map = {r["key"]: r["value"] for r in cur.fetchall()}

                self.send_json({
                    "success": True,
                    "order_no": order_no,
                    "service_date": service_date,
                    "customer_name": customer_name,
                    "phone": phone,
                    "address": address,
                    "notes": notes,
                    "total": order_total,
                    "total_portions": order_portions,
                    "over_limit": bool(over_limit),
                    "items": verified_items,
                    "whatsapp_number": settings_map.get("whatsapp_number", ""),
                    "payment_note": settings_map.get("payment_note", "")
                }, 201)
                return

            # Team POST /api/team/menu
            if path == "/api/team/menu":
                name = (body.get("name") or "").strip()
                description = (body.get("description") or "").strip()
                price = float(body.get("price") or 0)
                image = body.get("image")
                available = 1 if body.get("available") else 0
                sort = int(body.get("sort") or 0)

                if not name: return self.send_error_json("Name is required")
                if price <= 0: return self.send_error_json("Price must be greater than 0")

                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO menu_items (name, description, price, image, available, sort) VALUES (?, ?, ?, ?, ?, ?)",
                    (name, description, price, image, available, sort)
                )
                conn.commit()
                self.send_json({"success": True, "id": cur.lastrowid}, 201)
                return

            # Team POST /api/team/service-days
            if path == "/api/team/service-days":
                date = (body.get("date") or "").strip()
                open_flag = 1 if body.get("open") else 0
                order_limit = int(body.get("order_limit") or 50)
                allow_overflow = 1 if body.get("allow_overflow") else 0
                cutoff_time = (body.get("cutoff_time") or "").strip() or None
                note = (body.get("note") or "").strip() or None

                if not date: return self.send_error_json("Valid date (YYYY-MM-DD) is required")

                cur = conn.cursor()
                cur.execute("""
                    INSERT INTO service_days (date, open, order_limit, allow_overflow, cutoff_time, note)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date) DO UPDATE SET
                      open = excluded.open,
                      order_limit = excluded.order_limit,
                      allow_overflow = excluded.allow_overflow,
                      cutoff_time = excluded.cutoff_time,
                      note = excluded.note
                """, (date, open_flag, order_limit, allow_overflow, cutoff_time, note))
                conn.commit()
                self.send_json({"success": True, "date": date})
                return

            # Team POST /api/team/orders/batch - Batch status update
            if path == "/api/team/orders/batch":
                date = (body.get("date") or "").strip()
                target_status = body.get("target_status")
                from_status = body.get("from_status")
                valid_statuses = ['New', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled', 'Dunzo-ED']
                if target_status not in valid_statuses:
                    return self.send_error_json("Invalid target status")
                if not date:
                    return self.send_error_json("Date is required")

                cur = conn.cursor()
                if from_status and from_status in valid_statuses:
                    cur.execute("UPDATE orders SET status = ? WHERE service_date = ? AND status = ?", (target_status, date, from_status))
                else:
                    cur.execute("UPDATE orders SET status = ? WHERE service_date = ? AND status NOT IN ('Cancelled', 'Delivered')", (target_status, date))
                conn.commit()
                self.send_json({"success": True, "updated": cur.rowcount, "target_status": target_status})
                return

            # Team POST /api/team/orders (Manual order)
            if path == "/api/team/orders":
                customer_name = (body.get("customer_name") or "").strip()
                phone = (body.get("phone") or "").strip()
                address = (body.get("address") or "").strip()
                notes = (body.get("notes") or "").strip()
                service_date = (body.get("service_date") or "").strip()
                items = body.get("items") or []
                force_over_limit = 1 if body.get("over_limit") else 0

                if not customer_name: return self.send_error_json("Customer name is required")
                if not service_date: return self.send_error_json("Service date is required")
                if not items: return self.send_error_json("At least one item required")

                order_total = 0
                order_portions = 0
                order_items_to_insert = []

                for it in items:
                    qty = int(it.get("qty") or 0)
                    price = float(it.get("unit_price") or 0)
                    name = (it.get("item_name") or "Item").strip()
                    if qty <= 0: continue
                    order_total += price * qty
                    order_portions += qty
                    order_items_to_insert.append({
                        "item_id": it.get("item_id"),
                        "name": name,
                        "unit_price": price,
                        "qty": qty
                    })

                date_part = service_date.replace("-", "")
                import random
                order_no = f"DC-M{date_part}-{random.randint(1000, 9999)}"

                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO orders (order_no, service_date, customer_name, phone, address, notes, status, total, total_portions, over_limit, source) VALUES (?, ?, ?, ?, ?, ?, 'Confirmed', ?, ?, ?, 'manual')",
                    (order_no, service_date, customer_name, phone, address, notes, order_total, order_portions, force_over_limit)
                )
                order_id = cur.lastrowid
                for it in order_items_to_insert:
                    cur.execute(
                        "INSERT INTO order_items (order_id, item_id, item_name, unit_price, qty) VALUES (?, ?, ?, ?, ?)",
                        (order_id, it["item_id"], it["name"], it["unit_price"], it["qty"])
                    )
                conn.commit()
                self.send_json({"success": True, "id": order_id, "order_no": order_no}, 201)
                return

            # Team POST /api/team/tasks
            if path == "/api/team/tasks":
                title = (body.get("title") or "").strip()
                assignee = (body.get("assignee") or "").strip() or None
                due_date = (body.get("due_date") or "").strip() or None

                if not title: return self.send_error_json("Task title is required")

                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO tasks (title, assignee, due_date, status) VALUES (?, ?, ?, 'Pending')",
                    (title, assignee, due_date)
                )
                conn.commit()
                self.send_json({"success": True, "id": cur.lastrowid}, 201)
                return

            # Team POST /api/team/members
            if path == "/api/team/members":
                name = (body.get("name") or "").strip()
                if not name: return self.send_error_json("Name is required")

                cur = conn.cursor()
                cur.execute("INSERT OR IGNORE INTO team_members (name) VALUES (?)", (name,))
                conn.commit()
                self.send_json({"success": True, "id": cur.lastrowid})
                return

            # Team POST /api/team/expenses
            if path == "/api/team/expenses":
                date = (body.get("date") or "").strip()
                category = (body.get("category") or "other").strip()
                amount = float(body.get("amount") or 0)
                note = (body.get("note") or "").strip()

                if not date: return self.send_error_json("Date is required")
                if amount <= 0: return self.send_error_json("Amount must be greater than 0")

                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO expenses (date, category, amount, note) VALUES (?, ?, ?, ?)",
                    (date, category, amount, note)
                )
                conn.commit()
                self.send_json({"success": True, "id": cur.lastrowid}, 201)
                return

            # Team POST /api/team/income
            if path == "/api/team/income":
                date = (body.get("date") or "").strip()
                amount = float(body.get("amount") or 0)
                note = (body.get("note") or "").strip()

                if not date: return self.send_error_json("Date is required")
                if amount <= 0: return self.send_error_json("Amount must be greater than 0")

                cur = conn.cursor()
                cur.execute(
                    "INSERT INTO income_entries (date, amount, note) VALUES (?, ?, ?)",
                    (date, amount, note)
                )
                conn.commit()
                self.send_json({"success": True, "id": cur.lastrowid}, 201)
                return

            self.send_error_json(f"Not found: POST {path}", 404)
        finally:
            conn.close()

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.parse_body()

        if path.startswith("/api/team"):
            if self.headers.get("X-Team-Key") != TEAM_KEY:
                self.send_error_json("Unauthorized", 401)
                return

        conn = get_db()
        try:
            # PUT /api/team/menu/:id
            if path.startswith("/api/team/menu/"):
                item_id = int(path.split("/")[-1])
                name = (body.get("name") or "").strip()
                description = (body.get("description") or "").strip()
                price = float(body.get("price") or 0)
                image = body.get("image")
                available = 1 if body.get("available") else 0
                sort = int(body.get("sort") or 0)

                if not name: return self.send_error_json("Name is required")
                if price <= 0: return self.send_error_json("Price must be greater than 0")

                cur = conn.cursor()
                if image is not None:
                    cur.execute(
                        "UPDATE menu_items SET name = ?, description = ?, price = ?, image = ?, available = ?, sort = ? WHERE id = ?",
                        (name, description, price, image, available, sort, item_id)
                    )
                else:
                    cur.execute(
                        "UPDATE menu_items SET name = ?, description = ?, price = ?, available = ?, sort = ? WHERE id = ?",
                        (name, description, price, available, sort, item_id)
                    )
                conn.commit()
                self.send_json({"success": True})
                return

            # PUT /api/team/settings
            if path == "/api/team/settings":
                cur = conn.cursor()
                for key in ["brand_name", "whatsapp_number", "payment_note", "whatsapp_template"]:
                    if key in body:
                        cur.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(body[key])))
                conn.commit()
                self.send_json({"success": True})
                return

            self.send_error_json(f"Not found: PUT {path}", 404)
        finally:
            conn.close()

    def do_PATCH(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.parse_body()

        if path.startswith("/api/team"):
            if self.headers.get("X-Team-Key") != TEAM_KEY:
                self.send_error_json("Unauthorized", 401)
                return

        conn = get_db()
        try:
            # PATCH /api/team/orders/:id
            if path.startswith("/api/team/orders/"):
                order_id = int(path.split("/")[-1])

                if body.get("toggle_payment"):
                    cur = conn.cursor()
                    cur.execute("SELECT notes FROM orders WHERE id = ?", (order_id,))
                    row = cur.fetchone()
                    current_notes = (row["notes"] if row and row["notes"] else "")
                    if "[PAID]" in current_notes:
                        new_notes = current_notes.replace("[PAID]", "").strip()
                    else:
                        new_notes = ("[PAID] " + current_notes).strip()
                    cur.execute("UPDATE orders SET notes = ? WHERE id = ?", (new_notes, order_id))
                    conn.commit()
                    is_paid = "[PAID]" in new_notes
                    self.send_json({"success": True, "id": order_id, "is_paid": is_paid})
                    return

                status = body.get("status")
                valid_statuses = ['New', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled', 'Dunzo-ED']
                if status not in valid_statuses:
                    return self.send_error_json(f"Invalid status: {status}")

                cur = conn.cursor()
                cur.execute("UPDATE orders SET status = ? WHERE id = ?", (status, order_id))
                conn.commit()
                self.send_json({"success": True, "id": order_id, "status": status})
                return

            # PATCH /api/team/tasks/:id
            if path.startswith("/api/team/tasks/"):
                task_id = int(path.split("/")[-1])
                status = "Done" if body.get("status") == "Done" else "Pending"
                completed_at = datetime.datetime.now().isoformat() if status == "Done" else None

                cur = conn.cursor()
                cur.execute("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?", (status, completed_at, task_id))
                conn.commit()
                self.send_json({"success": True, "id": task_id, "status": status})
                return

            self.send_error_json(f"Not found: PATCH {path}", 404)
        finally:
            conn.close()

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/team"):
            if self.headers.get("X-Team-Key") != TEAM_KEY:
                self.send_error_json("Unauthorized", 401)
                return

        conn = get_db()
        try:
            # DELETE /api/team/menu/:id
            if path.startswith("/api/team/menu/"):
                item_id = int(path.split("/")[-1])
                cur = conn.cursor()
                cur.execute("DELETE FROM menu_items WHERE id = ?", (item_id,))
                conn.commit()
                self.send_json({"success": True})
                return

            # DELETE /api/team/tasks/:id
            if path.startswith("/api/team/tasks/"):
                task_id = int(path.split("/")[-1])
                cur = conn.cursor()
                cur.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
                conn.commit()
                self.send_json({"success": True})
                return

            # DELETE /api/team/members/:id
            if path.startswith("/api/team/members/"):
                member_id = int(path.split("/")[-1])
                cur = conn.cursor()
                cur.execute("DELETE FROM team_members WHERE id = ?", (member_id,))
                conn.commit()
                self.send_json({"success": True})
                return

            # DELETE /api/team/expenses/:id
            if path.startswith("/api/team/expenses/"):
                expense_id = int(path.split("/")[-1])
                cur = conn.cursor()
                cur.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
                conn.commit()
                self.send_json({"success": True})
                return

            # DELETE /api/team/income/:id
            if path.startswith("/api/team/income/"):
                income_id = int(path.split("/")[-1])
                cur = conn.cursor()
                cur.execute("DELETE FROM income_entries WHERE id = ?", (income_id,))
                conn.commit()
                self.send_json({"success": True})
                return

            self.send_error_json(f"Not found: DELETE {path}", 404)
        finally:
            conn.close()

    def serve_file(self, filepath, content_type, extra_headers=None):
        if not os.path.exists(filepath):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return
        with open(filepath, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_cors_headers()
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

def main():
    init_db()
    server = HTTPServer(("127.0.0.1", PORT), DumCraftHandler)
    print(f"DumCraft Local Dev Server running at http://127.0.0.1:{PORT}")
    print(f"Customer URL: http://127.0.0.1:{PORT}/")
    print(f"Team URL:     http://127.0.0.1:{PORT}/team/{TEAM_KEY}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
