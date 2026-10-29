#!/usr/bin/env python3
"""MCP server for Sarex (sarex.dsinv.ru).

Transport: stdio JSON-RPC 2.0 (MCP 2024-11-05 protocol).
Auth: Keycloak password grant (realm "sarex", public client "admin-cli").
Credentials: <project>\\_secrets\\credentials.json -> sarex.url/login/password.

Tools:
  sarex_status        - authentication/token status
  sarex_notifications - list notifications (GET /api/notifications)
  sarex_request       - authenticated HTTP request to Sarex API (/api/*)
"""
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER_NAME = "sarex-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("AMN_PROJECT") or os.path.abspath(os.path.join(HERE, "..", ".."))
CRED_FILE = os.path.join(PROJECT, "_secrets", "credentials.json")
LOG_FILE = os.path.join(HERE, "server.log")

_ctx = ssl.create_default_context()
_token = {"value": None, "expires_at": 0.0, "user": None}


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


def load_creds():
    with open(CRED_FILE, "r", encoding="utf-8") as f:
        return json.load(f)["sarex"]


def token_request(creds):
    url = "https://keycloak.sarex.dsinv.ru/realms/sarex/protocol/openid-connect/token"
    data = urllib.parse.urlencode({
        "grant_type": "password",
        "client_id": "admin-cli",
        "username": creds["login"],
        "password": creds["password"],
    }).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=25, context=_ctx) as resp:
        payload = json.loads(resp.read())
    _token["value"] = payload["access_token"]
    _token["expires_at"] = time.time() + int(payload.get("expires_in", 300)) - 30
    _token["user"] = creds.get("login")
    log("token refreshed for %s" % _token["user"])
    return _token["value"]


def get_token(force=False):
    if force or not _token["value"] or time.time() >= _token["expires_at"]:
        return token_request(load_creds())
    return _token["value"]


def http_call(method, path, query=None, body=None):
    creds = load_creds()
    base = creds.get("url", "https://sarex.dsinv.ru").rstrip("/")
    if not path.startswith("/api/"):
        raise ValueError("Only /api/* paths are allowed")
    url = base + path
    if query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(query)
    data = None
    headers = {"User-Agent": "sarex-mcp/1.0", "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    for attempt in range(2):
        headers["Authorization"] = "Bearer " + get_token(force=(attempt > 0))
        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=40, context=_ctx) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if "json" in ctype:
                    return {"status": resp.status, "json": json.loads(raw or b"null")}
                return {"status": resp.status, "content_type": ctype, "bytes": len(raw),
                        "text_head": raw[:2000].decode("utf-8", "replace")}
        except urllib.error.HTTPError as e:
            raw = e.read()
            if e.code == 401 and attempt == 0:
                continue
            cookie_result = _try_cookie_call(method, url, data, headers)
            if cookie_result is not None:
                return cookie_result
            try:
                parsed = json.loads(raw or b"null")
            except Exception:
                parsed = raw[:2000].decode("utf-8", "replace")
            return {"status": e.code, "error": parsed}
    raise RuntimeError("unreachable")


def _try_cookie_call(method, url, data, headers):
    """Fallback for endpoints that accept the SSO browser session instead of Bearer token."""
    session_file = os.path.join(HERE, "session.json")
    if not os.path.isfile(session_file):
        return None
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            state = json.load(f)
        cookies = "; ".join("%s=%s" % (c.get("name"), c.get("value")) for c in state.get("cookies", []))
        if not cookies:
            return None
        h = dict(headers)
        h.pop("Authorization", None)
        h["Cookie"] = cookies
        req = urllib.request.Request(url, data=data, headers=h, method=method.upper())
        with urllib.request.urlopen(req, timeout=40, context=_ctx) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "json" in ctype:
                return {"status": resp.status, "json": json.loads(raw or b"null"), "auth": "sso-cookie"}
            return {"status": resp.status, "content_type": ctype, "bytes": len(raw),
                    "text_head": raw[:2000].decode("utf-8", "replace"), "auth": "sso-cookie"}
    except Exception:
        return None


TOOLS = [
    {
        "name": "sarex_status",
        "description": "Show Sarex authentication status (Keycloak token, user, API base URL).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "sarex_notifications",
        "description": "List Sarex notifications for the authenticated user (GET /api/notifications).",
        "inputSchema": {"type": "object", "properties": {
            "page": {"type": "integer", "description": "page number (optional)"},
            "page_size": {"type": "integer", "description": "page size (optional)"},
        }, "additionalProperties": False},
    },
    {
        "name": "sarex_sso_login",
        "description": "Interactive SSO login with 2FA: opens Edge via Playwright, fills credentials, waits for phone approval, saves session cookies. Use when token auth is not enough.",
        "inputSchema": {"type": "object", "properties": {
            "timeout_sec": {"type": "integer", "description": "seconds to wait for phone approval (default 300)"}
        }, "additionalProperties": False},
    },
    {
        "name": "sarex_session",
        "description": "Show saved SSO session status (cookies saved, tokens saved, age).",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "sarex_request",
        "description": "Authenticated HTTP request to the Sarex API. Path must start with /api/. Reads are safe; writes require confirm=true.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]},
                "path": {"type": "string", "description": "API path starting with /api/, e.g. /api/notifications"},
                "query": {"type": "object", "additionalProperties": {"type": "string"}},
                "body": {"type": "object", "description": "JSON body for POST/PUT/PATCH"},
                "confirm": {"type": "boolean", "description": "required true for non-GET requests"},
            },
            "required": ["method", "path"],
            "additionalProperties": False,
        },
    },
]


def call_tool(name, args):
    if name == "sarex_sso_login":
        timeout = int(args.get("timeout_sec") or 300)
        script = os.path.join(HERE, "sso_login.py")
        try:
            proc = subprocess.run([sys.executable, script, "--timeout", str(timeout)],
                                  capture_output=True, text=True, timeout=timeout + 60)
            return {"exit": proc.returncode,
                    "output": (proc.stdout or "")[-4000:],
                    "stderr": (proc.stderr or "")[-2000:]}
        except subprocess.TimeoutExpired:
            return {"error": "sso script timed out"}
        except Exception as e:
            return {"error": "%s: %s" % (type(e).__name__, e)}
    if name == "sarex_session":
        sf = os.path.join(HERE, "session.json")
        tf = os.path.join(HERE, "tokens.json")
        info = {"session_file": sf, "session_saved": os.path.isfile(sf),
                "tokens_saved": os.path.isfile(tf)}
        for path, key in ((sf, "session_age_min"), (tf, "tokens_age_min")):
            if os.path.isfile(path):
                info[key] = int((time.time() - os.path.getmtime(path)) / 60)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if "cookies" in data:
                        info["cookies"] = len(data.get("cookies") or [])
                    if "access_token" in data:
                        info["token_expires_in"] = data.get("expires_in")
                except Exception:
                    pass
        return info
    if name == "sarex_status":
        try:
            get_token()
            creds = load_creds()
            return {"ok": True, "user": _token["user"], "base_url": creds.get("url"),
                    "token_cached": True, "expires_in_sec": max(0, int(_token["expires_at"] - time.time())),
                    "auth": "Keycloak password grant (client admin-cli, realm sarex)"}
        except Exception as e:
            return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    if name == "sarex_notifications":
        q = {}
        if args.get("page"):
            q["page"] = str(args["page"])
        if args.get("page_size"):
            q["page_size"] = str(args["page_size"])
        return http_call("GET", "/api/notifications", q or None)
    if name == "sarex_request":
        method = (args.get("method") or "GET").upper()
        path = args.get("path") or ""
        if method != "GET" and not args.get("confirm"):
            return {"error": "write request requires confirm=true"}
        return http_call(method, path, args.get("query"), args.get("body"))
    return {"error": "unknown tool: %s" % name}


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = {"code": -32000, "message": str(error)}
    else:
        out["result"] = result
    send(out)


try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    log("server started, project=%s" % PROJECT)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        if msg_id is None:
            continue  # notification
        try:
            if method == "initialize":
                reply(msg_id, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                })
            elif method == "tools/list":
                reply(msg_id, {"tools": TOOLS})
            elif method == "tools/call":
                params = msg.get("params") or {}
                result = call_tool(params.get("name"), params.get("arguments") or {})
                reply(msg_id, {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                               "isError": False})
            elif method == "ping":
                reply(msg_id, {})
            else:
                reply(msg_id, error="unknown method: %s" % method)
        except Exception as e:
            log("error: %s: %s" % (type(e).__name__, e))
            reply(msg_id, error="%s: %s" % (type(e).__name__, e))


if __name__ == "__main__":
    main()
