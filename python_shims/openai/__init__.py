# -*- coding: utf-8 -*-
"""
openai 兼容层（安卓版专用）
==========================
为什么需要它：
    官方 openai 包依赖 pydantic-core（Rust 编译的原生模块），
    Chaquopy（安卓上的 CPython）装不上。

这个模块只实现本项目真正用到的那一小块接口，行为与官方包一致：
    client = OpenAI(api_key=..., base_url=..., timeout=...)
    resp = client.chat.completions.create(model=..., messages=..., temperature=...,
                                          response_format={"type": "json_object"})
    text = resp.choices[0].message.content

异常类型名也与官方一致（AuthenticationError / RateLimitError / ...），
因此 translator.py 里按异常分类的代码无需改动。

桌面版 / exe 版仍然使用官方 openai 包——只有安卓构建的 python 路径里
放了这个目录。
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request

__all__ = [
    "OpenAI",
    "OpenAIError",
    "APIError",
    "APIStatusError",
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "RateLimitError",
    "APIConnectionError",
    "APITimeoutError",
]


# ----------------------------------------------------------------------
# 异常体系（与官方包同名，方便 isinstance 判断）
# ----------------------------------------------------------------------
class OpenAIError(Exception):
    """所有异常的基类。"""


class APIError(OpenAIError):
    """接口返回错误。"""


class APIStatusError(APIError):
    """带 HTTP 状态码的错误。"""

    status_code: int | None

    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class BadRequestError(APIStatusError):
    """400：请求参数有问题（例如不支持 response_format）。"""


class AuthenticationError(APIStatusError):
    """401：API Key 不对。"""


class PermissionDeniedError(APIStatusError):
    """403：没有权限 / 余额不足。"""


class RateLimitError(APIStatusError):
    """429：限流。"""


class APIConnectionError(APIError):
    """网络不通。"""


class APITimeoutError(APIConnectionError):
    """请求超时。"""


# ----------------------------------------------------------------------
# 返回值对象（只保留用得到的字段）
# ----------------------------------------------------------------------
class _Message:
    def __init__(self, content: str) -> None:
        self.content = content


class _Choice:
    def __init__(self, content: str) -> None:
        self.message = _Message(content)


class _Response:
    def __init__(self, content: str) -> None:
        self.choices = [_Choice(content)]


# ----------------------------------------------------------------------
# 客户端
# ----------------------------------------------------------------------
class _Completions:
    def __init__(self, owner: "OpenAI") -> None:
        self._owner = owner

    def create(self, **kwargs):
        if self._owner.api_key in (None, ""):
            raise AuthenticationError("未配置 API Key。", 401)
        url = self._owner.base_url.rstrip("/") + "/chat/completions"
        payload = {k: v for k, v in kwargs.items() if v is not None}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._owner.api_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self._owner.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            message = f"HTTP {exc.code}: {detail}"
            if exc.code == 400:
                raise BadRequestError(message, 400) from exc
            if exc.code == 401:
                raise AuthenticationError(message, 401) from exc
            if exc.code == 403:
                raise PermissionDeniedError(message, 403) from exc
            if exc.code == 429:
                raise RateLimitError(message, 429) from exc
            raise APIStatusError(message, exc.code) from exc
        except socket.timeout as exc:
            raise APITimeoutError("请求超时。") from exc
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            if isinstance(reason, socket.timeout):
                raise APITimeoutError("请求超时。") from exc
            raise APIConnectionError(f"网络连接失败：{reason}") from exc
        except OSError as exc:
            raise APIConnectionError(f"网络连接失败：{exc}") from exc

        try:
            data = json.loads(raw)
            content = data["choices"][0]["message"]["content"] or ""
        except Exception as exc:
            raise APIError(f"返回内容无法解析：{raw[:200]}") from exc
        return _Response(content)


class _Chat:
    def __init__(self, owner: "OpenAI") -> None:
        self.completions = _Completions(owner)


class OpenAI:
    """与官方 openai.OpenAI 用法一致的极简实现。"""

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 timeout: float = 60, **_: object) -> None:
        self.api_key = api_key
        self.base_url = base_url or "https://api.openai.com/v1"
        self.timeout = timeout
        self.chat = _Chat(self)
