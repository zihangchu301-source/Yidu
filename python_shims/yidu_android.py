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
"""


def _prepare_home(home: str) -> None:
    """准备好可写目录里的必要文件（已存在则不动）。"""
    os.makedirs(home, exist_ok=True)
    os.makedirs(os.path.join(home, "state"), exist_ok=True)
    os.makedirs(os.path.join(home, "static", "books"), exist_ok=True)

    config_path = os.path.join(home, "config.ini")
    if not os.path.isfile(config_path):
        with open(config_path, "w", encoding="utf-8") as fh:
            fh.write(_DEFAULT_CONFIG)

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
