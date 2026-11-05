# -*- coding: utf-8 -*-
"""
server.py —— 服务层（Flask 路由）
==================================
职责：做“网页界面”和“后台逻辑”之间的桥梁。网页里的每一次点击，
      最终都是调用这里的一个接口（API）。

接口一览（前端 app.js 里会用到）：
    书库
      GET    /api/books                       列出书库
      POST   /api/books/import                导入一本 EPUB（上传文件）
      DELETE /api/books/<hash>                删除一本书
      POST   /api/books/<hash>/readtime       阅读时长心跳上报（前端每 30 秒一次）
    阅读
      GET    /api/books/<hash>/chapters       章节列表（目录）
      GET    /api/books/<hash>/chapter/<n>    获取第 n 章正文 + 中文缓存 + 划线
      POST   /api/books/<hash>/locate         按词在原文里找位置（老查词记录跳回原文用）
    朗读
      POST   /api/tts                         英语朗读：把一句英文合成 WAV 音频
    翻译
      POST   /api/translate                   点词/句即时翻译
      POST   /api/dictionary                  查词典（单词/短语的英汉释义，带缓存）
      GET    /api/dictionary/history          查词记录（词典面板里按书分组显示"查过哪些词"）
      DELETE /api/dictionary/history          清空查词记录
      DELETE /api/dictionary/history/word     删除单个词的查词记录（?word=）
      POST   /api/books/<hash>/chapter/<n>/translate  按需翻译某一章（「对照」模式自动补齐用）
      POST   /api/books/<hash>/translate      启动全文翻译（后台线程）
      GET    /api/books/<hash>/translate/progress   查询进度
      POST   /api/books/<hash>/translate/cancel     取消翻译
    标注
      GET    /api/books/<hash>/annotations    列出书签/笔记/划线
      POST   /api/books/<hash>/annotations    新增一条
      DELETE /api/annotations/<id>            删除一条
    设置
      GET    /api/settings                    读取当前大模型配置（供设置面板回填）
      POST   /api/settings                    保存大模型配置（写回 config.ini 并立即生效）
      POST   /api/settings/test               用当前配置测试连接
      POST   /api/theme                       保存浅色 / 深色主题（写回 config.ini，重启后仍生效）

设计要点（方便其它 AI / 人修改）：
    * create_app(cfg) 是唯一入口，所有依赖（store/translator）挂在 app.config 上。
    * 全文翻译跑在后台线程，接口立刻返回；前端靠轮询进度接口显示进度条。
    * 每个写操作的错误都用中文返回，前端直接弹出即可。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
from typing import Dict

from bs4 import BeautifulSoup
from flask import Flask, Response, jsonify, make_response, render_template, request

from config import DEFAULT_CONFIG_PATH, save_api_settings, save_theme
from epub_processor import get_chapter_html, parse_epub
from state_manager import (
    Store,
    compute_book_hash,
    detect_language,
    ANNO_BOOKMARK,
    ANNO_HIGHLIGHT,
    ANNO_NOTE,
)
from translator import FatalAPIError, Translator, test_connection
from tts_engine import synthesize_english

# 正在进行的翻译任务：book_hash -> {"cancel": Event, "progress": dict}
JOBS: Dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()

# 「按章翻译」的串行锁：
#   用户在阅读器里快速上下滚动时会滚动加载多章，若不串行化就可能同时向大模型发多个
#   翻译请求 —— 既浪费钱又容易触发限流。用一把全局锁把“按章翻译”排队执行。
_CHAPTER_LOCK = threading.Lock()

# config.ini 的写锁：设置面板保存 / 切换主题都会改同一个文件，串行化避免写花。
_CONFIG_LOCK = threading.Lock()

# 「按词找原文位置」的缓存：老查词记录没存章节 / 段落位置时，按词在全书里搜一次。
# 键 = (book_hash, 小写单词)；一本书通常搜一次就够，后面点同一个词直接返回。
_LOCATE_CACHE: Dict[tuple, dict] = {}
_LOCATE_LOCK = threading.Lock()


# ======================================================================
# 应用工厂
# ======================================================================
def _asset_version(app: Flask) -> str:
    """
    生成前端静态资源的“版本号”，用于给 style.css / app.js 加 ?v=。
    取这两个文件的修改时间：文件一改，URL 就变，浏览器必然重新加载，
    从而根治“改了前端却因为缓存看到旧界面、必须手动强刷”的老毛病。
    """
    stamp = 0
    for name in ("style.css", "app.js", "mobile.css", "mobile.js"):
        try:
            stamp = max(stamp, int(os.path.getmtime(os.path.join(app.static_folder, name))))
        except OSError:
            pass
    return str(stamp)


def create_app(cfg, static_folder: str | None = None,
               template_folder: str | None = None) -> Flask:
    """创建并配置 Flask 应用。

    static_folder / template_folder 只在“代码与数据不在同一目录”的场景需要，
    比如安卓版（代码打包在只读资源里，static 要指向应用可写目录）。
    桌面版 / exe 版传空即可，行为与以前完全一致。
    """
    app = Flask(__name__,
                static_folder=static_folder or "static",
                template_folder=template_folder or "templates")
    app.config["CFG"] = cfg
    store = Store(cfg.db_path)
    app.config["STORE"] = store
    # 老书没有语种记录：启动时补测一次（中文书阅读器不显示翻译功能）
    store.backfill_languages()
    app.config["TRANSLATOR"] = Translator(cfg, store)
    # 让返回的中文不被转义成 \uXXXX（Flask 3 的写法）
    app.json.ensure_ascii = False

    # ------------------------------------------------------------------
    # 页面
    # ------------------------------------------------------------------
    @app.get("/")
    def index():
        resp = make_response(render_template("index.html",
                                             default_font_size=cfg.default_font_size,
                                             default_theme=cfg.default_theme,
                                             android=request.args.get("android") == "1",
                                             asset_version=_asset_version(app)))
        # 页面骨架（HTML）不缓存：改了 index.html 并重启服务后，
        # 浏览器一定能拿到新页面，不会出现“新 JS 配旧 HTML”导致的空白/报错。
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return resp

    # ------------------------------------------------------------------
    # 书库
    # ------------------------------------------------------------------
    @app.get("/api/books")
    def list_books():
        books = store.list_books()
        anno_counts = store.counts_by_book()  # 一次查询把所有书的标注数量捞出来
        for b in books:
            stats = store.stats(b["book_hash"])
            b["progress"] = {
                "total": stats["total"],
                "done": stats["done"],
                "failed": stats["failed"],
            }
            b["cover_url"] = (
                f"/static/books/{b['book_hash']}/{b['cover']}" if b.get("cover") else None
            )
            # 标注数量：书签 / 笔记功能已删除，现在只统计划线
            b["counts"] = {
                "highlight": anno_counts.get(b["book_hash"], {}).get(ANNO_HIGHLIGHT, 0),
            }
        return jsonify(books)

    @app.post("/api/books/import")
    def import_book():
        """接收上传的 EPUB，解析并落盘到书库目录。"""
        file = request.files.get("file")
        if file is None or not file.filename:
            return jsonify({"error": "没有收到文件。"}), 400
        if not file.filename.lower().endswith(".epub"):
            return jsonify({"error": "只支持 .epub 格式的电子书。"}), 400

        # 先存到临时文件，算 hash 并解析
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".epub")
        os.close(tmp_fd)
        try:
            file.save(tmp_path)
            book_hash = compute_book_hash(tmp_path)
            book_dir = os.path.join(cfg.books_dir, book_hash)

            # 已经导入过：直接返回（保证幂等）
            existing = store.get_book(book_hash)
            if existing:
                return jsonify({"book_hash": book_hash, "title": existing["title"],
                                "already_exists": True})

            data = parse_epub(tmp_path, book_hash)

            # ---- 落盘：章节、目录标题、图片、封面 ----
            os.makedirs(os.path.join(book_dir, "assets"), exist_ok=True)
            titles = {}
            for ch in data["chapters"]:
                with open(os.path.join(book_dir, f"ch_{ch['index']}.html"), "w",
                          encoding="utf-8") as f:
                    f.write(ch["html"])
                titles[str(ch["index"])] = ch["title"]
            # 目录标题单独存一份 JSON，阅读器打开目录时直接读取
            with open(os.path.join(book_dir, "titles.json"), "w", encoding="utf-8") as f:
                json.dump(titles, f, ensure_ascii=False)
            for img in data["images"]:
                try:
                    with open(os.path.join(book_dir, "assets", img["name"]), "wb") as f:
                        f.write(img["data"])
                except Exception:
                    continue
            cover_name = None
            if data["cover"]:
                cover_name = data["cover"]["name"]
                try:
                    with open(os.path.join(book_dir, cover_name), "wb") as f:
                        f.write(data["cover"]["data"])
                except Exception:
                    cover_name = None

            # ---- 登记数据库 ----
            # 语种：抽前 60 段正文判断中英文（中文书阅读器里不显示翻译入口）
            language = detect_language([s["text"] for s in data["segments"][:60]])
            store.add_book(book_hash, data["title"], data["author"], cover_name,
                           len(data["chapters"]), len(data["segments"]), language)
            store.init_segments(book_hash, data["segments"])

            return jsonify({"book_hash": book_hash, "title": data["title"],
                            "chapters": len(data["chapters"]),
                            "segments": len(data["segments"])})
        except Exception as exc:
            return jsonify({"error": f"导入失败：{exc}"}), 500
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    @app.delete("/api/books/<book_hash>")
    def delete_book(book_hash):
        # 先停掉这本书可能正在跑的全文翻译：否则删完书它还在后台继续请求 API，
        # 既白花钱，又可能把翻译结果写回一个已经不存在的书。
        with _JOBS_LOCK:
            job = JOBS.pop(book_hash, None)
        if job:
            job["cancel"].set()
        store.delete_book(book_hash)
        book_dir = os.path.join(cfg.books_dir, book_hash)
        if os.path.isdir(book_dir):
            shutil.rmtree(book_dir, ignore_errors=True)
        return jsonify({"ok": True})

    @app.post("/api/books/<book_hash>/readtime")
    def report_readtime(book_hash):
        """前端阅读页每 30 秒上报一次本段阅读秒数，存进这本书的累计时长。"""
        if not store.get_book(book_hash):
            return jsonify({"error": "书不存在。"}), 404
        data = request.get_json(silent=True) or {}
        try:
            seconds = int(data.get("seconds", 0))
        except (TypeError, ValueError):
            seconds = 0
        # 只信 1~300 秒之间的数：防止页码出错乱传大数把时长撑爆
        seconds = max(1, min(seconds, 300))
        store.add_read_seconds(book_hash, seconds)
        return jsonify({"ok": True})

    # ------------------------------------------------------------------
    # 朗读（英语书；中文书前端不显示入口）
    # ------------------------------------------------------------------
    @app.post("/api/tts")
    def tts_audio():
        """
        把一句英文合成为 WAV 音频。

        为什么放在后台：桌面版窗口（WebView2）里只能拿到中文朗读声音，
        浏览器自带的朗读念不了英文；后台用 Windows 的英文声音（如 Zira）
        合成好再交给前端用 <audio> 播放，声音才地道、也才能自由暂停 / 调语速。
        """
        data = request.get_json(silent=True) or {}
        text = (data.get("text") or "").strip()
        if not text:
            return jsonify({"error": "没有要朗读的文字。"}), 400
        if len(text) > 500:
            return jsonify({"error": "这一句太长了，朗读已跳过。"}), 400
        try:
            wav = synthesize_english(text, data.get("rate", 1))
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 500
        return Response(
            wav,
            mimetype="audio/wav",
            headers={"Cache-Control": "no-store"},
        )

    # ------------------------------------------------------------------
    # 阅读
    # ------------------------------------------------------------------
    @app.get("/api/books/<book_hash>/chapters")
    def chapters(book_hash):
        """返回目录：[{index, title}, ...]。标题来自导入时保存的 titles.json。"""
        book = store.get_book(book_hash)
        if not book:
            return jsonify({"error": "书不存在。"}), 404
        book_dir = os.path.join(cfg.books_dir, book_hash)
        titles = {}
        titles_path = os.path.join(book_dir, "titles.json")
        if os.path.isfile(titles_path):
            with open(titles_path, "r", encoding="utf-8") as f:
                titles = json.load(f)
        result = []
        for i in range(book["chapter_count"]):
            result.append({
                "index": i,
                "title": titles.get(str(i)) or f"第 {i + 1} 章",
            })
        return jsonify(result)

    @app.get("/api/books/<book_hash>/chapter/<int:chapter_index>")
    def chapter(book_hash, chapter_index):
        book = store.get_book(book_hash)
        if not book:
            return jsonify({"error": "书不存在。"}), 404
        book_dir = os.path.join(cfg.books_dir, book_hash)
        html = get_chapter_html(book_dir, chapter_index)
        if html is None:
            return jsonify({"error": "章节不存在。"}), 404
        return jsonify({
            "index": chapter_index,
            "total_chapters": book["chapter_count"],
            "html": html,
            "translations": store.get_chapter_translations(book_hash, chapter_index),
            "highlights": store.get_highlights(book_hash, chapter_index),
        })

    @app.post("/api/books/<book_hash>/locate")
    def locate_word(book_hash):
        """
        在书的原文里按词找位置，返回第一处 {chapter_index, seg_index, text}。

        用途：老版本的查词记录只记了单词、没记「在哪一章哪一段查的」，
        用户点词条想跳回原文时，用这个接口按词现搜一次（搜过的结果会缓存）。
        新记录在查词时就把章节 / 段落存进 dict_history 了，不会走这里。
        """
        book = store.get_book(book_hash)
        if not book:
            return jsonify({"error": "书不存在。"}), 404
        body = request.get_json(silent=True) or {}
        word = " ".join((body.get("word") or "").split()).strip()
        if not word:
            return jsonify({"error": "没有指定要查找的词。"}), 400

        key = (book_hash, word.lower())
        with _LOCATE_LOCK:
            cached = _LOCATE_CACHE.get(key)
        if cached:
            return jsonify(cached)

        book_dir = os.path.join(cfg.books_dir, book_hash)
        needle = word.lower()
        for ci in range(book["chapter_count"]):
            html = get_chapter_html(book_dir, ci)
            if not html:
                continue
            soup = BeautifulSoup(html, "html.parser")
            for span in soup.select("span.seg"):
                seg_i = span.get("data-i")
                if seg_i is None:
                    continue
                text = " ".join(span.get_text(" ", strip=True).split())
                if needle in text.lower():
                    result = {
                        "chapter_index": ci,
                        "seg_index": int(seg_i),
                        "text": text[:300],
                    }
                    with _LOCATE_LOCK:
                        if len(_LOCATE_CACHE) > 500:
                            _LOCATE_CACHE.clear()
                        _LOCATE_CACHE[key] = result
                    return jsonify(result)
        return jsonify({"error": "没有在原文里找到这个词所在的句子。"}), 404

    # ------------------------------------------------------------------
    # 翻译
    # ------------------------------------------------------------------
    @app.post("/api/translate")
    def translate_selection():
        """点词/句即时翻译。"""
        body = request.get_json(silent=True) or {}
        text = (body.get("text") or "").strip()
        context = (body.get("context") or "").strip()
        if not text:
            return jsonify({"error": "没有选中文字。"}), 400
        if len(text) > 2000:
            return jsonify({"error": "选中的内容太长，请分段翻译。"}), 400
        try:
            result = app.config["TRANSLATOR"].translate_phrase(text, context=context)
            return jsonify({"text": text, "translation": result})
        except FatalAPIError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": f"翻译失败：{exc}"}), 500

    @app.post("/api/dictionary")
    def dictionary():
        """
        查词典：传入 text（单词或短语），返回结构化词条（音标 / 词性 / 中文释义 / 例句）。
        结果有本地缓存，同一个词查第二次不再调用模型。

        查成功后会记进 dict_history —— 阅读器气泡里的「词典」也走这个接口，
        所以两个入口查过的词都会出现在词典面板的「查词记录」里。

        传 body 里的 record=false 表示"别记进查词记录"：笔记页一次性给几十条划线
        批量查词义时用，免得把「查词记录」刷满用户没主动查过的词（词条本身照样缓存）。
        传 book_hash 表示"这次是在哪本书里查的"，词典面板按书分格显示（见第 15 轮）。
        """
        body = request.get_json(silent=True) or {}
        text = (body.get("text") or "").strip()
        if not text:
            return jsonify({"error": "没有选中内容。"}), 400
        if len(text) > 60:
            return jsonify({"error": "词典适合查单词或短语，请选择短一点的内容。"}), 400
        try:
            entry = app.config["TRANSLATOR"].lookup_word(text)
        except FatalAPIError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": f"查询失败：{exc}"}), 500
        if body.get("record", True):
            # 查成功才记，查失败不留记录
            try:
                chapter_index = int(body.get("chapter_index"))
            except (TypeError, ValueError):
                chapter_index = None
            try:
                seg_index = int(body.get("seg_index"))
            except (TypeError, ValueError):
                seg_index = None
            store.add_dict_history(
                text,
                book_hash=(body.get("book_hash") or "").strip(),
                chapter_index=chapter_index,
                seg_index=seg_index,
            )
        return jsonify(entry)

    @app.get("/api/dictionary/history")
    def dict_history():
        """返回查词记录（最近查的排前面），供词典面板显示。"""
        return jsonify(store.list_dict_history())

    @app.delete("/api/dictionary/history")
    def clear_dict_history():
        """清空查词记录。"""
        store.clear_dict_history()
        return jsonify({"ok": True})

    @app.delete("/api/dictionary/history/word")
    def delete_dict_word():
        """删除单个词的查词记录（查词记录页每个词后面的「删除」）。"""
        word = (request.args.get("word") or "").strip()
        if not word:
            return jsonify({"error": "没有指定要删除的词。"}), 400
        deleted = store.delete_dict_history(word)
        return jsonify({"ok": True, "deleted": deleted})

    @app.post("/api/books/<book_hash>/chapter/<int:chapter_index>/translate")
    def translate_chapter(book_hash, chapter_index):
        """
        按需翻译某一章里尚未翻译的段落（阅读器「对照」模式自动补齐译文用）。

        设计取舍：
          * 若整本书的“全文翻译”任务正在跑，本接口不重复翻译，直接返回该章现有结果
            （后台任务会陆续把这一章翻好），避免重复扣费。
          * 用 _CHAPTER_LOCK 串行化“按章翻译”，防止快速滚动时并发触发多章同时翻译。
          * 翻译完返回该章最新的译文与划线，前端直接覆盖本地缓存并重绘即可。
        """
        if not store.get_book(book_hash):
            return jsonify({"error": "书不存在。"}), 404

        # 全文翻译正在跑 → 交给它补全，这里直接返回当前结果（不重复花钱）
        with _JOBS_LOCK:
            job = JOBS.get(book_hash)
            if job and job["progress"]["status"] == "running":
                return jsonify({
                    "translations": store.get_chapter_translations(book_hash, chapter_index),
                    "highlights": store.get_highlights(book_hash, chapter_index),
                    "result": {"total": 0, "done": 0, "failed": 0, "cancelled": False},
                    "busy": True,
                })

        try:
            with _CHAPTER_LOCK:
                result = app.config["TRANSLATOR"].translate_chapter(book_hash, chapter_index)
        except FatalAPIError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": f"翻译失败：{exc}"}), 500

        return jsonify({
            "translations": store.get_chapter_translations(book_hash, chapter_index),
            "highlights": store.get_highlights(book_hash, chapter_index),
            "result": result,
        })

    @app.post("/api/books/<book_hash>/translate")
    def start_translate(book_hash):
        """启动全文翻译（后台线程）。"""
        if not store.get_book(book_hash):
            return jsonify({"error": "书不存在。"}), 404

        with _JOBS_LOCK:
            job = JOBS.get(book_hash)
            if job and job["progress"]["status"] == "running":
                return jsonify(job["progress"])  # 已在翻译中
            stats = store.stats(book_hash)
            cancel = threading.Event()
            progress = {
                "status": "running",
                "total": stats["total"],
                "done": stats["done"],
                "failed": stats["failed"],
                "message": "正在准备术语表…",
            }
            JOBS[book_hash] = {"cancel": cancel, "progress": progress}

        threading.Thread(
            target=_run_translation,
            args=(app.config["TRANSLATOR"], book_hash, cancel, progress),
            daemon=True,
        ).start()
        return jsonify(progress)

    @app.get("/api/books/<book_hash>/translate/progress")
    def translate_progress(book_hash):
        with _JOBS_LOCK:
            job = JOBS.get(book_hash)
        if job:
            return jsonify(job["progress"])
        # 没有正在跑的任务：返回数据库里的静态进度
        stats = store.stats(book_hash)
        status = "done" if stats["total"] and stats["done"] + stats["failed"] >= stats["total"] else "idle"
        return jsonify({"status": status, "total": stats["total"],
                        "done": stats["done"], "failed": stats["failed"], "message": ""})

    @app.post("/api/books/<book_hash>/translate/cancel")
    def cancel_translate(book_hash):
        with _JOBS_LOCK:
            job = JOBS.get(book_hash)
        if job:
            job["cancel"].set()
            job["progress"]["message"] = "正在停止…"
            return jsonify({"ok": True})
        return jsonify({"ok": False, "message": "没有正在进行的任务。"})

    # ------------------------------------------------------------------
    # 设置：翻译模型（选择厂商 + 填 API）
    # ------------------------------------------------------------------
    @app.get("/api/settings")
    def get_settings():
        """返回当前的大模型配置，供「设置」面板回填表单。"""
        return jsonify({
            "api_key": cfg.api_key,
            "base_url": cfg.base_url,
            "model": cfg.model,
            "theme": cfg.default_theme,
        })

    @app.post("/api/theme")
    def save_theme_setting():
        """保存主题到 config.ini：重启后仍然保持深色 / 浅色。"""
        body = request.get_json(silent=True) or {}
        theme = (body.get("theme") or "").strip().lower()
        if theme not in ("light", "dark"):
            return jsonify({"error": "主题只能是 light 或 dark。"}), 400
        try:
            with _CONFIG_LOCK:
                save_theme(DEFAULT_CONFIG_PATH, theme)
        except OSError as exc:
            return jsonify({"error": f"保存主题失败：{exc}"}), 500
        cfg.default_theme = theme
        return jsonify({"ok": True, "theme": theme})

    @app.post("/api/settings")
    def save_settings():
        """
        保存大模型配置：写回 config.ini，并**立即生效**（重建 Translator，无需重启服务）。
        用户是零基础使用者，所以值要校验、错误信息都用中文。
        """
        body = request.get_json(silent=True) or {}
        api_key = (body.get("api_key") or "").strip()
        base_url = (body.get("base_url") or "").strip().rstrip("/")
        model = (body.get("model") or "").strip()

        if not api_key:
            return jsonify({"error": "请填写 API Key。"}), 400
        if not base_url.startswith(("http://", "https://")):
            return jsonify({"error": "Base URL 要以 http:// 或 https:// 开头（通常以 /v1 结尾）。"}), 400
        if not model:
            return jsonify({"error": "请填写模型名。"}), 400

        try:
            with _CONFIG_LOCK:
                save_api_settings(DEFAULT_CONFIG_PATH, api_key, base_url, model)
        except OSError as exc:
            return jsonify({"error": f"写入 config.ini 失败：{exc}"}), 500

        # 立即生效：更新内存配置 + 换掉正在用的翻译器（后续翻译就用新 Key 了）
        cfg.api_key, cfg.base_url, cfg.model = api_key, base_url, model
        app.config["TRANSLATOR"] = Translator(cfg, store)
        return jsonify({"ok": True})

    @app.post("/api/settings/test")
    def test_settings():
        """用表单里的配置发一次最小请求，验证 Key / 地址 / 模型是否可用（不保存）。"""
        body = request.get_json(silent=True) or {}
        api_key = (body.get("api_key") or "").strip()
        base_url = (body.get("base_url") or "").strip().rstrip("/")
        model = (body.get("model") or "").strip()
        if not (api_key and base_url and model):
            return jsonify({"error": "请先填完整 API Key / Base URL / 模型名。"}), 400
        try:
            return jsonify({"ok": True, "message": test_connection(api_key, base_url, model)})
        except FatalAPIError as exc:
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:
            return jsonify({"error": f"连接失败：{exc}"}), 500

    # ------------------------------------------------------------------
    # 标注：书签 / 笔记 / 划线
    # ------------------------------------------------------------------
    @app.get("/api/books/<book_hash>/annotations")
    def list_annotations(book_hash):
        anno_type = request.args.get("type")
        return jsonify(store.list_annotations(book_hash, anno_type))

    @app.post("/api/books/<book_hash>/annotations")
    def add_annotation(book_hash):
        body = request.get_json(silent=True) or {}
        anno_type = body.get("type")
        if anno_type not in (ANNO_BOOKMARK, ANNO_HIGHLIGHT, ANNO_NOTE):
            return jsonify({"error": "标注类型非法。"}), 400
        anno_id = store.add_annotation(
            book_hash=book_hash,
            chapter_index=int(body.get("chapter_index", 0)),
            seg_index=body.get("seg_index"),
            anno_type=anno_type,
            text=body.get("text", ""),
            note=body.get("note", ""),
            char_start=body.get("start"),
            char_end=body.get("end"),
        )
        return jsonify({"id": anno_id})

    @app.delete("/api/annotations/<int:anno_id>")
    def delete_annotation(anno_id):
        store.delete_annotation(anno_id)
        return jsonify({"ok": True})

    # ------------------------------------------------------------------
    # 安卓版：应用内检查更新
    # 构建时生成的 version.json 会同时打进 APK 和上传到 Release，
    # 比对两个 built_at 就知道有没有新版本，避免依赖 GitHub API 限流。
    # ------------------------------------------------------------------
    @app.get("/api/app/update")
    def check_app_update():
        import time
        import urllib.request

        apk_url = ("https://github.com/zihangchu301-source/Yidu/releases/"
                   "download/android-latest/yidu-1.0-debug.apk")
        version_url = ("https://github.com/zihangchu301-source/Yidu/releases/"
                       "download/android-latest/version.json")

        home = os.environ.get("YIDU_HOME", "")
        local_path = os.path.join(home, "version.json") if home else ""
        local = {}
        try:
            if local_path and os.path.isfile(local_path):
                with open(local_path, encoding="utf-8") as fh:
                    local = json.load(fh)
        except (OSError, ValueError):
            local = {}

        # 国内网络偶尔抖动：多给点时间并重试一次，别动不动就"检查失败"
        remote = None
        last_err = None
        for attempt in range(2):
            try:
                req = urllib.request.Request(
                    f"{version_url}?t={int(time.time())}{attempt}",
                    headers={"User-Agent": "YiduReader/1.0",
                             "Cache-Control": "no-cache", "Pragma": "no-cache"},
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    remote = json.loads(resp.read().decode("utf-8", "replace"))
                break
            except Exception as exc:
                last_err = exc
        if not isinstance(remote, dict) or not remote.get("built_at"):
            return jsonify({
                "has_update": False,
                "error": f"无法连接更新服务器：{last_err.__class__.__name__ if last_err else '返回内容异常'}",
            })

        local_at = local.get("built_at", "")
        remote_at = remote.get("built_at", "")
        # 本地版本信息缺失（极老版本升上来 / 文件被清理）：绝不能当成"有更新"。
        # 否则每次检查都提示新版 → 反复下载同一个包 → 安装器说"已安装相同版本"，
        # 用户看到的就是"要装两次才行"。
        if not local:
            return jsonify({
                "has_update": False,
                "local_built_at": "未知",
                "local_version": "",
                "note": "本地版本信息缺失，如确认有新版本请手动下载",
            })
        # 优先用递增的版本号判断（不受设备时间影响）；老格式才退回时间比较
        local_code = int(local.get("version_code") or 0)
        remote_code = int(remote.get("version_code") or 0)
        if remote_code > 0 and local_code > 0:
            has_update = remote_code > local_code
        else:
            has_update = bool(remote_at and remote_at > local_at)

        # 优先用每版独立的 yidu-<版本>.apk，固定文件名容易被 CDN 缓存成旧包
        download_url = remote.get("apk") or f"{apk_url}?v={remote_at or int(time.time())}"
        return jsonify({
            "has_update": has_update,
            "local_built_at": local_at or "未知",
            "remote_built_at": remote_at or "未知",
            "local_version": local.get("version_name", "") or "未知",
            "version": remote.get("version_name", "") or "未知",
            "size_mb": remote.get("size_mb", 0),
            "url": download_url,
            "fixed_url": apk_url,
        })

    return app


# ======================================================================
# 全文翻译的后台任务
# ======================================================================
def _run_translation(translator: Translator, book_hash: str,
                     cancel: threading.Event, progress: dict) -> None:
    """在后台线程里跑完整本书的翻译，并把进度写进 progress 字典。"""

    def on_progress(done: int, failed: int, total: int) -> None:
        progress["done"] = done
        progress["failed"] = failed
        progress["total"] = total
        progress["message"] = "正在翻译…"

    try:
        result = translator.translate_book(book_hash, cancel, on_progress)
        progress["done"] = result["done"]
        progress["failed"] = result["failed"]
        progress["total"] = result["total"]
        if result["cancelled"]:
            progress["status"] = "cancelled"
            progress["message"] = "已停止（下次点击会从断点继续）。"
        else:
            progress["status"] = "done"
            progress["message"] = (
                f"翻译完成，共 {result['done']} 段"
                + (f"，{result['failed']} 段失败。" if result["failed"] else "。")
            )
    except FatalAPIError as exc:
        progress["status"] = "error"
        progress["message"] = str(exc)
    except Exception as exc:
        progress["status"] = "error"
        progress["message"] = f"翻译过程中出错：{exc}"