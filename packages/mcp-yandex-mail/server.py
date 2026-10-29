#!/usr/bin/env python3
"""MCP server for Yandex Mail (amn.control.info@yandex.ru).

Transport: stdio JSON-RPC 2.0 (MCP 2024-11-05).
Auth: app password from <project>\\_secrets\\credentials.json -> mail.account/mail.password.

Tools:
  mail_status      - connection status, message/unread counters
  mail_folders     - list IMAP folders
  mail_search      - fast header search (from/subject/since/before/text/unseen)
  mail_get         - fetch one message by UID (headers, text body, attachments list)
  mail_unread      - unread count for folder
  mail_mark_read   - mark message(s) as read (confirm=true)
  mail_send        - send a message via SMTP (confirm=true)

Speed: IMAP connection is reused inside the process; searches fetch headers only.
"""
import email
import email.header
import email.utils
import imaplib
import json
import os
import re
import smtplib
import ssl
import sys
import time
from email.message import EmailMessage

SERVER_NAME = "yandex-mail-mcp"
SERVER_VERSION = "1.0.0"
PROTOCOL_VERSION = "2024-11-05"

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.environ.get("AMN_PROJECT") or os.path.abspath(os.path.join(HERE, "..", ".."))
CRED_FILE = os.path.join(PROJECT, "_secrets", "credentials.json")
LOG_FILE = os.path.join(HERE, "server.log")

_ctx = ssl.create_default_context()
_imap = {"conn": None, "folder": None}
_creds = None


def log(msg):
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


def load_creds():
    global _creds
    if _creds is None:
        with open(CRED_FILE, "r", encoding="utf-8") as f:
            _creds = json.load(f)["mail"]
    return _creds


def decode_header(value):
    if not value:
        return ""
    try:
        parts = email.header.decode_header(value)
        out = []
        for text, enc in parts:
            if isinstance(text, bytes):
                out.append(text.decode(enc or "utf-8", "replace"))
            else:
                out.append(text)
        return "".join(out)
    except Exception:
        return str(value)


def connect():
    creds = load_creds()
    if _imap["conn"] is not None:
        try:
            _imap["conn"].noop()
            return _imap["conn"]
        except Exception:
            try:
                _imap["conn"].logout()
            except Exception:
                pass
            _imap["conn"] = None
    host = (creds.get("imap") or "imap.yandex.ru:993").split(":")[0]
    conn = imaplib.IMAP4_SSL(host, 993, ssl_context=_ctx)
    conn.login(creds["account"], creds["password"])
    _imap["conn"] = conn
    log("IMAP connected as %s" % creds["account"])
    return conn


def use_folder(folder):
    conn = connect()
    if _imap["folder"] != folder:
        conn.select('"%s"' % folder, readonly=True)
        _imap["folder"] = folder
    return conn


def parse_header(raw):
    msg = email.message_from_bytes(raw)
    return {
        "uid": None,
        "date": decode_header(msg.get("Date")),
        "from": decode_header(msg.get("From")),
        "to": decode_header(msg.get("To")),
        "subject": decode_header(msg.get("Subject")),
        "message_id": (msg.get("Message-ID") or "").strip(),
        "size": len(raw),
    }


def extract_body(msg):
    text_parts, html_parts, attachments = [], [], []
    for part in msg.walk():
        ctype = part.get_content_type()
        disp = (part.get("Content-Disposition") or "")
        filename = part.get_filename()
        if filename or "attachment" in disp.lower():
            payload = part.get_payload(decode=True) or b""
            attachments.append({"filename": decode_header(filename), "content_type": ctype, "size": len(payload)})
            continue
        if ctype == "text/plain":
            payload = part.get_payload(decode=True) or b""
            text_parts.append(payload.decode(part.get_content_charset() or "utf-8", "replace"))
        elif ctype == "text/html":
            payload = part.get_payload(decode=True) or b""
            html_parts.append(payload.decode(part.get_content_charset() or "utf-8", "replace"))
    text = "\n".join(text_parts).strip()
    if not text and html_parts:
        text = re.sub(r"<[^>]+>", " ", html_parts[0])
        text = re.sub(r"\s+", " ", text).strip()
    return text, html_parts, attachments


def tool_status(args):
    t0 = time.time()
    conn = use_folder("INBOX")
    total = conn.select("INBOX", readonly=True)[1][0].decode()
    typ, data = conn.status("INBOX", "(MESSAGES UNSEEN)")
    unseen = 0
    if typ == "OK":
        m = re.search(r"UNSEEN (\d+)", data[0].decode())
        unseen = int(m.group(1)) if m else 0
    creds = load_creds()
    return {"ok": True, "account": creds["account"], "imap": creds.get("imap"), "folder": "INBOX",
            "messages": int(total), "unseen": unseen, "latency_ms": int((time.time() - t0) * 1000)}


def tool_folders(args):
    conn = connect()
    typ, data = conn.list()
    folders = []
    for line in data:
        try:
            text = line.decode("utf-8", "replace")
            m = re.match(r'\((?P<flags>[^)]*)\) "(?P<delim>[^"]*)" (?P<name>.+)$', text)
            if m:
                name = m.group("name").strip().strip('"')
                folders.append({"name": name, "delimiter": m.group("delim"), "flags": m.group("flags")})
        except Exception:
            continue
    return {"folders": folders, "count": len(folders)}


def tool_search(args):
    folder = args.get("folder") or "INBOX"
    limit = min(int(args.get("limit") or 10), 50)
    q = args.get("query") or {}
    criteria = []
    if q.get("from"):
        criteria += ["FROM", '"%s"' % q["from"]]
    if q.get("subject"):
        criteria += ["SUBJECT", '"%s"' % q["subject"]]
    if q.get("text"):
        criteria += ["TEXT", '"%s"' % q["text"]]
    if q.get("since"):
        criteria += ["SINCE", q["since"]]
    if q.get("before"):
        criteria += ["BEFORE", q["before"]]
    if q.get("unseen"):
        criteria += ["UNSEEN"]
    if not criteria:
        criteria = ["ALL"]
    conn = connect()
    conn.select('"%s"' % folder, readonly=True)
    _imap["folder"] = folder
    try:
        typ, data = conn.uid("search", "CHARSET", "UTF-8", *criteria)
    except UnicodeEncodeError:
        enc = [c.encode("utf-8") if isinstance(c, str) else c for c in (["CHARSET", "UTF-8"] + criteria)]
        typ, data = conn.uid("search", None, *enc)
    uids = data[0].split()
    uids = uids[-limit:][::-1]
    if not uids:
        return {"folder": folder, "criteria": criteria, "count": 0, "messages": []}
    messages = []
    typ, fetched = conn.uid("fetch", ",".join(u.decode() for u in uids),
                            "(UID FLAGS BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID)])")
    for item in fetched:
        if isinstance(item, tuple):
            raw = item[1]
            h = parse_header(raw)
            m = re.search(rb"UID (\d+)", item[0])
            if m:
                h["uid"] = int(m.group(1))
            mm = re.search(rb"FLAGS \(([^)]*)\)", item[0])
            h["flags"] = (mm.group(1).decode() if mm else "")
            messages.append(h)
    messages.sort(key=lambda x: x.get("uid") or 0, reverse=True)
    return {"folder": folder, "criteria": criteria, "count": len(messages), "messages": messages}


def tool_get(args):
    uid = int(args["uid"])
    folder = args.get("folder") or "INBOX"
    include_html = bool(args.get("include_html"))
    conn = connect()
    conn.select('"%s"' % folder, readonly=True)
    _imap["folder"] = folder
    typ, data = conn.uid("fetch", str(uid), "(RFC822)")
    if typ != "OK" or not data or not isinstance(data[0], tuple):
        return {"error": "message not found", "uid": uid, "folder": folder}
    msg = email.message_from_bytes(data[0][1])
    head = {
        "uid": uid, "folder": folder,
        "date": decode_header(msg.get("Date")),
        "from": decode_header(msg.get("From")),
        "to": decode_header(msg.get("To")),
        "cc": decode_header(msg.get("Cc")),
        "subject": decode_header(msg.get("Subject")),
        "message_id": (msg.get("Message-ID") or "").strip(),
    }
    text, html, attachments = extract_body(msg)
    result = {"headers": head, "text": text[:20000], "attachments": attachments,
              "attachment_count": len(attachments), "text_length": len(text)}
    if include_html and html:
        result["html"] = html[0][:50000]
    return result


def tool_unread(args):
    folder = args.get("folder") or "INBOX"
    conn = connect()
    conn.select('"%s"' % folder, readonly=True)
    _imap["folder"] = folder
    typ, data = conn.status('"%s"' % folder, "(MESSAGES UNSEEN)")
    count = 0
    if typ == "OK":
        m = re.search(r"UNSEEN (\d+)", data[0].decode())
        count = int(m.group(1)) if m else 0
    return {"folder": folder, "unseen": count}


def tool_mark_read(args):
    if not args.get("confirm"):
        return {"error": "requires confirm=true"}
    uids = args.get("uids") or ([args["uid"]] if args.get("uid") else [])
    if not uids:
        return {"error": "uid or uids required"}
    folder = args.get("folder") or "INBOX"
    conn = connect()
    conn.select('"%s"' % folder, readonly=False)
    _imap["folder"] = None
    typ, data = conn.uid("store", ",".join(str(u) for u in uids), "+FLAGS", "(\\Seen)")
    return {"ok": typ == "OK", "uids": uids, "folder": folder}


def tool_send(args):
    if not args.get("confirm"):
        return {"error": "requires confirm=true"}
    creds = load_creds()
    msg = EmailMessage()
    msg["From"] = creds["account"]
    msg["To"] = ", ".join(args["to"]) if isinstance(args["to"], list) else args["to"]
    if args.get("cc"):
        msg["Cc"] = ", ".join(args["cc"]) if isinstance(args["cc"], list) else args["cc"]
    msg["Subject"] = args.get("subject") or ""
    msg.set_content(args.get("body") or "")
    for path in args.get("attachments") or []:
        with open(path, "rb") as f:
            data = f.read()
        msg.add_attachment(data, maintype="application", subtype="octet-stream",
                           filename=os.path.basename(path))
    host = (creds.get("smtp") or "smtp.yandex.ru:465").split(":")[0]
    with smtplib.SMTP_SSL(host, 465, context=_ctx) as s:
        s.login(creds["account"], creds["password"])
        s.send_message(msg)
    return {"ok": True, "from": creds["account"], "to": msg["To"], "subject": msg["Subject"]}


TOOLS = [
    {"name": "mail_status", "description": "IMAP connection status, message and unread counters.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "mail_folders", "description": "List IMAP folders.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "mail_search", "description": "Fast header search in a folder. Returns newest matches first (uid, date, from, to, subject).",
     "inputSchema": {"type": "object", "properties": {
         "folder": {"type": "string"}, "limit": {"type": "integer"},
         "query": {"type": "object", "properties": {
             "from": {"type": "string"}, "subject": {"type": "string"}, "text": {"type": "string"},
             "since": {"type": "string", "description": "e.g. 01-Oct-2026"},
             "before": {"type": "string"}, "unseen": {"type": "boolean"}}}},
      "additionalProperties": False}},
    {"name": "mail_get", "description": "Fetch one message by UID: headers, text body, attachments list.",
     "inputSchema": {"type": "object", "properties": {
         "uid": {"type": "integer"}, "folder": {"type": "string"}, "include_html": {"type": "boolean"}},
      "required": ["uid"], "additionalProperties": False}},
    {"name": "mail_unread", "description": "Unread count for a folder.",
     "inputSchema": {"type": "object", "properties": {"folder": {"type": "string"}}, "additionalProperties": False}},
    {"name": "mail_mark_read", "description": "Mark messages as read (confirm=true).",
     "inputSchema": {"type": "object", "properties": {
         "uid": {"type": "integer"}, "uids": {"type": "array", "items": {"type": "integer"}},
         "folder": {"type": "string"}, "confirm": {"type": "boolean"}},
      "additionalProperties": False}},
    {"name": "mail_send", "description": "Send email via SMTP (confirm=true).",
     "inputSchema": {"type": "object", "properties": {
         "to": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
         "cc": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
         "subject": {"type": "string"}, "body": {"type": "string"},
         "attachments": {"type": "array", "items": {"type": "string"}},
         "confirm": {"type": "boolean"}},
      "required": ["to", "confirm"], "additionalProperties": False}},
]

CALLS = {
    "mail_status": tool_status, "mail_folders": tool_folders, "mail_search": tool_search,
    "mail_get": tool_get, "mail_unread": tool_unread, "mail_mark_read": tool_mark_read,
    "mail_send": tool_send,
}


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
    log("mail MCP server started")
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
            continue
        try:
            if method == "initialize":
                reply(msg_id, {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
                               "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION}})
            elif method == "tools/list":
                reply(msg_id, {"tools": TOOLS})
            elif method == "tools/call":
                params = msg.get("params") or {}
                name = params.get("name")
                fn = CALLS.get(name)
                if not fn:
                    reply(msg_id, error="unknown tool: %s" % name)
                    continue
                result = fn(params.get("arguments") or {})
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
