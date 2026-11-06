# -*- coding: utf-8 -*-
"""
yidu_android.py —— 安卓版启动入口
=================================
由 MainActivity（Java）调用：

    Python.start(new AndroidPlatform(this));
    int port = Python.getInstance().getModule("yidu_android")
                    .callAttr("start", filesDirPath).toJava(int.class);

做的事：
    1. 设置 YIDU_HOME 环境变量 → config.py 的基准目录指到应用私有目录（可写）
    2. 首次启动时补齐 config.ini / state / static/books
    3. 在后台线程里起 Flask 服务，返回端口号给 Java，Java 再用 WebView 打开

static / templates 由 Java 侧从 APK assets 解压到 YIDU_HOME，
因为 Chaquopy 的 python 源码在压缩包里，不能直接用文件路径读取。
"""

from __future__ import annotations

import os
import socket
import threading
import time

DEFAULT_PORT = 8720

# ----------------------------------------------------------------------
# 预置的云端地址与 anon key
# ----------------------------------------------------------------------
# 为什么可以直接写死在源码里：
#   anon key 是 Supabase 专门设计成「可公开」的密钥，它只能做数据库行级安全
#   策略（RLS）允许的事 —— 没有登录令牌的话，读到的永远是空数组。
#   真正的权限边界在 policies 上，见 docs/supabase_schema.sql。
#   预置在这里，用户装完 App 打开就能直接登录，不用手抄 200 多个字符。
#
# 绝对不能出现在本文件里的两样东西：
#   1. service_role key（绕过所有 RLS，等于数据库超级权限）
#   2. 数据库密码（postgres 账号的密码）
#   它们只存在 state/cloud-credentials.txt（已 gitignore）。
_CLOUD_URL = "https://spb-c8q8ryx5q2hgmctu.supabase.opentrust.net"
_CLOUD_ANON_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InNwYi1jOHE4cnl4NXEyaGdtY3R1IiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3OTM5NDQ5MDQsImV4cCI6MjEwOTUyMDkwNH0.SEAAMDU3wz_8Vnmn90PbiaFCvB38x9MWTFzCfdDW8xQ"

_DEFAULT_CONFIG = """; 译读 · 英文阅读器（安卓版）配置文件
; API Key 可以稍后在 App 里的「设置」面板填写，也可以直接编辑本文件

[api]
api_key    = sk-not-configured
base_url   = https://api.deepseek.com/v1
model      = deepseek-chat

[translation]
max_workers        = 4
max_chars_per_req  = 1800
request_timeout    = 120
max_retries        = 6
retry_wait_base    = 2
glossary_sample    = 120
summary_window     = 8
temperature        = 0.3

[server]
host = 127.0.0.1
port = 8720
auto_open_browser = false

[ui]
default_font_size = 19
default_theme = dark

[cloud]
; 账号与云端同步（已预置，一般不用改）
supabase_url      = __URL__
supabase_anon_key = __KEY__
sync_enabled      = true
""".replace("__URL__", _CLOUD_URL).replace("__KEY__", _CLOUD_ANON_KEY)

# 老版本的 config.ini 没有 [cloud] 段：补一段上去（已带默认值）
_CLOUD_SECTION = """
[cloud]
; 账号与云端同步（已预置，一般不用改）
supabase_url      = __URL__
supabase_anon_key = __KEY__
sync_enabled      = true
""".replace("__URL__", _CLOUD_URL).replace("__KEY__", _CLOUD_ANON_KEY)


def _fill_cloud_defaults(path: str) -> None:
    """
    老版本升级上来时，config.ini 里 [cloud] 段的两行是空的 —— 把预置值填进去。

    为什么必须做：手机用户看不到 config.ini（在应用私有目录），
    让他手抄一个 208 字符的 anon key 是不现实的。填完这里，
    打开 App 直接就是「填邮箱密码登录」，不用碰这些技术参数。

    只填空值，用户自己填过的一律不动。
    """
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            lines = fh.readlines()
    except OSError:
        return

    changed = False
    in_cloud = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_cloud = stripped == "[cloud]"
            continue
        if not in_cloud or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        name = name.strip()
        if not value.strip():
            if name == "supabase_url":
                lines[i] = "supabase_url      = " + _CLOUD_URL + "\n"
                changed = True
            elif name == "supabase_anon_key":
                lines[i] = "supabase_anon_key = " + _CLOUD_ANON_KEY + "\n"
                changed = True

    if changed:
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.writelines(lines)
        except OSError:
            pass


def _prepare_home(home: str) -> None:
    """准备好可写目录里的必要文件（已存在则不动）。"""
    os.makedirs(home, exist_ok=True)
    os.makedirs(os.path.join(home, "state"), exist_ok=True)
    os.makedirs(os.path.join(home, "static", "books"), exist_ok=True)

    config_path = os.path.join(home, "config.ini")
    if not os.path.isfile(config_path):
        with open(config_path, "w", encoding="utf-8") as fh:
            fh.write(_DEFAULT_CONFIG)
    else:
        # 升级上来的老配置：补上后来新增的段落（只补缺的，不改已有内容）
        try:
            with open(config_path, "r", encoding="utf-8-sig") as fh:
                text = fh.read()
            if "[cloud]" not in text:
                with open(config_path, "a", encoding="utf-8") as fh:
                    fh.write(_CLOUD_SECTION)
        except OSError:
            pass

    # 老配置里 [cloud] 两行为空 → 填预置值（手机上用户改不了文件）
    _fill_cloud_defaults(config_path)

    for must in ("static/app.js", "templates/index.html"):
        if not os.path.isfile(os.path.join(home, must)):
            raise RuntimeError(
                f"缺少界面资源：{must}（应由 App 首次启动时从 assets 解压）"
            )


def _free_port(preferred: int) -> int:
    """优先用 preferred，被占了就往后找。"""
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    return preferred


def start(home: str) -> int:
    """启动本地服务，返回实际监听端口。"""
    home = os.path.abspath(home)
    os.environ["YIDU_HOME"] = home
    _prepare_home(home)

    from config import load_config
    from server import create_app

    cfg = load_config(os.path.join(home, "config.ini"))
    port = _free_port(DEFAULT_PORT)

    app = create_app(
        cfg,
        static_folder=os.path.join(home, "static"),
        template_folder=os.path.join(home, "templates"),
    )

    def _serve() -> None:
        app.run(host="127.0.0.1", port=port, threaded=True,
                debug=False, use_reloader=False)

    threading.Thread(target=_serve, name="yidu-flask", daemon=True).start()

    # 等端口真的能连上再交还给 Java，避免 WebView 打开空白页
    deadline = time.time() + 20
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.3)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return port
        time.sleep(0.15)
    return port
