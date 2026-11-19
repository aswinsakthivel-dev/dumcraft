#!/usr/bin/env python3
"""
Comprehensive automated tests for DumCraft backend API
"""

import sys
import os
import json
import urllib.request
import urllib.error

BASE_URL = "http://127.0.0.1:8787"
TEAM_KEY = "dc_secret_team_demo2026"

def req(path, method="GET", data=None, headers=None):
    url = f"{BASE_URL}{path}"
    h = headers or {}
    h.setdefault("Content-Type", "application/json")
    body = json.dumps(data).encode("utf-8") if data is not None else None
    request = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(request) as response:
            res_body = response.read().decode("utf-8")
            return response.status, json.loads(res_body) if res_body else {}
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8")
        try:
            return e.code, json.loads(err_body)
        except Exception:
            return e.code, {"error": err_body}

def run_tests():
    print("=== DumCraft API Test Suite ===")

    # 1. Public Settings
    status, data = req("/api/settings")
    assert status == 200, f"Expected 200, got {status}"
    assert data.get("brand_name") == "DumCraft", "Brand name mismatch"
    print("✓ Public settings API passed")

    # 2. Public Menu
    status, data = req("/api/menu")
    assert status == 200
    assert len(data) >= 1
    assert "Chicken Biryani" in data[0]["name"]
    first_item_id = data[0]["id"]
    print(f"✓ Public menu API passed ({len(data)} items found)")

    # 3. Security: Team endpoint without key -> 401
    status, data = req("/api/team/verify")
    assert status == 401, f"Expected 401 unauthorized, got {status}"
    print("✓ Security: Team endpoints reject unauthorized requests with 401")

    # 4. Security: Team endpoint with valid key -> 200
    status, data = req("/api/team/verify", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and data.get("valid") is True
    print("✓ Security: Team key authorization verified")

    # 5. Team Menu CRUD
    # Add new item
    new_item = {
        "name": "Double Ka Meetha",
        "description": "Traditional Hyderabadi bread pudding dessert",
        "price": 80,
        "available": True,
        "sort": 2
    }
    status, data = req("/api/team/menu", method="POST", data=new_item, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    item_id = data["id"]
    print(f"✓ Team menu: Item added (id={item_id})")

    # Edit item
    status, data = req(f"/api/team/menu/{item_id}", method="PUT", data={"name": "Shahi Double Ka Meetha", "price": 90, "available": True, "sort": 2}, headers={"X-Team-Key": TEAM_KEY})
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
    status, data = req("/api/team/service-days", method="POST", data=cal_data, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    print("✓ Service calendar: Day configured with limit = 2 portions")

    # 7. Customer Order Validations
    # Invalid Phone
    status, data = req("/api/orders", method="POST", data={
        "customer_name": "Test User",
        "phone": "12345",
        "address": "Banjara Hills",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 400 and "valid 10-digit" in data.get("error", "")
    print("✓ Validation: Invalid phone number rejected")

    # Honeypot field
    status, data = req("/api/orders", method="POST", data={
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
    status, o1 = req("/api/orders", method="POST", data={
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
    status, o2 = req("/api/orders", method="POST", data={
        "customer_name": "Rahul Sharma",
        "phone": "9848022338",
        "address": "Jubilee Hills, Road 36",
        "service_date": test_date,
        "items": [{"item_id": first_item_id, "qty": 1}]
    })
    assert status == 201
    assert o2["over_limit"] is False
    print(f"✓ Order 2 placed: {o2['order_no']} (portions=2/2, sold out reached)")

    # Order 3 (Portion = 1) -> Sold Out!
    status, o3 = req("/api/orders", method="POST", data={
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
    status, data = req("/api/team/service-days", method="POST", data=cal_data, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200

    # Order 4 (Portion = 1) with overflow -> Accepted with over_limit = True
    status, o4 = req("/api/orders", method="POST", data={
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
    status, dash = req(f"/api/team/orders?date={test_date}", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    summary = dash["summary"]
    assert summary["total_portions_to_cook"] == 3
    assert summary["total_active_orders"] == 3
    print(f"✓ Chef Dashboard: Correct total portions to cook ({summary['total_portions_to_cook']})")

    # Status Update
    first_order_id = dash["orders"][-1]["id"]
    status, patch_res = req(f"/api/team/orders/{first_order_id}", method="PATCH", data={"status": "Confirmed"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and patch_res["status"] == "Confirmed"
    print("✓ Order status updated: New -> Confirmed")

    # 9. Tasks
    status, task_res = req("/api/team/tasks", method="POST", data={"title": "Buy fresh basmati rice & ghee", "assignee": "Chef", "due_date": test_date}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    task_id = task_res["id"]
    status, task_patch = req(f"/api/team/tasks/{task_id}", method="PATCH", data={"status": "Done"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 200 and task_patch["status"] == "Done"
    print("✓ Tasks management: Created, assigned, and completed task")

    # 10. Finances
    status, exp_res = req("/api/team/expenses", method="POST", data={"date": test_date, "category": "ingredients", "amount": 450, "note": "Chicken & spices"}, headers={"X-Team-Key": TEAM_KEY})
    assert status == 201
    status, fin_res = req("/api/team/finances", headers={"X-Team-Key": TEAM_KEY})
    assert status == 200
    assert fin_res["total_expenses"] >= 450
    assert fin_res["confirmed_income"] > 0
    print(f"✓ Finances: Confirmed Income ₹{fin_res['confirmed_income']}, Expenses ₹{fin_res['total_expenses']}, Profit ₹{fin_res['profit']}")

    print("\n🎉 ALL 10 TEST SUITES PASSED FLAWLESSLY!")

if __name__ == "__main__":
    run_tests()
