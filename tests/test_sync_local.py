# -*- coding: utf-8 -*-
"""用本地假 Supabase 验证同步链路（不需要联网）。"""
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "source"))

from state_manager import Store          # noqa: E402
from cloud import SyncEngine             # noqa: E402

DB = {}          # (user_id, kind, key) -> row
LOCK = threading.Lock()
TOKEN = "tok-abc"
USER_ID = "11111111-2222-3333-4444-555555555555"


def now_iso():
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/auth/v1/token":
            grant = q.get("grant_type", [""])[0]
            if grant == "password" and body.get("password") == "secret123":
                return self._json(200, {
                    "access_token": TOKEN, "refresh_token": "ref-1", "expires_in": 3600,
                    "user": {"id": USER_ID, "email": body.get("email")},
                })
            return self._json(400, {"error_description": "Invalid login credentials"})

        if parsed.path == "/rest/v1/yidu_records":
            assert "Bearer" in self.headers.get("Authorization", "")
            out = []
            with LOCK:
                for r in body:
                    ident = (r["user_id"], r["kind"], r["key"])
                    row = DB.get(ident) or {}
                    row.update(r)
                    row["updated_at"] = now_iso()
                    DB[ident] = row
                    out.append(row)
            return self._json(201, out)

        return self._json(404, {"message": "no route"})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(parsed.query)
        if parsed.path != "/rest/v1/yidu_records":
            return self._json(404, {"message": "no route"})
        since = q.get("updated_at", [""])[0]
        since = since[3:] if since.startswith("gt.") else ""
        limit = int(q.get("limit", ["500"])[0])
        offset = int(q.get("offset", ["0"])[0])
        with LOCK:
            rows = [r for r in DB.values() if r["user_id"] == USER_ID]
            if since:
                rows = [r for r in rows if r["updated_at"] > since]
            rows.sort(key=lambda r: r["updated_at"])
            rows = rows[offset:offset + limit]
        return self._json(200, rows)


def main():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}"

    tmp = tempfile.mkdtemp()

    # ---------------- 设备 A ----------------
    dbA = os.path.join(tmp, "A.db")
    storeA = Store(dbA)
    storeA.add_book("hashA", "The Old Man and the Sea", "Hemingway", None, 12, 340, "en")
    storeA.add_annotation("hashA", 3, 77, "note", "he was an old man", "海明威的写法真干净", 0, 18)
    storeA.set_progress("hashA", 3, 77, 0.42)
    storeA.set_app_kv("theme", "dark")
    storeA.set_app_kv("fontSize", 21)
    storeA.add_dict_history("tackle", "hashA", 3, 77)

    engA = SyncEngine(storeA, os.path.join(tmp, "A.json"), url, "anonkey")
    print("A 登录:", engA.login("me@example.com", "secret123")["email"])
    print("A 首次同步:", engA.sync()["message"])
    print("A 再同步(应为 0/0):", engA.sync()["message"])

    # ---------------- 设备 B（全新空库） ----------------
    storeB = Store(os.path.join(tmp, "B.db"))
    engB = SyncEngine(storeB, os.path.join(tmp, "B.json"), url, "anonkey")
    engB.login("me@example.com", "secret123")
    print("B 同步:", engB.sync()["message"])
    print("B 书库:", [(b["book_hash"], b["title"]) for b in storeB.list_books()])
    print("B 进度:", storeB.get_progress("hashA"))
    print("B 笔记:", [(a["type"], a["note"], a["char_start"]) for a in storeB.list_annotations("hashA")])
    print("B 偏好:", storeB.list_app_kv())
    print("B 查词:", [(r["word"], r["chapter_index"]) for r in storeB.list_dict_history()])

    # ---------------- B 改，A 拉 ----------------
    storeB.set_progress("hashA", 7, 200, 0.9)
    storeB.set_app_kv("theme", "light")
    print("B 改完同步:", engB.sync()["message"])
    print("A 拉取:", engA.sync()["message"])
    print("A 看到的新进度:", storeA.get_progress("hashA"))
    print("A 看到的新主题:", storeA.get_app_kv("theme"))

    # ---------------- B 删除一条笔记，A 应跟着删 ----------------
    anno = storeB.list_annotations("hashA")[0]
    storeB.delete_annotation(anno["id"])
    print("B 删笔记后同步:", engB.sync()["message"])
    print("A 拉取:", engA.sync()["message"])
    print("A 剩余笔记数（应为 0）:", len(storeA.list_annotations("hashA")))

    # ---------------- 云端表里到底有什么 ----------------
    with LOCK:
        print("云端记录:", sorted((r["kind"], r["key"][:10], r["deleted"]) for r in DB.values()))

    srv.shutdown()
    print("\n全部通过")


if __name__ == "__main__":
    main()
