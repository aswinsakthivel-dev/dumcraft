-- DumCraft D1 SQLite Schema

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  image TEXT, -- Base64 or URL
  available INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_days (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD
  open INTEGER NOT NULL DEFAULT 1,
  order_limit INTEGER NOT NULL DEFAULT 50, -- max total portions
  allow_overflow INTEGER NOT NULL DEFAULT 0,
  cutoff_time TEXT, -- e.g. "14:00"
  note TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  service_date TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'New', -- 'New', 'Confirmed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'
  total REAL NOT NULL,
  total_portions INTEGER NOT NULL DEFAULT 0,
  over_limit INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web', -- 'web' or 'manual'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (service_date) REFERENCES service_days(date)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  item_id INTEGER,
  item_name TEXT NOT NULL,
  unit_price REAL NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  assignee TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', -- 'Pending', 'Done'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL, -- 'ingredients', 'packaging', 'gas', 'delivery', 'other', or custom
  amount REAL NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS income_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_service_date ON orders(service_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_feedback_order_no ON order_feedback(order_no);
CREATE INDEX IF NOT EXISTS idx_order_feedback_created_at ON order_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_income_date ON income_entries(date);

-- Seed Data
INSERT OR IGNORE INTO menu_items (id, name, description, price, available, sort)
VALUES (1, 'Hyderabadi Chicken Biryani, with Mirchi ka Salan & Salad', 'Authentic dum cooked Hyderabadi chicken biryani served with spicy Mirchi ka Salan and fresh onion raita/salad.', 280, 1, 1);

INSERT OR IGNORE INTO team_members (id, name) VALUES (1, 'Chef');
INSERT OR IGNORE INTO team_members (id, name) VALUES (2, 'Kitchen Helper');
INSERT OR IGNORE INTO team_members (id, name) VALUES (3, 'Delivery');

INSERT OR IGNORE INTO settings (key, value) VALUES ('brand_name', 'DumCraft');
INSERT OR IGNORE INTO settings (key, value) VALUES ('whatsapp_number', '919876543210');
INSERT OR IGNORE INTO settings (key, value) VALUES ('payment_note', 'Payment: Cash on Delivery or UPI on delivery. We will contact you on WhatsApp with order confirmation and payment details.');
INSERT OR IGNORE INTO settings (key, value) VALUES ('whatsapp_feedback_template', 'Hi {name}, thank you for ordering with DumCraft today! 🍗✨

We hope you enjoyed your Biryani! We''d love 30 seconds of your feedback so Chef and team can make your next meal even better:
👉 {feedback_url}

Thank you,
Team DumCraft');
