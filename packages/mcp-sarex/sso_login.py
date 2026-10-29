#!/usr/bin/env python3
"""Interactive Sarex SSO login with 2FA (phone approval), via Microsoft Edge + Playwright.

What it does:
  1. opens Keycloak login page in Edge (persistent profile),
  2. fills login/password from _secrets/credentials.json,
  3. waits while you approve the sign-in on your phone (2FA push), up to --timeout seconds,
  4. saves the authenticated session cookies to _mcp/sarex/session.json,
  5. tries to exchange the OAuth code for tokens (best effort).

Usage:
  python sso_login.py [--timeout 300] [--dry-run]

Exit codes: 0 ok, 2 phone approval timeout, 3 browser/automation error.
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("AMN_PROJECT") or os.path.abspath(os.path.join(HERE, "..", ".."))
CRED_FILE = os.path.join(PROJECT, "_secrets", "credentials.json")
SESSION_FILE = os.path.join(HERE, "session.json")
TOKENS_FILE = os.path.join(HERE, "tokens.json")
PROFILE_DIR = os.path.join(HERE, "browser-profile")

AUTH_URL = ("https://keycloak.sarex.dsinv.ru/realms/sarex/protocol/openid-connect/auth?"
            "access_type=online&client_id=sarex-client&redirect_uri="
            + urllib.parse.quote("https://sarex.dsinv.ru/oauth/callback", safe="")
            + "&response_type=code&scope=email+profile+openid&state=mcp-sso")
TOKEN_URL = "https://keycloak.sarex.dsinv.ru/realms/sarex/protocol/openid-connect/token"
_ctx = ssl.create_default_context()


def log(msg):
    print("[sso] %s" % msg, flush=True)


def load_creds():
    with open(CRED_FILE, "r", encoding="utf-8") as f:
        return json.load(f)["sarex"]


def exchange_code(code, redirect_uri):
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code", "client_id": "sarex-client",
        "code": code, "redirect_uri": redirect_uri,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=25, context=_ctx) as resp:
            payload = json.loads(resp.read())
        with open(TOKENS_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        return True, payload.get("expires_in")
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    creds = load_creds()
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        log("Playwright is not available: %s" % e)
        return 3

    with sync_playwright() as p:
        try:
            ctx = p.chromium.launch_persistent_context(
                PROFILE_DIR, channel="msedge", headless=False,
                args=["--start-maximized"], no_viewport=True)
        except Exception as e:
            log("cannot launch Edge: %s" % e)
            return 3
        page = ctx.new_page()
        log("opening %s" % AUTH_URL)
        page.goto(AUTH_URL, wait_until="domcontentloaded", timeout=60000)
        try:
            page.wait_for_selector("#username", timeout=30000)
            page.fill("#username", creds["login"])
            page.click("#kc-login")
            page.wait_for_selector("#password", timeout=30000)
            page.fill("#password", creds["password"])
            page.click("#kc-login")
            log("login submitted; waiting for phone approval (2FA push) ...")
        except Exception as e:
            log("login form automation failed: %s" % e)
            if args.dry_run:
                ctx.close()
                return 3

        if args.dry_run:
            time.sleep(5)
            log("dry-run done; page url=%s" % page.url)
            ctx.close()
            return 0

        deadline = time.time() + args.timeout
        code = None
        while time.time() < deadline:
            url = page.url
            if "/oauth/callback" in url:
                q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                code = (q.get("code") or [None])[0]
                log("callback received; code=%s" % ("yes" if code else "no"))
                break
            time.sleep(2)
        else:
            log("timeout waiting for phone approval (2FA)")
            ctx.close()
            return 2

        # save session (cookies + localStorage)
        state = ctx.storage_state()
        with open(SESSION_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        log("session saved: %s" % SESSION_FILE)
        ctx.close()

    if code:
        ok, info = exchange_code(code, "https://sarex.dsinv.ru/oauth/callback")
        log("code exchange: %s (%s)" % ("ok" if ok else "failed", info))
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
