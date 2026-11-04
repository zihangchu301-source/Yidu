# -*- coding: utf-8 -*-
"""
config.py —— 配置加载层
================================
职责：
    读取并校验 config.ini，把配置变成程序里可用的 Config 对象。

设计原则（方便其它 AI / 人修改）：
    1. 所有可调项集中在 config.ini，代码中不写死 Key / URL / 模型。
    2. 其它模块只依赖 Config 对象的字段，不直接解析 ini。
    3. 加载时做基本校验，错误信息用中文，方便零基础用户定位问题。
"""

from __future__ import annotations

import configparser
import os
import re
import sys
from dataclasses import dataclass

# ---- 基准目录 ----
# 普通 .py 运行时：与代码同目录
# 被打包成 exe 后（PyInstaller）：__file__ 会指向临时解压目录，数据写进去
# 会随退出丢失，所以改用 exe 所在目录，让书库 / 进度库跟 exe 放在一起。
# 安卓（Chaquopy）：代码打包在只读资源里，数据必须写到应用私有目录，
# 启动时通过环境变量 YIDU_HOME 把可写目录指进来。
_ENV_HOME = os.environ.get("YIDU_HOME")
if _ENV_HOME:
    _BASE_DIR = os.path.abspath(_ENV_HOME)
elif getattr(sys, "frozen", False):
    _BASE_DIR = os.path.dirname(os.path.abspath(sys.executable))
else:
    _BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# config.ini 默认与基准目录同目录
DEFAULT_CONFIG_PATH = os.path.join(_BASE_DIR, "config.ini")

# 用户忘记修改配置时的占位符
_PLACEHOLDER_API_KEYS = {"", "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}


class ConfigError(Exception):
    """配置错误（缺项 / 类型非法 / 文件不存在）。"""


@dataclass
class Config:
    """程序运行时配置（字段与 config.ini 一一对应）。"""

    # ---- [api] ----
    api_key: str
    base_url: str
    model: str

    # ---- [translation] ----
    max_workers: int
    max_chars_per_req: int
    request_timeout: int
    max_retries: int
    retry_wait_base: float
    glossary_sample: int
    summary_window: int
    temperature: float

    # ---- [server] ----
    host: str
    port: int
    auto_open_browser: bool

    # ---- [ui] ----
    default_font_size: int
    default_theme: str

    # ---- 派生路径 ----
    state_dir: str         # 数据库目录
    books_dir: str         # 书库目录（存放导入的 epub 及其资源）

    @property
    def db_path(self) -> str:
        """SQLite 数据库文件路径。"""
        return os.path.join(self.state_dir, "reader.db")


def save_theme(path: str, theme: str) -> None:
    """
    把用户选择的主题写回 config.ini 的 [ui] default_theme。

    为什么要写回文件：桌面版用的是 pywebview 的独立 WebView2 配置目录，
    如果只记 localStorage，重装 / 清理缓存 / 换配置目录后主题就丢了；
    写在 config.ini 里还能让页面首屏直接按深色渲染，不会先白一下再变黑。

    同样采用“按行替换”，保留文件里的中文注释。
    """
    theme = "dark" if str(theme).strip().lower() == "dark" else "light"

    with open(path, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    pattern = re.compile(r"^(\s*default_theme\s*=\s*).*$")
    ui_start = None
    ui_end = len(lines)
    found = False

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            if ui_start is not None and ui_end == len(lines):
                ui_end = i
            if stripped == "[ui]":
                ui_start = i
                ui_end = len(lines)
            continue
        if ui_start is not None and pattern.match(line):
            lines[i] = pattern.sub(lambda m: m.group(1) + theme, line)
            found = True
            break

    if not found:
        if ui_start is None:
            # 没有 [ui] 段：在文件末尾补一段
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.extend(["\n[ui]\n", f"default_theme = {theme}\n"])
        else:
            # 有 [ui] 段但没有这一项：插在该段末尾
            lines.insert(ui_end, f"default_theme = {theme}\n")

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)


def save_api_settings(path: str, api_key: str, base_url: str, model: str) -> None:
    """
    把 [api] 段落里的 api_key / base_url / model 写回 config.ini。

    为什么不用 configparser 写回：configparser 会把文件里的**中文注释全部丢掉**，
    而 config.ini 里的注释对用户（和下一个 AI）很重要。所以这里用"按行替换"的方式，
    只改这三行的值，其余内容（注释、其它段落）原样保留。

    :raises OSError: 文件不可写
    """
    with open(path, "r", encoding="utf-8-sig") as f:
        lines = f.readlines()

    def _replace_in_api_section(key: str, value: str) -> bool:
        """在 [api] 段落里把 `key = ...` 这一行的值换掉；成功返回 True。"""
        in_api = False
        pattern = re.compile(r"^(\s*" + re.escape(key) + r"\s*=\s*).*$")
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                in_api = stripped == "[api]"
                continue
            if in_api and pattern.match(line):
                lines[i] = pattern.sub(lambda m: m.group(1) + value, line)
                return True
        return False

    found_any = False
    for key, value in (("api_key", api_key), ("base_url", base_url), ("model", model)):
        if _replace_in_api_section(key, value):
            found_any = True

    # 极端情况：config.ini 里没有 [api] 段或没有这些键 → 补一段到文件末尾
    if not found_any:
        lines.append("\n[api]\n")
        lines.append(f"api_key = {api_key}\n")
        lines.append(f"base_url = {base_url}\n")
        lines.append(f"model = {model}\n")

    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)


# ----------------------------------------------------------------------
# 小工具：按类型读配置项 —— 缺段 / 缺项用默认值，类型不对给中文提示
# ----------------------------------------------------------------------
# kind → (ConfigParser 里对应的读取方法名, 出错提示里对该类型的叫法)
_KINDS = {
    str: ("get", "文本"),
    int: ("getint", "整数"),
    float: ("getfloat", "数字"),
    bool: ("getboolean", "true/false"),
}


def _get(cp: configparser.ConfigParser, section: str, option: str, default, kind=str):
    """读一个配置项：缺段 / 缺项返回 default，类型非法抛中文 ConfigError。"""
    method, name = _KINDS[kind]
    try:
        value = getattr(cp, method)(section, option)
    except (configparser.NoSectionError, configparser.NoOptionError):
        return default
    except ValueError as exc:
        raise ConfigError(f"配置项 [{section}] {option} 必须是{name}：{exc}") from exc
    return value.strip() if kind is str else value


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------
def load_config(path: str | None = None) -> Config:
    """
    加载 config.ini 并返回 Config。

    :param path: 配置文件路径，默认使用代码同目录的 config.ini
    :raises ConfigError: 文件不存在或关键项缺失
    """
    path = path or DEFAULT_CONFIG_PATH
    if not os.path.isfile(path):
        raise ConfigError(f"未找到配置文件：{path}\n请先填写 config.ini。")

    cp = configparser.ConfigParser()
    cp.optionxform = str  # 保留键名原始大小写
    cp.read(path, encoding="utf-8-sig")

    if not cp.has_section("api"):
        raise ConfigError("config.ini 缺少 [api] 段落。")

    api_key = _get(cp, "api", "api_key", "")
    base_url = _get(cp, "api", "base_url", "")
    model = _get(cp, "api", "model", "")

    # ---- 必填校验（给出可操作的中文提示）----
    if api_key in _PLACEHOLDER_API_KEYS:
        raise ConfigError("请在 config.ini 的 [api] api_key 中填写你的 API Key。")
    if not base_url:
        raise ConfigError("请在 config.ini 的 [api] base_url 中填写 Base URL（以 /v1 结尾）。")
    if not base_url.startswith(("http://", "https://")):
        raise ConfigError("base_url 必须是以 http:// 或 https:// 开头的完整地址。")
    if not model:
        raise ConfigError("请在 config.ini 的 [api] model 中填写模型名称。")

    # ---- 派生路径 ----
    base_dir = _BASE_DIR
    state_dir = os.path.join(base_dir, "state")
    books_dir = os.path.join(base_dir, "static", "books")
    os.makedirs(state_dir, exist_ok=True)
    os.makedirs(books_dir, exist_ok=True)

    theme = _get(cp, "ui", "default_theme", "light").lower()
    if theme not in ("light", "dark"):
        theme = "light"

    return Config(
        # [api]
        api_key=api_key,
        base_url=base_url.rstrip("/"),
        model=model,
        # [translation]
        max_workers=max(1, _get(cp, "translation", "max_workers", 5, int)),
        max_chars_per_req=max(200, _get(cp, "translation", "max_chars_per_req", 1800, int)),
        request_timeout=max(10, _get(cp, "translation", "request_timeout", 120, int)),
        max_retries=max(1, _get(cp, "translation", "max_retries", 6, int)),
        retry_wait_base=max(0.5, _get(cp, "translation", "retry_wait_base", 2, float)),
        glossary_sample=max(10, _get(cp, "translation", "glossary_sample", 120, int)),
        summary_window=max(1, _get(cp, "translation", "summary_window", 8, int)),
        temperature=_get(cp, "translation", "temperature", 0.3, float),
        # [server]
        host=_get(cp, "server", "host", "127.0.0.1") or "127.0.0.1",
        port=_get(cp, "server", "port", 5000, int),
        auto_open_browser=_get(cp, "server", "auto_open_browser", True, bool),
        # [ui]
        default_font_size=_get(cp, "ui", "default_font_size", 19, int),
        default_theme=theme,
        # 派生
        state_dir=state_dir,
        books_dir=books_dir,
    )