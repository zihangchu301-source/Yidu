# -*- coding: utf-8 -*-
"""
translator.py —— AI 翻译层
===========================
职责：所有“和大模型打交道”的逻辑都在这里，包含四件事：
    1. 生成术语表（人名/地名/专有名词 → 统一中文译名）
    2. 批量翻译全书段落（拼批 + JSON 数组对齐 + 并发 + 重试 + 前文摘要）
    3. 点词/句的即时翻译（按需，带本地缓存）
    4. 生成“前文摘要”，让跨段落翻译保持连贯

异常设计（重要）：
    * FatalAPIError    —— 不可重试（Key 无效、余额不足、参数错误）。立刻停止并提示用户。
    * RetryableAPIError—— 可重试（超时、限流 429、服务器 5xx）。由 tenacity 自动退避重试。
    这样能把“用户需要处理的问题”和“等一下就好”的问题区分开。

调用的大模型接口是 OpenAI 兼容格式，因此换服务商只需改 config.ini。
"""

from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Dict, List, Optional

import openai
from openai import OpenAI
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from state_manager import STATUS_DONE, STATUS_FAILED, hash_text


# ======================================================================
# 异常：把“能不能重试”这件事显式表达出来
# ======================================================================
class FatalAPIError(Exception):
    """不可重试的错误（需要用户介入，如 Key/余额/请求参数问题）。"""


class RetryableAPIError(Exception):
    """可重试的错误（网络抖动、限流、服务端临时故障）。"""


# ======================================================================
# 提示词（Prompt）集中放在这里，方便统一修改
# ======================================================================
SYSTEM_TRANSLATE = (
    "你是一位资深文学翻译家，负责把一本英文书逐段翻译成流畅自然、符合中文阅读习惯的中文。\n"
    "你会收到一个 JSON 对象，包含三个字段：\n"
    "  - glossary：术语表（英文 -> 中文），你必须严格遵守；\n"
    "  - summary：前文摘要，帮助你理解上下文；\n"
    "  - segments：待翻译的英文文本数组，每一项是一小段（可能是句子或短语）。\n"
    "要求：\n"
    "  1. 严格按顺序逐项翻译，不得合并或拆分，返回数组长度必须与 segments 完全一致；\n"
    "  2. 严格遵守术语表中的译名，不得自行更改；\n"
    "  3. 结合 summary 与前后语义，保证译文连贯、自然、可读；\n"
    "  4. 不要输出任何解释性文字，只返回 JSON：{\"translations\": [\"...\", \"...\"]}。"
)

SYSTEM_ON_DEMAND = (
    "你是一位资深翻译。用户会给出一个英文单词或句子（可能附带上下文）。\n"
    "请给出准确、自然的中文翻译：\n"
    "  - 若是单词：给出最贴切的词义，可附极简释义（用中文分号分隔多个义项）；\n"
    "  - 若是句子：直接给出通顺的中文译文。\n"
    "只输出译文本身，不要任何解释、不要加引号。"
)

SYSTEM_GLOSSARY = (
    "你是图书翻译项目的术语管理员。请从给定的英文片段中找出主要的人名、地名、专有名词，"
    "以及反复出现的关键词，并给出统一、准确的中文译名。\n"
    "只输出 JSON，格式为：{\"terms\": [{\"en\": \"Harry\", \"zh\": \"哈利\"}, ...]}。\n"
    "不要输出任何解释性文字。"
)

SYSTEM_DICTIONARY = (
    "你是一部权威的英汉词典。用户会给你一个英文单词或短语，请给出词条解释。\n"
    "只输出 JSON，格式如下（不要输出任何解释性文字）：\n"
    "{\n"
    '  "word": "词条原形",\n'
    '  "phonetic": "音标（英式或美式，不知道就留空字符串）",\n'
    '  "entries": [{"pos": "词性，如 n. / v. / adj. / phr.", "meaning": "中文释义"}],\n'
    '  "example": "一个英文例句（可选，没有就留空字符串）",\n'
    '  "example_zh": "上面例句的中文翻译（可选）"\n'
    "}\n"
    "要求：\n"
    "  1. entries 给出 1~4 个最常用的义项，按常用程度排序；\n"
    "  2. 释义要精炼准确、符合中文词典的表达习惯（不要长篇解释）；\n"
    "  3. 如果是短语/固定搭配，pos 用 phr. 并给出整体意思。"
)

SYSTEM_SUMMARY = (
    "请用一小段中文概括以下英文内容的情节要点，突出人物、地点、事件与关系，"
    "用于后续翻译时保持上下文连贯。只输出概括本身，不要解释。"
)


# ======================================================================
# 辅助函数
# ======================================================================
def _classify_error(exc: Exception) -> Exception:
    """把底层异常翻译成“可重试 / 不可重试”，并给出中文原因。"""
    # 鉴权 / 权限：Key 错了或没权限
    if isinstance(exc, openai.AuthenticationError):
        return FatalAPIError("API Key 无效或已失效，请检查 config.ini 的 api_key。")
    if isinstance(exc, openai.PermissionDeniedError):
        return FatalAPIError("该 API Key 没有调用该模型的权限，请检查账号或模型名称。")

    # 状态码类错误
    if isinstance(exc, openai.RateLimitError):
        return RetryableAPIError("触发服务限流（429），稍等将自动重试。")
    if isinstance(exc, openai.APIStatusError):
        code = getattr(exc, "status_code", None)
        if code == 402:
            return FatalAPIError("API 账户余额不足，请充值后再试。")
        if code == 401:
            return FatalAPIError("API Key 无效（401），请检查 config.ini。")
        if code == 403:
            return FatalAPIError("访问被拒绝（403），请检查账号权限或模型名称。")
        if code == 400:
            return FatalAPIError(f"请求被拒绝（400）：{exc}")
        if code is not None and 500 <= code < 600:
            return RetryableAPIError(f"服务端错误（{code}），将自动重试。")
        return FatalAPIError(f"API 返回错误（{code}）：{exc}")

    # 网络类错误
    if isinstance(exc, (openai.APITimeoutError, openai.APIConnectionError)):
        return RetryableAPIError("网络超时或连接失败，将自动重试。")

    # 其它未知错误：保守地当作可重试
    return RetryableAPIError(f"调用失败：{exc}")


def test_connection(api_key: str, base_url: str, model: str, timeout: int = 30) -> str:
    """
    用给定的配置发一次**最小请求**，验证 Key / 接口地址 / 模型名能不能用。

    供「设置」面板里的「测试连接」按钮调用。成功返回一句提示文字；
    失败则抛出 FatalAPIError / RetryableAPIError（错误信息已是中文，可直接提示用户）。
    """
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
    try:
        client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "请只回复两个字：成功"}],
        )
    except Exception as exc:  # 交给统一的错误分类器翻译成中文
        raise _classify_error(exc)
    return "连接成功"


def _extract_json(text: str) -> dict:
    """
    从模型回复中稳妥地解析出 JSON 对象。
    兼容 ```json 代码块包裹、前后有多余文字等情况。
    """
    text = (text or "").strip()
    # 去掉 ```json ... ``` 围栏
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except Exception:
        pass
    # 兜底：截取第一个 { 到最后一个 }
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        return json.loads(text[start:end + 1])
    raise ValueError("无法从模型回复中解析出 JSON。")


def _make_batches(segments: List[dict], max_chars: int) -> List[List[dict]]:
    """
    把段落按顺序拼成一批一批的（贪心装箱）：每批源文字符数不超过 max_chars。
    这样能在“省请求”和“不超长”之间取得平衡。
    """
    batches: List[List[dict]] = []
    cur: List[dict] = []
    cur_len = 0
    for seg in segments:
        length = len(seg["source"])
        if cur and cur_len + length > max_chars:
            batches.append(cur)
            cur, cur_len = [], 0
        cur.append(seg)
        cur_len += length
    if cur:
        batches.append(cur)
    return batches


# ======================================================================
# 翻译器
# ======================================================================
class Translator:
    """封装大模型调用；构造后即可用于全文翻译与点词翻译。"""

    def __init__(self, cfg, store):
        self.cfg = cfg
        self.store = store
        self.client = OpenAI(
            api_key=cfg.api_key,
            base_url=cfg.base_url,
            timeout=cfg.request_timeout,
        )
        # 动态构建“带退避重试”的聊天函数（重试次数来自配置）
        self._chat = retry(
            stop=stop_after_attempt(cfg.max_retries),
            wait=wait_exponential(multiplier=cfg.retry_wait_base,
                                  min=cfg.retry_wait_base, max=60),
            retry=retry_if_exception_type(RetryableAPIError),
            reraise=True,
        )(self._raw_chat)

    # ------------------------------------------------------------------
    # 底层：一次聊天调用
    # ------------------------------------------------------------------
    def _raw_chat(self, messages: List[dict], json_mode: bool = False,
                  temperature: Optional[float] = None) -> str:
        """真正发起一次 API 请求；异常已分类为 Fatal/Retryable。"""
        kwargs = {
            "model": self.cfg.model,
            "messages": messages,
            "temperature": self.cfg.temperature if temperature is None else temperature,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            resp = self.client.chat.completions.create(**kwargs)
        except openai.BadRequestError:
            # 有些服务商不支持 response_format，去掉后重试一次
            if json_mode:
                kwargs.pop("response_format", None)
                try:
                    resp = self.client.chat.completions.create(**kwargs)
                except Exception as exc2:
                    raise _classify_error(exc2)
            else:
                raise
        except Exception as exc:
            raise _classify_error(exc)

        return (resp.choices[0].message.content or "").strip()

    # ------------------------------------------------------------------
    # 1) 生成术语表
    # ------------------------------------------------------------------
    def generate_glossary(self, segments: List[dict]) -> Dict[str, str]:
        """
        从全书抽样，让模型总结人名/地名/专名对照表。

        :return: {"Harry": "哈利", ...}；失败时返回空字典（不阻断翻译）
        """
        texts = [s["source"].strip() for s in segments if s["source"].strip()]
        if not texts:
            return {}

        # 等距抽样，控制 token 成本
        n = self.cfg.glossary_sample
        if len(texts) > n:
            step = len(texts) / n
            sample = [texts[int(i * step)] for i in range(n)]
        else:
            sample = texts

        joined = "\n".join(sample)[:15000]
        try:
            reply = self._chat(
                [
                    {"role": "system", "content": SYSTEM_GLOSSARY},
                    {"role": "user", "content": joined},
                ],
                json_mode=True,
            )
            data = _extract_json(reply)
            terms = data.get("terms", [])
            glossary = {}
            for item in terms:
                en, zh = item.get("en"), item.get("zh")
                if en and zh:
                    glossary[str(en).strip()] = str(zh).strip()
            return glossary
        except FatalAPIError:
            raise  # 鉴权/余额问题必须让用户知道
        except Exception:
            return {}  # 其它情况不阻断，只是没有术语表

    # ------------------------------------------------------------------
    # 2) 批量翻译
    # ------------------------------------------------------------------
    def translate_batch(self, texts: List[str], glossary: dict, summary: str) -> List[str]:
        """
        一次翻译多段文本，要求返回等长的译文数组。
        返回数量不一致时会重试，最多 3 次，仍不一致则抛异常（由上层降级处理）。
        """
        payload = {
            "glossary": glossary or {},
            "summary": summary or "",
            "segments": texts,
        }
        user_content = json.dumps(payload, ensure_ascii=False)

        for _ in range(3):
            reply = self._chat(
                [
                    {"role": "system", "content": SYSTEM_TRANSLATE},
                    {"role": "user", "content": user_content},
                ],
                json_mode=True,
            )
            data = _extract_json(reply)
            translations = data.get("translations")
            if isinstance(translations, list) and len(translations) == len(texts):
                return [str(t) for t in translations]
        raise RetryableAPIError("模型返回的段落数量与请求不一致，已放弃该批次。")

    def _translate_batch_safe(self, batch: List[dict], glossary: dict, summary: str) -> List[dict]:
        """
        翻译一批，并保证一定返回结果（永不抛异常）。
        批次整体失败时，降级为“逐段单独翻译”，尽量多救回一些段落。
        """
        texts = [seg["source"] for seg in batch]
        try:
            translations = self.translate_batch(texts, glossary, summary)
            return [
                {"index": seg["seg_index"], "translated": t, "status": STATUS_DONE}
                for seg, t in zip(batch, translations)
            ]
        except FatalAPIError:
            raise  # 鉴权/余额问题直接向上抛，终止整个任务
        except Exception:
            # 降级：逐段翻译
            results = []
            for seg in batch:
                try:
                    t = self.translate_phrase(seg["source"], context=summary, use_cache=False)
                    results.append({"index": seg["seg_index"], "translated": t, "status": STATUS_DONE})
                except FatalAPIError:
                    raise
                except Exception:
                    results.append({"index": seg["seg_index"], "translated": "", "status": STATUS_FAILED})
            return results

    # ------------------------------------------------------------------
    # 3) 点词/句翻译（按需 + 缓存）
    # ------------------------------------------------------------------
    def translate_phrase(self, text: str, context: str = "", use_cache: bool = True) -> str:
        """
        翻译用户选中的单词或句子。

        :param use_cache: 是否使用/写入本地缓存（全文翻译的降级路径可关掉）
        """
        text = (text or "").strip()
        if not text:
            return ""

        cache_key = hash_text(text)
        if use_cache:
            cached = self.store.get_phrase(cache_key)
            if cached is not None:
                return cached

        user_content = text
        if context:
            user_content = f"【上下文】{context[:500]}\n\n【待翻译】{text}"

        result = self._chat(
            [
                {"role": "system", "content": SYSTEM_ON_DEMAND},
                {"role": "user", "content": user_content},
            ],
            json_mode=False,
        ).strip()

        if use_cache and result:
            self.store.set_phrase(cache_key, text, result)
        return result

    # ------------------------------------------------------------------
    # 词典：查一个单词 / 短语的英汉释义（带本地缓存）
    # ------------------------------------------------------------------
    def lookup_word(self, text: str) -> dict:
        """
        查词典：返回结构化词条 {"word", "phonetic", "entries":[{pos, meaning}], "example", "example_zh"}。

        结果缓存在 phrase_cache 表里（键加了 dict| 前缀，和点词翻译的缓存分开），
        所以同一个词查第二次不再花钱。
        """
        text = (text or "").strip()
        if not text:
            return {}

        cache_key = hash_text("dict|" + text.lower())
        cached = self.store.get_phrase(cache_key)
        if cached:
            try:
                return json.loads(cached)
            except json.JSONDecodeError:
                pass  # 缓存坏了就重新查

        reply = self._chat(
            [
                {"role": "system", "content": SYSTEM_DICTIONARY},
                {"role": "user", "content": text},
            ],
            json_mode=True,
        )
        data = _extract_json(reply)

        # 规范化成前端好渲染的结构（模型偶尔会缺字段）
        entries = []
        for item in data.get("entries") or []:
            if isinstance(item, dict):
                meaning = str(item.get("meaning") or "").strip()
                if meaning:
                    entries.append({
                        "pos": str(item.get("pos") or "").strip(),
                        "meaning": meaning,
                    })
        entry = {
            "word": str(data.get("word") or text).strip(),
            "phonetic": str(data.get("phonetic") or "").strip(),
            "entries": entries,
            "example": str(data.get("example") or "").strip(),
            "example_zh": str(data.get("example_zh") or "").strip(),
        }

        self.store.set_phrase(cache_key, text, json.dumps(entry, ensure_ascii=False))
        return entry

    # ------------------------------------------------------------------
    # 4) 前文摘要
    # ------------------------------------------------------------------
    def _summarize(self, prev_summary: str, new_text: str) -> str:
        """把“已有摘要 + 新增内容”压缩成一份新的中文摘要。"""
        user_content = (
            f"【已有摘要】\n{prev_summary or '（暂无）'}\n\n"
            f"【新增内容】\n{new_text[:6000]}"
        )
        return self._chat(
            [
                {"role": "system", "content": SYSTEM_SUMMARY},
                {"role": "user", "content": user_content},
            ]
        ).strip()

    # ------------------------------------------------------------------
    # 内部：确保术语表存在（没有则按全书抽样生成一次并写入 meta）
    # ------------------------------------------------------------------
    def _ensure_glossary(self, book_hash: str, all_segments: List[dict]) -> dict:
        """
        取本书术语表；不存在时生成一次并落库，保证“全文翻译”与“按章翻译”口径一致。

        术语表一旦生成就永久复用 —— 这也是为什么前面用户已经翻过一部分的书，
        切到「对照」按章补翻时不会换一套译名。
        """
        glossary = self.store.get_glossary(book_hash)
        if glossary is None:
            glossary = self.generate_glossary(all_segments)
            self.store.set_glossary(book_hash, glossary)
        return glossary

    # ------------------------------------------------------------------
    # 内部：核心翻译循环（全文翻译 / 按章翻译共用）
    # ------------------------------------------------------------------
    def _translate_segments(
        self,
        book_hash: str,
        pending: List[dict],
        glossary: dict,
        summary: str,
        cancel_event: Optional[threading.Event],
        progress_cb: Optional[Callable[[int, int, int], None]],
        done_count: int,
        total: int,
        update_summary: bool,
    ):
        """
        翻译给定的一批“待译段落”：分批 + 线程池并发 + 每批立刻落库。

        抽出来是为了让「全文翻译」和「按章翻译」共用同一套分批 / 并发 / 重试 / 降级逻辑，
        避免两处实现漂移（改了一处忘另一处）。

        :param done_count: 计数起点（已完成段数），便于进度回调显示整体进度
        :param total: 进度回调里用的“总数”
        :param update_summary: 是否滚动更新前文摘要（整本书顺序翻译需要；按章补翻不需要）
        :return: (done_count, failed_count, cancelled)
        """
        batches = _make_batches(pending, self.cfg.max_chars_per_req)
        failed_count = 0
        cancelled = False

        # 每个“轮次”并发处理 max_workers 个批次；轮次之间更新摘要，保证顺序感
        with ThreadPoolExecutor(max_workers=self.cfg.max_workers) as pool:
            batches_since_summary = 0
            for i in range(0, len(batches), self.cfg.max_workers):
                if cancel_event is not None and cancel_event.is_set():
                    cancelled = True
                    break
                chunk = batches[i:i + self.cfg.max_workers]
                futures = [
                    pool.submit(self._translate_batch_safe, b, glossary, summary)
                    for b in chunk
                ]

                for fut in as_completed(futures):
                    results = fut.result()  # FatalAPIError 会在此抛出并终止
                    self.store.save_results_bulk(book_hash, results)  # 每批立刻落库
                    for r in results:
                        if r["status"] == STATUS_DONE:
                            done_count += 1
                        else:
                            failed_count += 1
                if progress_cb is not None:
                    progress_cb(done_count, failed_count, total)

                # ---- 每隔若干批更新一次前文摘要（仅整本书顺序翻译需要）----
                if update_summary:
                    batches_since_summary += len(chunk)
                    if batches_since_summary >= self.cfg.summary_window:
                        try:
                            src_text = " ".join(seg["source"] for b in chunk for seg in b)
                            summary = self._summarize(summary, src_text)
                            self.store.set_summary(book_hash, summary)
                        except Exception:
                            pass  # 摘要失败不影响主流程
                        batches_since_summary = 0

        return done_count, failed_count, cancelled

    # ------------------------------------------------------------------
    # 全文翻译总调度
    # ------------------------------------------------------------------
    def translate_book(
        self,
        book_hash: str,
        cancel_event: threading.Event,
        progress_cb: Callable[[int, int, int], None],
    ) -> dict:
        """
        翻译整本书。支持断点续传：已完成的段落会自动跳过。

        :param cancel_event: 置位后会在当前批次结束后停止
        :param progress_cb: progress_cb(已完成数, 失败数, 总需翻译数)
        :return: {"total", "done", "failed", "cancelled"}
        """
        segments = self.store.get_segments(book_hash)
        done_map = self.store.get_done_map(book_hash)

        # 待翻译 = 有内容 且 尚未完成
        translatable = [s for s in segments if s["source"].strip()]
        pending = [s for s in translatable if s["seg_index"] not in done_map]
        total = len(translatable)
        done_count = total - len(pending)

        if not pending:
            progress_cb(done_count, 0, total)
            return {"total": total, "done": done_count, "failed": 0, "cancelled": False}

        # ---- 术语表（已有就不重复生成）；前文摘要 ----
        glossary = self._ensure_glossary(book_hash, segments)
        summary = self.store.get_summary(book_hash)

        done_count, failed_count, cancelled = self._translate_segments(
            book_hash, pending, glossary, summary, cancel_event, progress_cb,
            done_count, total, update_summary=True,
        )
        return {
            "total": total,
            "done": done_count,
            "failed": failed_count,
            "cancelled": cancelled,
        }

    # ------------------------------------------------------------------
    # 按章翻译（阅读器「对照」模式按需补齐译文）
    # ------------------------------------------------------------------
    def translate_chapter(
        self,
        book_hash: str,
        chapter_index: int,
        cancel_event: Optional[threading.Event] = None,
        progress_cb: Optional[Callable[[int, int, int], None]] = None,
    ) -> dict:
        """
        只翻译某一章里“尚未完成”的段落，供阅读器「对照」模式按需补齐。

        与全文翻译共用术语表 / 分批 / 并发 / 重试逻辑，区别：
          * 只处理这一章（用户在读哪章就翻哪章，省 token）；
          * 不更新前文摘要（摘要服务的是整本书的顺序翻译）；
          * 已完成的段落直接跳过，不重复花钱。

        :return: {"total", "done", "failed", "cancelled"}
        """
        segments = self.store.get_segments(book_hash)
        chapter_segments = [
            s for s in segments
            if s["chapter_index"] == chapter_index and s["source"].strip()
        ]
        total = len(chapter_segments)
        if not chapter_segments:
            return {"total": 0, "done": 0, "failed": 0, "cancelled": False}

        done_map = self.store.get_done_map(book_hash)
        pending = [s for s in chapter_segments if s["seg_index"] not in done_map]
        if not pending:
            return {"total": total, "done": 0, "failed": 0, "cancelled": False}

        glossary = self._ensure_glossary(book_hash, segments)
        summary = self.store.get_summary(book_hash)

        done_count, failed_count, cancelled = self._translate_segments(
            book_hash, pending, glossary, summary, cancel_event, progress_cb,
            0, len(pending), update_summary=False,
        )
        return {
            "total": total,
            "done": done_count,
            "failed": failed_count,
            "cancelled": cancelled,
        }