# -*- coding: utf-8 -*-
"""
app.py —— 桌面 App 入口（PyInstaller 打包用）
==============================================
和 main.py 的区别：
    main.py  → 起服务 + 打开浏览器（开发 / 脚本方式使用）
    app.py   → 起服务 + 打开一个独立原生窗口（pywebview），像正常软件

名称 / 图标：
    窗口标题、快捷方式、任务栏都叫「译读 · 英文阅读器」，图标由 make_icon.py 生成。
    改名字只需要改 APP_TITLE；改图标替换 icon.ico / static/brand.png 后重新打包。

两个容易踩的坑（已修）：
    1. pywebview 默认 private_mode=True：关窗时会清掉 WebView2 的
       localStorage，导致主题 / 字号 / 阅读进度每次都丢。这里显式关闭隐私模式，
       并把 WebView2 数据放到 state/webview，跟着软件走。
    2. pywebview 默认 text_select=False：会给 body 注入 user-select:none，
       阅读器里的文字就选不中，划线 / 翻译 / 词典全部受影响。这里显式打开。

打包命令（在本目录执行）：
    pyinstaller --noconfirm --clean EPUBReader.spec
"""

from __future__ import annotations

import os
import shutil
import socket
import sys
import threading
import time
import webbrowser

# 品牌信息：改这里就能改窗口标题 / 提示
APP_TITLE = "译读 · 英文阅读器"

# 与 static/style.css 的 --bg / --text / --border 保持一致。
# 标题栏用 Windows 11 的 DWMWA_CAPTION_COLOR 直接染成同一个颜色，
# 看起来就像页面一直延伸到窗口最上面。
THEME_COLORS = {
    "light": {"bg": "#f7f7f5", "text": "#1a1a1a", "border": "#e5e5e5"},
    "dark": {"bg": "#16181c", "text": "#d6d6d6", "border": "#2f333a"},
}


def _base_dir() -> str:
    """exe（或脚本）所在目录：配置、书库、进度库都在这里。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    # 脚本模式：代码在 source/ 里，运行目录是它的上一级（与 exe 模式共用数据）
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _resource_dir() -> str:
    """打包后的只读资源目录（PyInstaller 解压位置；未打包时同 base）。"""
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", _base_dir())
    return _base_dir()


def _port_open(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def _wait_server(host: str, port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _port_open(host, port):
            return True
        time.sleep(0.2)
    return False


def _ensure_static_in_base() -> None:
    """exe 模式下，补齐 exe 旁 static 目录里缺失的 css/js/图标。

    只补「不存在」的，**绝不覆盖已存在的**。
    原因（2026-11-06 踩过）：以前是拿打包内的文件和运行目录比对、不一致就覆盖。
    但仓库并到 D:\\EPUBReader 之后，运行目录的 static/ 就是唯一正本，
    手工改过的 app.js 会被 exe 里的旧副本打回原样 —— 看起来就像"改了前端没生效"。
    现在缺文件才补，改过的文件永远不会被动。
    """
    base = _base_dir()
    res = _resource_dir()
    static_base = os.path.join(base, "static")
    os.makedirs(static_base, exist_ok=True)
    for name in ("app.js", "style.css", "brand.png"):
        dst = os.path.join(static_base, name)
        src = os.path.join(res, "static", name)
        if not os.path.isfile(src) or os.path.isfile(dst):
            continue
        try:
            shutil.copy2(src, dst)
        except OSError as exc:
            print(f"[提示] 补 static/{name} 失败：{exc}", file=sys.stderr)


# ----------------------------------------------------------------------
# Windows 标题栏配色（深色 / 浅色跟随应用主题，而不是跟随系统）
# ----------------------------------------------------------------------
def _colorref(hex_color: str) -> int:
    """把 #RRGGBB 转成 Win32 的 COLORREF（0x00BBGGRR）。"""
    value = hex_color.lstrip("#")
    r, g, b = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    return r | (g << 8) | (b << 16)


def _find_hwnd(window) -> int:
    """优先从 pywebview 的 native 窗口拿句柄，拿不到再按标题找。"""
    try:
        native = getattr(window, "native", None)
        if native is not None:
            handle = native.Handle
            return int(handle.ToInt64()) if hasattr(handle, "ToInt64") else int(handle)
    except Exception:
        pass
    try:
        import ctypes

        hwnd = ctypes.windll.user32.FindWindowW(None, APP_TITLE)
        return int(hwnd or 0)
    except Exception:
        return 0


def _apply_titlebar(hwnd: int, theme: str) -> None:
    """把 Windows 标题栏染成和页面背景相同的颜色（Win10 1809+ 尽力而为）。"""
    if not sys.platform.startswith("win") or not hwnd:
        return
    colors = THEME_COLORS.get(theme, THEME_COLORS["light"])
    try:
        import ctypes
        from ctypes import wintypes

        dwm = ctypes.WinDLL("dwmapi")
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        dwm.DwmSetWindowAttribute.argtypes = [
            wintypes.HWND,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        dwm.DwmSetWindowAttribute.restype = ctypes.c_long

        def set_attr(attr: int, value: int, size: int = 4) -> bool:
            v = ctypes.c_int(value)
            return dwm.DwmSetWindowAttribute(
                wintypes.HWND(hwnd), attr, ctypes.byref(v), size
            ) == 0

        # 深色模式（20 是新版 Win10/11；19 是旧版 Win10 的兼容编号）
        dark = 1 if theme == "dark" else 0
        for attr in (20, 19):
            if set_attr(attr, dark):
                break

        # Win11：直接指定标题栏 / 文字 / 边框颜色，做到“无缝衔接”
        caption = ctypes.c_uint(_colorref(colors["bg"]))
        text = ctypes.c_uint(_colorref(colors["text"]))
        border = ctypes.c_uint(_colorref(colors["border"]))
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 35, ctypes.byref(caption), 4)
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 36, ctypes.byref(text), 4)
        dwm.DwmSetWindowAttribute(wintypes.HWND(hwnd), 34, ctypes.byref(border), 4)

        # 关闭 Mica 等系统背景材质，避免标题栏颜色被系统调过
        set_attr(38, 1)

        # 触发一次非客户区重绘，让颜色立刻生效
        SWP_NOSIZE = 0x0001
        SWP_NOMOVE = 0x0002
        SWP_NOZORDER = 0x0004
        SWP_NOACTIVATE = 0x0010
        SWP_FRAMECHANGED = 0x0020
        user32.SetWindowPos(
            wintypes.HWND(hwnd),
            wintypes.HWND(0),
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
    except Exception:
        # 标题栏配色失败不影响阅读（旧系统会退回系统默认色）
        pass


class AppApi:
    """暴露给前端 JS 的小接口：切换主题时同步标题栏颜色。"""

    def __init__(self, theme: str) -> None:
        self._theme = "dark" if theme == "dark" else "light"
        self._window = None
        self._hwnd = 0

    def attach(self, window) -> None:
        self._window = window

    def set_theme(self, theme: str) -> bool:
        self._theme = "dark" if str(theme).lower() == "dark" else "light"
        self.apply_current()
        return True

    def apply_current(self) -> None:
        hwnd = self._hwnd or _find_hwnd(self._window)
        if hwnd:
            self._hwnd = hwnd
            _apply_titlebar(hwnd, self._theme)

def _after_start(window, api: AppApi) -> None:
    """窗口和页面都起来之后：套一次标题栏颜色，并接管 pywebview 的系统主题回调。"""
    try:
        window.events.loaded.wait(15)
    except Exception:
        pass
    time.sleep(0.1)
    api.apply_current()

    # pywebview 默认会跟着“Windows 系统主题”改标题栏；本软件有自己的主题，
    # 这里把它的回调替换掉，系统切主题时也保持软件自己的深 / 浅色。
    native = getattr(window, "native", None)
    if native is not None:
        try:
            native.update_title_bar_theme = api.apply_current
        except Exception:
            pass

    # 个别机器上标题栏要等窗口激活后才重绘，再补一次
    time.sleep(0.35)
    api.apply_current()


def main() -> int:
    # ---- 读配置（exe 模式下 config.ini 在 exe 旁边）----
    from config import ConfigError, load_config

    try:
        cfg = load_config(os.path.join(_base_dir(), "config.ini"))
    except ConfigError as exc:
        # 没有窗口可弹，退回控制台报错（--noconsole 下写 stderr 便于排查）
        print(f"[配置错误] {exc}", file=sys.stderr)
        return 1

    from server import create_app

    app = create_app(cfg)

    # exe 模式：把打包在只读资源里的新 css/js/图标覆盖到 exe 旁的 static
    # （static 目录本身由 create_app 按 cfg.books_dir 自动定位，源码/exe 一致）
    if getattr(sys, "frozen", False):
        _ensure_static_in_base()

    url = f"http://{cfg.host}:{cfg.port}"

    # ---- 端口被占用：说明已有实例在跑，直接复用 ----
    already_running = _port_open(cfg.host, cfg.port)

    if not already_running:
        t = threading.Thread(
            target=lambda: app.run(host=cfg.host, port=cfg.port,
                                   debug=False, threaded=True, use_reloader=False),
            daemon=True,
        )
        t.start()
        if not _wait_server(cfg.host, cfg.port):
            print("[启动失败] 服务未能启动", file=sys.stderr)
            return 1

    # ---- 优先用原生窗口；没有 pywebview 就退回浏览器 ----
    try:
        import webview  # noqa: F401  (探测是否安装)
    except ImportError:
        webbrowser.open(url)
        threading.Event().wait()  # 常驻，直到进程被杀
        return 0

    initial_theme = "dark" if cfg.default_theme == "dark" else "light"
    window_bg = THEME_COLORS[initial_theme]["bg"]

    # WebView2 的 cookie / localStorage 存放目录：放在软件自己的 state 下，
    # 重装、清理浏览器缓存都不会把主题 / 阅读进度带走。
    webview_data = os.path.join(_base_dir(), "state", "webview")
    try:
        os.makedirs(webview_data, exist_ok=True)
    except OSError:
        webview_data = None

    icon_path = os.path.join(_resource_dir(), "icon.ico")
    if not os.path.isfile(icon_path):
        icon_path = None

    api = AppApi(initial_theme)
    window = webview.create_window(
        APP_TITLE,
        url,
        width=1200,
        height=820,
        min_size=(900, 600),
        background_color=window_bg,  # 与当前主题一致，消除加载时的白底闪烁
        text_select=True,            # 【关键】允许选中正文（划线 / 翻译 / 词典都靠它）
        js_api=api,
    )
    api.attach(window)

    webview.start(
        func=_after_start,
        args=(window, api),
        private_mode=False,          # 【关键】保留 localStorage（主题 / 字号 / 进度）
        storage_path=webview_data,
        icon=icon_path,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
