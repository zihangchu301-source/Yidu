# -*- coding: utf-8 -*-
"""
state_manager.py —— 数据层（本地 SQLite 数据库）
================================================
职责：整个程序所有“需要保存下来的东西”都放在这里：
    1. books        书库：导入了哪些书
    2. segments     翻译缓存/进度：每一小段原文 + 译文 + 状态（断点续传靠它）
    3. meta         按书维度的元数据：术语表、前文摘要
    4. phrase_cache 点词/句翻译的缓存（同一个词查第二次不再花钱）
    5. annotations  书签 / 笔记 / 划线

设计要点（方便其它 AI / 人修改）：
    * 只暴露 Store 这一个类，所有 SQL 都收在类内部，其它模块不写 SQL。
    * 线程安全：多线程翻译时会并发写入，所有写操作都加锁串行化。
    * 段落状态三态：pending（待译）/ done（已完成）/ failed（已失败）。
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from datetime import datetime
from typing import Dict, List, Optional

# 段落状态常量
STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

# 标注类型常量
ANNO_BOOKMARK = "bookmark"
ANNO_HIGHLIGHT = "highlight"
ANNO_NOTE = "note"


def _now() -> str:
    """当前时间字符串（秒级）。"""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def compute_book_hash(epub_path: str) -> str:
    """计算 EPUB 文件内容的 sha1，作为这本书的全局唯一标识。"""
    sha1 = hashlib.sha1()
    with open(epub_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            sha1.update(chunk)
    return sha1.hexdigest()


def hash_text(text: str) -> str:
    """把一段文本转成 hash，用作点词/句翻译缓存的键。"""
    return hashlib.sha1(text.strip().encode("utf-8")).hexdigest()


def detect_language(texts: List[str]) -> str:
    """
    按抽样文本判断书的语种：中文字符占比 >= 30% 判为中文（zh），否则英文（en）。
    中文书不需要翻译，阅读器会隐藏所有翻译入口（语言开关 / 全文翻译 / 翻译按钮）。
    """
    total = cjk = 0
    for t in texts:
        for ch in t or "":
            total += 1
            if "\u4e00" <= ch <= "\u9fff":
                cjk += 1
    return "zh" if total and cjk / total >= 0.3 else "en"


class Store:
    """本地数据库的统一入口（线程安全）。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        # check_same_thread=False：允许跨线程使用同一连接；写入由 _lock 保护
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._init_schema()

    # ==================================================================
    # 建表
    # ==================================================================
    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                -- ① 书库
                CREATE TABLE IF NOT EXISTS books (
                    book_hash     TEXT PRIMARY KEY,
                    title         TEXT,
                    author        TEXT,
                    cover         TEXT,            -- 封面文件名，可为空
                    chapter_count INTEGER,
                    seg_count     INTEGER,
                    language      TEXT,            -- 语种：en=英文 / zh=中文（中文书不显示翻译）
                    added_at      TEXT,
                    total_read_seconds INTEGER DEFAULT 0   -- 这本书累计读了多少秒
                );

                -- ② 段落翻译缓存 / 进度
                CREATE TABLE IF NOT EXISTS segments (
                    book_hash     TEXT NOT NULL,
                    seg_index     INTEGER NOT NULL,   -- 全书自增序号（与前端 data-i 对齐）
                    chapter_index INTEGER,            -- 所属章节序号
                    source        TEXT,               -- 原文
                    translated    TEXT,               -- 译文
                    status        TEXT DEFAULT 'pending',
                    updated_at    TEXT,
                    PRIMARY KEY (book_hash, seg_index)
                );

                -- ③ 按书维度的元数据（术语表 / 摘要）
                CREATE TABLE IF NOT EXISTS meta (
                    book_hash TEXT NOT NULL,
                    key       TEXT NOT NULL,
                    value     TEXT,
                    PRIMARY KEY (book_hash, key)
                );

                -- ④ 点词/句翻译缓存
                CREATE TABLE IF NOT EXISTS phrase_cache (
                    text_hash  TEXT PRIMARY KEY,
                    source     TEXT,
                    translated TEXT,
                    updated_at TEXT
                );

                -- ⑤ 书签 / 笔记 / 划线
                -- char_start / char_end：划线在“该段原文”里的起止字符位置。
                --   这样划线只覆盖用户真正选中的那几个字，而不是整段。
                CREATE TABLE IF NOT EXISTS annotations (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_hash     TEXT NOT NULL,
                    chapter_index INTEGER,
                    seg_index     INTEGER,
                    type          TEXT NOT NULL,      -- bookmark / highlight / note
                    text          TEXT,               -- 摘录的文字
                    note          TEXT,               -- 笔记内容
                    char_start    INTEGER,            -- 划线起始位置（段内字符偏移）
                    char_end      INTEGER,            -- 划线结束位置（段内字符偏移）
                    created_at    TEXT
                );

                -- ⑥ 词典查词记录（只记查过哪些词，不存释义 —— 释义在 phrase_cache 里）
                -- word 用 NOCASE：Apple 和 apple 算同一个词，只留一条。
                -- book_hash：在**哪本书里**查的 —— 词典面板按这本书分格显示，方便整理
                --            （没记到的老记录为 NULL，前端归到「（未分类）」）。
                CREATE TABLE IF NOT EXISTS dict_history (
                    word      TEXT PRIMARY KEY COLLATE NOCASE,
                    looked_at TEXT,
                    book_hash TEXT,
                    chapter_index INTEGER,   -- 在哪一章查的（点词条跳回原文用）
                    seg_index     INTEGER    -- 在哪一段查的（全书自增的 data-i）
                );
                """
            )
            # 兼容旧数据库：老版本的 annotations 表没有这两个列，自动补上
            cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(annotations)")}
            if "char_start" not in cols:
                self._conn.execute("ALTER TABLE annotations ADD COLUMN char_start INTEGER")
            if "char_end" not in cols:
                self._conn.execute("ALTER TABLE annotations ADD COLUMN char_end INTEGER")
            # 兼容旧数据库：dict_history 表补 book_hash 列（按书分格显示查词记录）
            dcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(dict_history)")}
            if "book_hash" not in dcols:
                self._conn.execute("ALTER TABLE dict_history ADD COLUMN book_hash TEXT")
            # 兼容旧数据库：补「查词位置」列（点词条跳回原文里的那句话；老记录为 NULL）
            if "chapter_index" not in dcols:
                self._conn.execute(
                    "ALTER TABLE dict_history ADD COLUMN chapter_index INTEGER"
                )
            if "seg_index" not in dcols:
                self._conn.execute(
                    "ALTER TABLE dict_history ADD COLUMN seg_index INTEGER"
                )
            # 兼容旧数据库：books 表补 language 列（中文书不显示翻译功能）
            bcols = {r["name"] for r in self._conn.execute("PRAGMA table_info(books)")}
            if "language" not in bcols:
                self._conn.execute("ALTER TABLE books ADD COLUMN language TEXT")
            # 兼容旧数据库：books 表补阅读时长列（书架显示读了多久）
            if "total_read_seconds" not in bcols:
                self._conn.execute(
                    "ALTER TABLE books ADD COLUMN total_read_seconds INTEGER DEFAULT 0"
                )
            self._conn.commit()

    # ==================================================================
    # ① 书库
    # ==================================================================
    def add_book(
        self,
        book_hash: str,
        title: str,
        author: str,
        cover: Optional[str],
        chapter_count: int,
        seg_count: int,
        language: Optional[str] = None,
    ) -> None:
        """登记一本书（重复导入同一本会更新信息）。language：en / zh。"""
        with self._lock:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO books
                    (book_hash, title, author, cover, chapter_count, seg_count, language, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (book_hash, title, author, cover, chapter_count, seg_count, language, _now()),
            )
            self._conn.commit()

    def list_books(self) -> List[dict]:
        """返回书库列表（新导入的排前面）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM books ORDER BY added_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_book(self, book_hash: str) -> Optional[dict]:
        """按 hash 取一本书的信息。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM books WHERE book_hash = ?", (book_hash,)
            ).fetchone()
        return dict(row) if row else None

    def set_language(self, book_hash: str, language: str) -> None:
        """补记一本书的语种（老书启动回填用）。"""
        with self._lock:
            self._conn.execute(
                "UPDATE books SET language = ? WHERE book_hash = ?", (language, book_hash)
            )
            self._conn.commit()

    def add_read_seconds(self, book_hash: str, seconds: int) -> None:
        """给一本书的阅读时长累加秒数（前端每 30 秒心跳上报一次）。"""
        if seconds <= 0:
            return
        with self._lock:
            self._conn.execute(
                """
                UPDATE books
                SET total_read_seconds = COALESCE(total_read_seconds, 0) + ?
                WHERE book_hash = ?
                """,
                (seconds, book_hash),
            )
            self._conn.commit()

    def total_read_seconds(self) -> int:
        """全书库累计阅读秒数（书架统计条的总时长用）。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT COALESCE(SUM(total_read_seconds), 0) AS t FROM books"
            ).fetchone()
        return int(row["t"])

    def backfill_languages(self) -> None:
        """
        给没有语种记录的老书回填 language：
        从 segments 里抽几段正文，按中文字符占比判断。只处理 language 为空的书。
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT book_hash FROM books WHERE language IS NULL OR language = ''"
            ).fetchall()
        for r in rows:
            with self._lock:
                seg_rows = self._conn.execute(
                    "SELECT source FROM segments "
                    "WHERE book_hash = ? AND LENGTH(source) >= 8 "
                    "ORDER BY seg_index LIMIT 40",
                    (r["book_hash"],),
                ).fetchall()
            if not seg_rows:
                continue  # 一段文本都抽不到（可能是坏书），下次启动再试
            self.set_language(r["book_hash"], detect_language([x["source"] for x in seg_rows]))

    def delete_book(self, book_hash: str) -> None:
        """删除一本书及其全部关联数据。"""
        with self._lock:
            for table in ("books", "segments", "meta", "annotations"):
                self._conn.execute(f"DELETE FROM {table} WHERE book_hash = ?", (book_hash,))
            self._conn.commit()

    # ==================================================================
    # ② 段落（翻译缓存 / 断点续传）
    # ==================================================================
    def init_segments(self, book_hash: str, segments: List[dict]) -> None:
        """
        登记全书段落清单。已存在的行不覆盖（从而保留上次翻译进度）。

        :param segments: [{"index": int, "chapter_index": int, "text": str}, ...]
        """
        with self._lock:
            self._conn.executemany(
                """
                INSERT OR IGNORE INTO segments
                    (book_hash, seg_index, chapter_index, source, status, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (book_hash, s["index"], s.get("chapter_index", 0), s["text"],
                     STATUS_PENDING, _now())
                    for s in segments
                ],
            )
            self._conn.commit()

    def get_segments(self, book_hash: str) -> List[dict]:
        """返回全书段落（按 seg_index 升序）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM segments WHERE book_hash = ? ORDER BY seg_index ASC",
                (book_hash,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_done_map(self, book_hash: str) -> Dict[int, str]:
        """返回已完成段落的 {seg_index: 译文}，用于断点续传与回填。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT seg_index, translated FROM segments "
                "WHERE book_hash = ? AND status = ?",
                (book_hash, STATUS_DONE),
            ).fetchall()
        return {r["seg_index"]: (r["translated"] or "") for r in rows}

    def get_chapter_translations(self, book_hash: str, chapter_index: int) -> Dict[int, str]:
        """返回某一章节里已完成段落的 {seg_index: 译文}（供前端切换中文）。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT seg_index, translated FROM segments "
                "WHERE book_hash = ? AND chapter_index = ? AND status = ?",
                (book_hash, chapter_index, STATUS_DONE),
            ).fetchall()
        return {r["seg_index"]: (r["translated"] or "") for r in rows}

    def save_results_bulk(self, book_hash: str, results: List[dict]) -> None:
        """
        批量保存翻译结果（一次事务，减少磁盘写入）。

        :param results: [{"index": int, "translated": str, "status": str}, ...]
        """
        if not results:
            return
        with self._lock:
            self._conn.executemany(
                """
                UPDATE segments
                   SET translated = ?, status = ?, updated_at = ?
                 WHERE book_hash = ? AND seg_index = ?
                """,
                [
                    (r.get("translated", ""), r.get("status", STATUS_DONE), _now(),
                     book_hash, r["index"])
                    for r in results
                ],
            )
            self._conn.commit()

    def stats(self, book_hash: str) -> dict:
        """统计翻译进度 {total, done, failed, pending}。"""
        with self._lock:
            rows = self._conn.execute(
                "SELECT status, COUNT(*) AS c FROM segments WHERE book_hash = ? GROUP BY status",
                (book_hash,),
            ).fetchall()
        result = {STATUS_DONE: 0, STATUS_FAILED: 0, STATUS_PENDING: 0}
        for r in rows:
            result[r["status"]] = r["c"]
        result["total"] = sum(result.values())
        return result

    # ==================================================================
    # ③ 元数据（术语表 / 摘要）
    # ==================================================================
    def set_meta(self, book_hash: str, key: str, value) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (book_hash, key, value) VALUES (?, ?, ?)",
                (book_hash, key, json.dumps(value, ensure_ascii=False)),
            )
            self._conn.commit()

    def get_meta(self, book_hash: str, key: str, default=None):
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE book_hash = ? AND key = ?",
                (book_hash, key),
            ).fetchone()
        if not row or row["value"] is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return default

    def set_glossary(self, book_hash: str, glossary: dict) -> None:
        self.set_meta(book_hash, "glossary", glossary)

    def get_glossary(self, book_hash: str) -> Optional[dict]:
        return self.get_meta(book_hash, "glossary", default=None)

    def set_summary(self, book_hash: str, summary: str) -> None:
        self.set_meta(book_hash, "summary", summary)

    def get_summary(self, book_hash: str) -> str:
        return self.get_meta(book_hash, "summary", default="") or ""

    # ==================================================================
    # ④ 点词/句翻译缓存
    # ==================================================================
    def get_phrase(self, text_hash: str) -> Optional[str]:
        with self._lock:
            row = self._conn.execute(
                "SELECT translated FROM phrase_cache WHERE text_hash = ?", (text_hash,)
            ).fetchone()
        return row["translated"] if row else None

    def set_phrase(self, text_hash: str, source: str, translated: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO phrase_cache (text_hash, source, translated, updated_at) "
                "VALUES (?, ?, ?, ?)",
                (text_hash, source, translated, _now()),
            )
            self._conn.commit()

    # ==================================================================
    # ⑥ 词典查词记录
    # ==================================================================
    def add_dict_history(
        self,
        word: str,
        book_hash: str = None,
        chapter_index: int = None,
        seg_index: int = None,
    ) -> None:
        """
        记一次查词。同一个词只留一条（不分大小写），重复查会刷新时间、排到最前面，
        所以这张表天然就是"最近查过的词"列表，不会越滚越长。

        book_hash = 这一次是在哪本书里查的（词典面板按书分格显示）。
        同一个词换一本书再查，记录会跟到新书那边（仍然只有一条，不会越滚越长）。

        chapter_index / seg_index = 这次是在哪一章、哪一段查的。
        词典面板里点这个词时，阅读器据此跳回原文里的那句话（老记录没有位置，前端会按词搜索）。
        """
        word = (word or "").strip()
        if not word:
            return
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO dict_history "
                "(word, looked_at, book_hash, chapter_index, seg_index) "
                "VALUES (?, ?, ?, ?, ?)",
                (word, _now(), book_hash or None, chapter_index, seg_index),
            )
            self._conn.commit()

    def list_dict_history(self, limit: int = 200) -> List[dict]:
        """
        返回查词记录，最近查的排前面。

        每条都带上当时查到的词条内容（音标 / 词性 / 释义 / 例句）——
        词条正文本来就在 phrase_cache 里，这里按同样的键取回来拼上，
        **不重复存一份**，所以词典面板能直接显示完整词条。

        还会带上 book_hash / book_title（连表查 books），前端据此按书分格显示；
        书被删了或老记录没记到书名时 book_title 为 None，前端归到「（未分类）」。

        万一某个词的缓存被清掉了，entry 为 None，前端只显示单词本身。
        """
        with self._lock:
            rows = self._conn.execute(
                # looked_at 只精确到秒，同一秒内查的多个词用 rowid 兜底排序
                # （REPLACE 会删旧行插新行，所以 rowid 越大 = 越新）
                "SELECT h.word, h.looked_at, h.book_hash, h.chapter_index, h.seg_index, "
                "b.title AS book_title "
                "FROM dict_history h LEFT JOIN books b ON b.book_hash = h.book_hash "
                "ORDER BY h.looked_at DESC, h.rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
            if not rows:
                return []

            # 一次把用到的缓存都捞出来（marks 只是问号占位，不会有注入）
            keys = [hash_text("dict|" + r["word"].lower()) for r in rows]
            marks = ",".join("?" * len(keys))
            entries: Dict[str, dict] = {}
            for c in self._conn.execute(
                f"SELECT text_hash, translated FROM phrase_cache WHERE text_hash IN ({marks})",
                keys,
            ):
                try:
                    entries[c["text_hash"]] = json.loads(c["translated"])
                except (TypeError, json.JSONDecodeError):
                    pass

        return [
            {"word": r["word"], "looked_at": r["looked_at"],
             "book_hash": r["book_hash"], "book_title": r["book_title"],
             "chapter_index": r["chapter_index"], "seg_index": r["seg_index"],
             "entry": entries.get(hash_text("dict|" + r["word"].lower()))}
            for r in rows
        ]

    def clear_dict_history(self) -> None:
        """清空查词记录（只清记录，词典缓存不动，已查过的词再查也不花钱）。"""
        with self._lock:
            self._conn.execute("DELETE FROM dict_history")
            self._conn.commit()

    def delete_dict_history(self, word: str) -> int:
        """删掉一个词的查词记录（大小写不敏感）；返回实际删除条数。

        只删 dict_history 这条记录，**不删 phrase_cache 里的词条缓存** ——
        以后再看同一个词仍然秒出、不花钱。
        """
        word = (word or "").strip()
        if not word:
            return 0
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM dict_history WHERE word = ? COLLATE NOCASE", (word,)
            )
            self._conn.commit()
            return int(cur.rowcount or 0)

    # ==================================================================
    # ⑤ 书签 / 笔记 / 划线
    # ==================================================================
    def add_annotation(
        self,
        book_hash: str,
        chapter_index: int,
        seg_index: Optional[int],
        anno_type: str,
        text: str = "",
        note: str = "",
        char_start: Optional[int] = None,
        char_end: Optional[int] = None,
    ) -> int:
        """新增一条标注，返回其 id。"""
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO annotations
                    (book_hash, chapter_index, seg_index, type, text, note,
                     char_start, char_end, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (book_hash, chapter_index, seg_index, anno_type, text, note,
                 char_start, char_end, _now()),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def list_annotations(self, book_hash: str, anno_type: Optional[str] = None) -> List[dict]:
        """列出某本书的标注（可按类型过滤）。"""
        with self._lock:
            if anno_type:
                rows = self._conn.execute(
                    "SELECT * FROM annotations WHERE book_hash = ? AND type = ? "
                    "ORDER BY chapter_index ASC, id ASC",
                    (book_hash, anno_type),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM annotations WHERE book_hash = ? "
                    "ORDER BY chapter_index ASC, id ASC",
                    (book_hash,),
                ).fetchall()
        return [dict(r) for r in rows]

    def get_highlights(self, book_hash: str, chapter_index: int) -> List[dict]:
        """
        返回某章的划线列表，供前端精确高亮。

        每一项形如 {"seg_index": 12, "start": 3, "end": 9}：
        表示第 12 段原文里第 3~9 个字符需要加底色。
        start/end 为空时（旧数据）表示整段划线。
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT seg_index, char_start, char_end FROM annotations "
                "WHERE book_hash = ? AND chapter_index = ? AND type = ? AND seg_index IS NOT NULL",
                (book_hash, chapter_index, ANNO_HIGHLIGHT),
            ).fetchall()
        return [
            {"seg_index": r["seg_index"], "start": r["char_start"], "end": r["char_end"]}
            for r in rows
        ]

    def counts_by_book(self) -> Dict[str, Dict[str, int]]:
        """
        按书统计各类标注的数量，供书架页显示（例如"划线 12 · 笔记 3"）。

        :return: {book_hash: {"highlight": n, "note": n, ...}}
        """
        with self._lock:
            rows = self._conn.execute(
                "SELECT book_hash, type, COUNT(*) AS c FROM annotations "
                "GROUP BY book_hash, type"
            ).fetchall()
        result: Dict[str, Dict[str, int]] = {}
        for r in rows:
            result.setdefault(r["book_hash"], {})[r["type"]] = r["c"]
        return result

    def delete_annotation(self, anno_id: int) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM annotations WHERE id = ?", (anno_id,))
            self._conn.commit()