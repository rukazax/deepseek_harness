#!/usr/bin/env python3
"""CLI helper for Yandex Mail MCP tools (fast access from DSH shell).

Usage:
  python mail_cli.py status
  python mail_cli.py folders
  python mail_cli.py unread [--folder INBOX]
  python mail_cli.py search --subject "Символ" --limit 5 [--from user@domain] [--since 01-Oct-2026]
  python mail_cli.py get --uid 12345 [--folder INBOX] [--html]
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from server import CALLS  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("folders")
    p = sub.add_parser("unread"); p.add_argument("--folder", default="INBOX")
    p = sub.add_parser("search")
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--subject"); p.add_argument("--from"); p.add_argument("--text")
    p.add_argument("--since"); p.add_argument("--before"); p.add_argument("--unseen", action="store_true")
    p.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("get")
    p.add_argument("--uid", type=int, required=True)
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--html", action="store_true")
    a = ap.parse_args()
    if a.cmd == "status":
        r = CALLS["mail_status"]({})
    elif a.cmd == "folders":
        r = CALLS["mail_folders"]({})
    elif a.cmd == "unread":
        r = CALLS["mail_unread"]({"folder": a.folder})
    elif a.cmd == "search":
        q = {"subject": a.subject, "from": a.__dict__.get("from"), "text": a.text,
             "since": a.since, "before": a.before, "unseen": a.unseen}
        q = {k: v for k, v in q.items() if v}
        r = CALLS["mail_search"]({"folder": a.folder, "query": q, "limit": a.limit})
    else:
        r = CALLS["mail_get"]({"uid": a.uid, "folder": a.folder, "include_html": a.html})
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
