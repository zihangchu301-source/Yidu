# -*- coding: utf-8 -*-
"""
cloud.py —— 账号与云端同步（Supabase）
========================================
职责：
    1. 用邮箱 + 密码注册 / 登录 Supabase，拿到并自动续期 JWT
    2. 把本地的书库 / 阅读进度 / 笔记划线 / 查词记录 / 界面偏好同步到云端
    3. 换设备登录后，把这些数据从云端拉回来

为什么不让前端直接调 Supabase：
    * App 的 WebView 跑的是 http://127.0.0.1:<端口>，端口一变 origin 就变，
      localStorage 全部丢失（老 bug）；令牌放后端就与 origin 无关。
    * anon key 不落到网页里，网页只认 127.0.0.1 的本地接口。
    * 同步要读 SQLite，本来就在 Python 这一侧。

为什么不用 supabase-py：
    * 它依赖 pydantic v2（带 Rust 原生扩展），Chaquopy 打不进 APK；
      这里只用标准库 urllib 直连 REST/Auth 接口，零新增依赖。

同步策略（简单、可预期）：
    * 每条记录的身份是 (kind, key)，云端表 yidu_records 一一对应。
    * 冲突判定不看设备时钟，只看"内容指纹"：本地指纹和上次同步时不同 = 本地改过，
      这时以本地为准（推上去）；否则接受云端版本。
    * 删除靠墓碑（deleted=true），不会出现"删了又被拉回来"。
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional

# 云端表名（和 supabase_schema.sql 里的一致）
RECORD_TABLE = "yidu_records"

# 单次同步最多拉 / 推多少条，防止一本大书把内存打满
PAGE_SIZE = 500

# 令牌提前多少秒续期
REFRESH_MARGIN = 120

# 网络超时（秒）。校园网 / 弱网都不能让界面卡住
TIMEOUT = 15

_SYNC_LOCK = threading.Lock()


# ======================================================================
# 异常：都带一句能直接给用户看的中文说明
# ======================================================================
class CloudError(Exception):
    """云端相关错误基类。str(e) 已经是可以直接显示的文案。"""


class NetworkError(CloudError):
    """连不上（断网 / 被墙 / 地址填错）。"""


class AuthError(CloudError):
    """账号问题（密码错、没注册、邮箱未验证）。"""


# ======================================================================
# 小工具
# ======================================================================
def _payload_hash(payload: dict) -> str:
    """内容指纹：同样的内容永远得到同样的串，用来判断"本地有没有改过"。"""
    raw = json.dumps(payload or {}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _fmt_ts(ts: float) -> str:
    """epoch 秒 → Supabase 认的 ISO8601 UTC 字符串。"""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")


def _parse_ts(value: str) -> Optional[float]:
    """
    解析时间串成 epoch 秒。
    既认 Supabase 的 "2026-11-06T05:11:17.123456+00:00"，
    也认本地库里不带时区的 "2026-11-06 13:11:17"（按本机时区理解）。
    """
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00").replace(" ", "T", 1)
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        # 老格式兜底：2026-11-06 13:11:17
        try:
            dt = datetime.strptime(str(value)[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if dt.tzinfo is None:
        return dt.timestamp()
    return dt.timestamp()


def _friendly_http_error(status: int, body: str) -> str:
    """把 Supabase 的英文报错翻译成人话。"""
    low = (body or "").lower()
    if "invalid login credentials" in low:
        return "邮箱或密码不正确。"
    if "user already registered" in low or "already been registered" in low:
        return "这个邮箱已经注册过了，直接登录即可。"
    if "email not confirmed" in low:
        return "邮箱还没验证。去 Supabase 后台 Authentication → Providers → Email 关掉「Confirm email」就能直接登录。"
    if "password should be at least" in low:
        return "密码太短，至少 6 位。"
    if "unable to validate email" in low or "invalid format" in low:
        return "邮箱格式不对。"
    if "pgrst205" in low or "could not find the table" in low:
        return ("云端还没有建表。打开 Supabase → SQL Editor，"
                "把项目里的 docs/supabase_schema.sql 全文粘进去执行一次。")
    if "row-level security" in low or "permission denied" in low or "42501" in low:
        return ("云端权限被拒。多半是 yidu_records 表没开 RLS 策略，"
                "按 docs/supabase_schema.sql 重新执行一遍。")
    if status == 401:
        return "登录已过期，请重新登录。"
    if status == 403:
        return "云端的密钥没有权限访问这张表，检查 config.ini 里的 anon key。"
    if status == 429:
        return "请求太频繁，稍等一分钟再试。"
    if status >= 500:
        return f"云端服务出错了（HTTP {status}），稍后再试。"
    # 兜底：带上原始信息前 200 字，免得只会说"失败了"
    return f"云端返回 HTTP {status}：{(body or '')[:200]}"


# ======================================================================
# 账号会话（存 state/cloud.json，只放令牌，绝不放密码）
# ======================================================================
class Session:
    def __init__(self, path: str):
        self.path = path
        self.data: dict = {}
        self._load()

    def _load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                self.data = json.load(f) or {}
        except (OSError, ValueError):
            self.data = {}

    def save(self) -> None:
        self.data["saved_at"] = int(time.time())
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False)
            os.replace(tmp, self.path)
            try:  # 只有自己能读
                os.chmod(self.path, 0o600)
            except OSError:
                pass
        except OSError:
            pass

    def clear(self) -> None:
        self.data = {}
        try:
            os.remove(self.path)
        except OSError:
            pass

    # ---- 便捷属性 ----
    @property
    def access_token(self) -> str:
        return self.data.get("access_token") or ""

    @property
    def refresh_token(self) -> str:
        return self.data.get("refresh_token") or ""

    @property
    def user_id(self) -> str:
        return self.data.get("user_id") or ""

    @property
    def email(self) -> str:
        return self.data.get("email") or ""

    @property
    def expires_at(self) -> float:
        return float(self.data.get("expires_at") or 0)

    def apply(self, auth: dict) -> None:
        """把 /auth/v1 返回的会话写进本地。"""
        user = auth.get("user") or {}
        self.data.update({
            "access_token": auth.get("access_token") or "",
            "refresh_token": auth.get("refresh_token") or self.refresh_token,
            "expires_at": int(time.time()) + int(auth.get("expires_in") or 3600),
            "user_id": user.get("id") or self.user_id,
            "email": user.get("email") or self.email,
        })
        self.save()

    def bind_server(self, url: str) -> None:
        """
        记下这份令牌属于哪个云端地址。
        换了地址（比如从官方 Supabase 换到阿里云实例）令牌就无效了，
        必须清掉重新登录，否则会拿着 A 项目的令牌去请求 B 项目。
        """
        old = self.data.get("server") or ""
        if old and url and old.rstrip("/") != url.rstrip("/"):
            self.clear()
            self.data = {"server": url}
            self.save()
            return
        if url and old != url:
            self.data["server"] = url
            self.save()

    def is_logged_in(self) -> bool:
        return bool(self.refresh_token or self.access_token)


# ======================================================================
# Supabase 客户端（Auth + Data API，纯 urllib）
# ======================================================================
class Supabase:
    def __init__(self, url: str, anon_key: str):
        self.url = (url or "").rstrip("/")
        self.key = anon_key or ""

    # ---------------- 底层请求 ----------------
    def _request(
        self,
        method: str,
        path: str,
        body=None,
        token: Optional[str] = None,
        prefer: Optional[str] = None,
        query: Optional[dict] = None,
        timeout: int = TIMEOUT,
    ):
        if not self.url or not self.key:
            raise CloudError("还没配置云端地址和密钥，请先在 config.ini 的 [cloud] 里填好。")

        url = self.url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)

        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("apikey", self.key)
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        # 注意：这里是 Bearer（不是 apikey），RLS 靠它识别用户身份
        req.add_header("Authorization", "Bearer " + (token or self.key))
        if prefer:
            req.add_header("Prefer", prefer)

        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")
            except Exception:  # noqa: BLE001 - 读错误体失败不影响主流程
                pass
            raise CloudError(_friendly_http_error(exc.code, detail)) from exc
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise NetworkError(
                f"连不上云端（{reason}）。检查网络，或确认 config.ini 里的 supabase_url 是否正确。"
            ) from exc

        if not raw:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return raw

    # ---------------- 认证 ----------------
    def sign_up(self, email: str, password: str) -> dict:
        return self._request("POST", "/auth/v1/signup", {"email": email, "password": password})

    def sign_in(self, email: str, password: str) -> dict:
        return self._request(
            "POST", "/auth/v1/token", {"email": email, "password": password},
            query={"grant_type": "password"},
        )

    def refresh(self, refresh_token: str) -> dict:
        return self._request(
            "POST", "/auth/v1/token", {"refresh_token": refresh_token},
            query={"grant_type": "refresh_token"},
        )

    def sign_out(self, access_token: str) -> None:
        try:
            self._request("POST", "/auth/v1/logout", {}, token=access_token)
        except CloudError:
            pass  # 本地清掉就够了，服务端失败不影响

    # ---------------- 数据 ----------------
    def fetch_records(self, token: str, since: Optional[str] = None) -> List[dict]:
        """拉取 since 之后变更的记录（since 为空 = 全量）。"""
        out: List[dict] = []
        offset = 0
        while True:
            query = {
                "select": "kind,key,payload,updated_at,deleted",
                "order": "updated_at.asc",
                "limit": str(PAGE_SIZE),
                "offset": str(offset),
            }
            if since:
                query["updated_at"] = "gt." + since
            rows = self._request(
                "GET", f"/rest/v1/{RECORD_TABLE}", token=token, query=query
            ) or []
            out.extend(rows)
            if len(rows) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
            if offset > 20000:  # 保险丝，别无限循环
                break
        return out

    def push_records(self, token: str, user_id: str, rows: List[dict]) -> List[dict]:
        """批量写入 / 覆盖（同主键合并）。返回服务端回写的行（含 updated_at）。"""
        if not rows:
            return []
        body = []
        for r in rows:
            body.append({
                "user_id": user_id,
                "kind": r["kind"],
                "key": r["key"],
                "payload": r.get("payload") or {},
                "deleted": bool(r.get("deleted")),
            })
        result = self._request(
            "POST", f"/rest/v1/{RECORD_TABLE}",
            body,
            token=token,
            prefer="resolution=merge-duplicates,return=representation",
            query={"on_conflict": "user_id,kind,key"},
        )
        return result or []


# ======================================================================
# 同步引擎
# ======================================================================
class SyncEngine:
    """
    本地 SQLite ↔ Supabase 双向同步。

    一次 sync() 做三件事：
        1. 增量拉云端 → 写进本地（本地未改动的记录才接受云端版本）
        2. 本地改动（指纹变了）+ 删除墓碑 → 推到云端
        3. 记账（每条记录的上次同步指纹 / 云端时间）
    """

    def __init__(self, store, session_path: str, url: str, key: str):
        self.store = store
        self.session = Session(session_path)
        self.sb = Supabase(url, key)
        self.url = url or ""
        if self.url:
            self.session.bind_server(self.url)

    def reconfigure(self, url: str, key: str) -> None:
        """在「设置」里改了云端地址 / 密钥后热更新，不用重启 App。"""
        self.url = (url or "").rstrip("/")
        self.sb = Supabase(self.url, key)
        if self.url:
            self.session.bind_server(self.url)

    # ---------------- 账号 ----------------
    def status(self) -> dict:
        return {
            "logged_in": self.session.is_logged_in() and bool(self.session.access_token
                                                              or self.session.refresh_token),
            "email": self.session.email,
            "user_id": self.session.user_id,
            "configured": bool(self.url and self.sb.key),
            "server": self.url,
        }

    def login(self, email: str, password: str) -> dict:
        email = (email or "").strip().lower()
        if "@" not in email:
            raise AuthError("请填写邮箱地址。")
        if not password:
            raise AuthError("请填写密码。")
        auth = self.sb.sign_in(email, password)
        if not auth or not auth.get("access_token"):
            raise AuthError("登录失败：云端没有返回令牌。")
        self.session.apply(auth)
        return self.status()

    def register(self, email: str, password: str) -> dict:
        email = (email or "").strip().lower()
        if "@" not in email:
            raise AuthError("请填写邮箱地址。")
        if len(password or "") < 6:
            raise AuthError("密码至少 6 位。")
        res = self.sb.sign_up(email, password) or {}
        # 关掉邮箱验证时，注册接口会直接带上 access_token；否则要用户去点邮件
        if res.get("access_token"):
            self.session.apply(res)
            return self.status()
        if res.get("id") or (res.get("user") or {}).get("id"):
            # 需要邮箱验证：顺手再登一次，若已允许则直接进
            try:
                auth = self.sb.sign_in(email, password)
                if auth and auth.get("access_token"):
                    self.session.apply(auth)
                    return self.status()
            except CloudError:
                pass
            raise AuthError(
                "注册成功，但需要先验证邮箱。建议去 Supabase 后台 "
                "Authentication → Sign In / Providers → Email 关掉「Confirm email」，"
                "之后就能直接注册登录。"
            )
        raise AuthError("注册失败，请检查邮箱和密码格式。")

    def logout(self) -> dict:
        self.sb.sign_out(self.session.access_token)
        self.session.clear()
        return self.status()

    def _ensure_token(self) -> str:
        """拿一个可用的 access_token，快过期就自动续。"""
        if not self.session.is_logged_in():
            raise AuthError("还没登录账号。")
        if self.session.access_token and self.session.expires_at - REFRESH_MARGIN > time.time():
            return self.session.access_token
        if not self.session.refresh_token:
            raise AuthError("登录已失效，请重新登录。")
        try:
            auth = self.sb.refresh(self.session.refresh_token)
        except CloudError as exc:
            self.session.clear()
            raise AuthError(f"登录已失效，请重新登录。（{exc}）") from exc
        if not auth or not auth.get("access_token"):
            self.session.clear()
            raise AuthError("登录已失效，请重新登录。")
        self.session.apply(auth)
        return self.session.access_token

    # ---------------- 同步 ----------------
    def sync(self, full: bool = False) -> dict:
        """
        执行一次双向同步。加了锁：同一时刻只允许一个同步在跑，
        否则两个请求同时推同一批记录会互相覆盖。

        :param full: True = 忽略水位，全量拉一遍（换设备 / 想强制对齐时用）
        """
        if not _SYNC_LOCK.acquire(blocking=False):
            raise CloudError("正在同步中，请稍候。")
        try:
            return self._sync_inner(full)
        finally:
            _SYNC_LOCK.release()

    def _sync_inner(self, full: bool) -> dict:
        if not (self.url and self.sb.key):
            raise CloudError(
                "还没配置云端地址和密钥。请在 config.ini 的 [cloud] 里填好 "
                "supabase_url 和 supabase_anon_key，重启后再登录。"
            )
        token = self._ensure_token()
        user_id = self.session.user_id
        if not user_id:
            raise AuthError("登录信息不完整，请重新登录。")

        meta = self.store.sync_meta_map()          # (kind,key) -> {remote_at, local_hash}
        local_snapshot = {(r["kind"], r["key"]): r for r in self.store.sync_source()}

        # 水位：所有记录里最新的云端时间。只拿云端时间和云端时间比，绝不和本机时钟比。
        watermark = ""
        if not full:
            for m in meta.values():
                ra = m.get("remote_at") or ""
                if ra > watermark:
                    watermark = ra

        # ---- 1. 拉：云端 → 本地 ----
        pulled = self.sb.fetch_records(token, since=watermark or None)
        applied = 0
        kept_local = 0
        for row in pulled:
            kind = row.get("kind")
            key = row.get("key")
            if not kind or not key:
                continue
            remote_at = row.get("updated_at") or ""
            if remote_at > watermark:
                watermark = remote_at

            payload = row.get("payload") or {}
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except ValueError:
                    payload = {}

            local = local_snapshot.get((kind, key))
            m = meta.get((kind, key)) or {}
            if local is not None and m.get("local_hash") and \
                    _payload_hash(local["payload"]) != m["local_hash"]:
                # 本地改过、还没推上去 → 以本地为准，这一轮不覆盖
                kept_local += 1
                continue

            if row.get("deleted"):
                self.store.apply_remote_delete(kind, key)
            else:
                self.store.apply_remote(kind, key, payload)
            applied += 1

        # ---- 2. 推：本地改动 + 删除墓碑 → 云端 ----
        to_push: List[dict] = []
        changed = 0
        for rec in local_snapshot.values():
            h = _payload_hash(rec["payload"])
            m = meta.get((rec["kind"], rec["key"])) or {}
            if m.get("local_hash") == h:
                continue  # 内容没变，不用传
            to_push.append(rec)
            changed += 1

        tombstones = self.store.tombstones()
        for tomb in tombstones:
            to_push.append({
                "kind": tomb["kind"], "key": tomb["key"],
                "payload": {}, "deleted": True,
            })

        pushed = 0
        for start in range(0, len(to_push), PAGE_SIZE):
            chunk = to_push[start:start + PAGE_SIZE]
            echoed = self.sb.push_records(token, user_id, chunk)
            pushed += len(chunk)
            for r in echoed:
                ts = r.get("updated_at") or ""
                if ts > watermark:
                    watermark = ts
            for rec in chunk:
                if rec.get("deleted"):
                    self.store.clear_tombstone(rec["kind"], rec["key"])

        # ---- 3. 记账：此刻本地 = 云端，把所有本地记录的指纹和最新水位写下来 ----
        stamp = watermark or _fmt_ts(time.time())
        for rec in self.store.sync_source():
            self.store.set_sync_meta(
                rec["kind"], rec["key"], stamp, _payload_hash(rec["payload"])
            )

        return {
            "ok": True,
            "pulled": applied,
            "pushed": pushed,
            "kept_local": kept_local,
            "message": f"同步完成：下载 {applied} 条，上传 {pushed} 条。",
        }
