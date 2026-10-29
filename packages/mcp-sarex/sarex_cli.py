#!/usr/bin/env python3
"""Command-line helper for the Sarex API (same auth as the MCP server).

Usage:
  python sarex_cli.py status
  python sarex_cli.py notifications [--page 1] [--page-size 20]
  python sarex_cli.py get /api/notifications
  python sarex_cli.py post /api/... '{"key": "value"}'
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from server import call_tool  # noqa: E402


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd = argv[0].lower()
    if cmd == "status":
        print(json.dumps(call_tool("sarex_status", {}), ensure_ascii=False, indent=2))
        return 0
    if cmd == "notifications":
        args = {}
        it = iter(argv[1:])
        for a in it:
            if a == "--page":
                args["page"] = int(next(it))
            elif a == "--page-size":
                args["page_size"] = int(next(it))
        print(json.dumps(call_tool("sarex_notifications", args), ensure_ascii=False, indent=2))
        return 0
    if cmd == "get" and len(argv) >= 2:
        print(json.dumps(call_tool("sarex_request", {"method": "GET", "path": argv[1]}), ensure_ascii=False, indent=2))
        return 0
    if cmd in ("post", "put", "patch", "delete") and len(argv) >= 2:
        body = json.loads(argv[2]) if len(argv) > 2 else None
        print(json.dumps(call_tool("sarex_request", {"method": cmd.upper(), "path": argv[1], "body": body, "confirm": True}),
                         ensure_ascii=False, indent=2))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
