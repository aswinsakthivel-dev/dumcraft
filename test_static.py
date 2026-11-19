#!/usr/bin/env python3
"""
Test static file serving and HTML/JS files integrity
"""

import os
from test_suite_inprocess import execute_request

def test_static_files():
    print("Testing static file endpoints...")

    # 1. Customer page: GET /
    status, body = execute_request("GET", "/")
    assert status == 200, f"Failed GET /: {status}"
    assert "DumCraft" in body, "DumCraft brand missing in index.html"
    print("✓ GET / (index.html) served successfully")

    # 2. Team page: GET /team/dc_secret_team_demo2026
    status, body = execute_request("GET", "/team/dc_secret_team_demo2026")
    assert status == 200, f"Failed GET /team/...: {status}"
    assert "DumCraft Team" in body, "DumCraft Team brand missing in team.html"
    print("✓ GET /team/<key> (team.html) served successfully")

    # 3. CSS: GET /style.css
    status, body = execute_request("GET", "/style.css")
    assert status == 200, f"Failed GET /style.css: {status}"
    assert "--primary" in body, "CSS content missing"
    print("✓ GET /style.css served successfully")

    # 4. JS: GET /team.js
    status, body = execute_request("GET", "/team.js")
    assert status == 200, f"Failed GET /team.js: {status}"
    assert "initTeam" in body, "JS content missing"
    print("✓ GET /team.js served successfully")

    print("\n🎉 ALL STATIC FILES VERIFIED!")

if __name__ == "__main__":
    test_static_files()
