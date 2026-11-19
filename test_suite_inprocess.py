#!/usr/bin/env python3
"""
Direct In-Process Test Suite for DumCraft API
Executes HTTP handler logic directly without needing TCP sockets (sandbox friendly).
"""

import os
import sys
import io
import json
from dev_server import DumCraftHandler, init_db, DB_FILE

class MockSocket:
    def __init__(self, request_bytes):
        self.rfile = io.BytesIO(request_bytes)
        self.output_buffer = io.BytesIO()

    def makefile(self, mode, *args, **kwargs):
        if "r" in mode:
            return self.rfile
        elif "w" in mode or "b" in mode:
            return self.output_buffer

    def sendall(self, data):
        self.output_buffer.write(data)

    def send(self, data):
        self.output_buffer.write(data)
        return len(data)

    def close(self):
        pass

def execute_request(method, path, body=None, headers=None):
    h = headers or {}
    body_bytes = b""
    if body is not None:
        body_bytes = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
        h["Content-Length"] = str(len(body_bytes))

    request_lines = [f"{method} {path} HTTP/1.1"]
    for k, v in h.items():
        request_lines.append(f"{k}: {v}")
    request_lines.append("\r\n")

    raw_request = "\r\n".join(request_lines).encode("utf-8") + body_bytes
    mock_sock = MockSocket(raw_request)

    handler = DumCraftHandler(mock_sock, ("127.0.0.1", 12345), None)
    response_bytes = mock_sock.output_buffer.getvalue()

    # Parse HTTP response
    header_part, _, body_part = response_bytes.partition(b"\r\n\r\n")
    lines = header_part.decode("utf-8").split("\r\n")
    status_line = lines[0]
    status_code = int(status_line.split(" ")[1])

    res_json = None
    if body_part:
        try:
            res_json = json.loads(body_part.decode("utf-8"))
        except Exception:
            res_json = body_part.decode("utf-8")

    return status_code, res_json

def run_in_process_tests():
    # Clean DB for fresh test run
    if os.path.exists(DB_FILE):
        os.remove(DB_FILE)
    init_db()

    print("=== DumCraft In-Process API Test Suite ===")
    TEAM_KEY = "dc_secret_team_demo2026"

    # 1. Public Settings
    status, data = execute_request("GET", "/api/settings")
    assert status == 200, f"Expected 200, got {status}: {data}"
    assert data.get("brand_name") == "DumCraft", "Brand name mismatch"
    print("✓ Public settings API passed")

    # 2. Public Menu
    status, data = execute_request("GET", "/api/menu")
    assert status == 200
    assert len(data) >= 1
    assert "Chicken Biryani" in data[0]["name"]
    first_item_id = data[0]["id"]
    print(f"✓ Public menu API passed ({len(data)} items found)")

    # 3. Security: Team endpoint without key -> 401
    status, data = execute_request("GET", "/api/team/verify")
    assert status == 401, f"Expected 401 unauthorized, got {status}"
    print("✓ Security: Team endpoints reject unauthorized requests with 401")

    # 4. Security: Team endpoint with valid key -> 200
    status, data = execute_request("GET", "/api/team/verify", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and data.get("valid") is True
    print("✓ Security: Team key authorization verified")

    # 5. Team Menu CRUD
    new_item = {
        "name": "Double Ka Meetha",
        "description": "Traditional Hyderabadi bread pudding dessert",
        "price": 80,
        "available": True,
        "sort": 2
    }
    status, data = execute_request("POST", "/api/team/menu", body=new_item, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    item_id = data["id"]
    print(f"✓ Team menu: Item added (id={item_id})")

    # Edit item
    status, data = execute_request("PUT", f"/api/team/menu/{item_id}", body={"name": "Shahi Double Ka Meetha", "price": 90, "available": True, "sort": 2}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    print("✓ Team menu: Item edited")

    # 6. Service Calendar & Limits
    test_date = "2026-11-25"
    cal_data = {
        "date": test_date,
        "open": True,
        "order_limit": 2, # Small limit for testing
        "allow_overflow": False,
        "cutoff_time": "22:00",
        "note": "Dinner Service Only"
    }
    status, data = execute_request("POST", "/api/team/service-days", body=cal_data, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    print("✓ Service calendar: Day configured with limit = 2 portions")

    # 7. Customer Order Validations
    # Invalid Phone
    status, data = execute_request("POST", "/api/orders", body={
        "customer_name": "Test User",
        "phone": "12345",
        "address": "Banjara Hills",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 400 and "valid 10-digit" in data.get("error", "")
    print("✓ Validation: Invalid phone number rejected")

    # Honeypot field
    status, data = execute_request("POST", "/api/orders", body={
        "customer_name": "Bot User",
        "phone": "9876543210",
        "address": "Nowhere",
        "service_date": test_date,
        "website_hp": "http://spam.com",
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 400
    print("✓ Validation: Honeypot blocked bot order")

    # Order 1 (Portion = 1) -> Accepted
    status, o1 = execute_request("POST", "/api/orders", body={
        "customer_name": "Aswin Kumar",
        "phone": "9876543210",
        "address": "Flat 401, Banjara Heights",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 201
    assert o1["total_portions"] == 1
    assert o1["over_limit"] is False
    print(f"✓ Order 1 placed: {o1['order_no']} (portions=1/2)")

    # Order 2 (Portion = 1) -> Accepted (Hits limit 2/2)
    status, o2 = execute_request("POST", "/api/orders", body={
        "customer_name": "Rahul Sharma",
        "phone": "9848022338",
        "address": "Jubilee Hills, Road 36",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 201
    assert o2["over_limit"] is False
    print(f"✓ Order 2 placed: {o2['order_no']} (portions=2/2, limit reached)")

    # Order 3 (Portion = 1) -> Sold Out!
    status, o3 = execute_request("POST", "/api/orders", body={
        "customer_name": "Priya Nair",
        "phone": "9988776655",
        "address": "Madhapur, Cyber Towers",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 400
    assert "Sold out" in o3.get("error", "")
    print("✓ Atomic Limit Check: Order rejected when sold out")

    # Enable Overflow
    cal_data["allow_overflow"] = True
    status, data = execute_request("POST", "/api/team/service-days", body=cal_data, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200

    # Order 4 (Portion = 1) with overflow -> Accepted with over_limit = True
    status, o4 = execute_request("POST", "/api/orders", body={
        "customer_name": "Priya Nair",
        "phone": "9988776655",
        "address": "Madhapur, Cyber Towers",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 201
    assert o4["over_limit"] is True
    print(f"✓ Overflow Logic: Order accepted and flagged over_limit=True ({o4['order_no']})")

    # 8. Team Orders Dashboard & Chef Prep Totals
    status, dash = execute_request("GET", f"/api/team/orders?date={test_date}", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    summary = dash["summary"]
    assert summary["total_portions_to_cook"] == 3
    assert summary["total_active_orders"] == 3
    print(f"✓ Chef Dashboard: Correct total portions to cook ({summary['total_portions_to_cook']})")

    # Status Update
    first_order_id = dash["orders"][-1]["id"]
    status, patch_res = execute_request("PATCH", f"/api/team/orders/{first_order_id}", body={"status": "Confirmed"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and patch_res["status"] == "Confirmed"
    print("✓ Order status updated: New -> Confirmed")

    # 9. Tasks
    status, task_res = execute_request("POST", "/api/team/tasks", body={"title": "Buy fresh basmati rice & ghee", "assignee": "Chef", "due_date": test_date}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    task_id = task_res["id"]
    status, task_patch = execute_request("PATCH", f"/api/team/tasks/{task_id}", body={"status": "Done"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and task_patch["status"] == "Done"
    print("✓ Tasks management: Created, assigned, and completed task")

    # 10. Finances
    status, exp_res = execute_request("POST", "/api/team/expenses", body={"date": test_date, "category": "ingredients", "amount": 450, "note": "Chicken & spices"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    status, fin_res = execute_request("GET", "/api/team/finances", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    assert fin_res["total_expenses"] >= 450
    assert fin_res["confirmed_income"] > 0
    print(f"✓ Finances: Confirmed Income ₹{fin_res['confirmed_income']}, Expenses ₹{fin_res['total_expenses']}, Profit ₹{fin_res['profit']}")

    # 11. Customer Feedback & Review System
    # Lookup order for feedback
    order_no_to_review = o1["order_no"]
    status, fb_lookup = execute_request("GET", f"/api/feedback/order?order_no={order_no_to_review}")
    assert status == 200, f"Expected 200, got {status}: {fb_lookup}"
    assert fb_lookup["order"]["order_no"] == order_no_to_review
    assert fb_lookup["feedback"] is None, "Expected no initial feedback"
    print(f"✓ Feedback: Pre-filled order details loaded ({fb_lookup['order']['customer_name']})")

    # Submit review (Biryani: 5, Accompaniments: 4, Packaging: 5)
    status, fb_submit = execute_request("POST", "/api/feedback", body={
        "order_no": order_no_to_review,
        "rating_biryani": 5,
        "rating_accompaniments": 4,
        "rating_packaging": 5,
        "comments": "Super aromatic and succulent chicken! Salan was delicious."
    })
    assert status == 200 and fb_submit["success"] is True
    print("✓ Feedback: Rating and comments submitted successfully")

    # Verify review in team feedback endpoint
    status, team_fb = execute_request("GET", "/api/team/feedback", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    assert team_fb["summary"]["total_reviews"] == 1
    assert team_fb["summary"]["avg_biryani"] == "5.0"
    assert team_fb["summary"]["avg_accompaniments"] == "4.0"
    assert team_fb["summary"]["avg_packaging"] == "5.0"
    assert len(team_fb["reviews"]) == 1
    assert team_fb["reviews"][0]["order_no"] == order_no_to_review
    print(f"✓ Team Feedback Hub: Overall {team_fb['summary']['overall_avg']}/5 (Biryani: {team_fb['summary']['avg_biryani']}, Salan: {team_fb['summary']['avg_accompaniments']}, Packaging: {team_fb['summary']['avg_packaging']})")

    # Verify review is attached directly to order card in team orders
    status, dash_with_fb = execute_request("GET", f"/api/team/orders?date={test_date}", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    reviewed_order = [o for o in dash_with_fb["orders"] if o["order_no"] == order_no_to_review][0]
    assert reviewed_order.get("feedback") is not None
    assert reviewed_order["feedback"]["rating_biryani"] == 5
    print(f"✓ Order Card Integration: Customer review attached directly to {order_no_to_review}")

    print("\n🎉 ALL 11 IN-PROCESS TEST SUITES PASSED FLAWLESSLY!")

if __name__ == "__main__":
    run_in_process_tests()
