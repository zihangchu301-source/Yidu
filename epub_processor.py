# -*- coding: utf-8 -*-
"""
epub_processor.py —— EPUB 解析层
=================================
职责：把一本 EPUB 拆成阅读器需要的各种“零件”。

它只负责“解析”，不负责“落盘”（写文件由 server.py 做），也不负责“翻译”。

核心概念：可翻译文本节点（segment）
    翻译的最小单位是 HTML 里的【文本节点】，而不是整个 <p>。
      * <p>Hello world</p>          -> 1 个文本节点（就是整段）
      * <p>Hello <b>world</b></p>   -> 2 个文本节点（"Hello " 和 "world"）
    解析时把每个文本节点包一层 <span class="seg" data-i="序号">，
      - data-i 是全书自增序号，翻译缓存、前端切换中文都靠它对齐；
      - 因为 span 包在最内层，<b>/<i>/<a> 等格式标签完全不受影响。

哪些文本需要翻译：
    默认取 <p>（正文段落）以及 <h1>~<h6>（章节标题）里的文本。
    若某篇文档完全没有 <p>（少数书用 <div> 排版），则退化为取 <div>/<li> 等块级标签。

对外接口：
    parse_epub(epub_path, book_hash) -> dict
        返回 {
          "title": str, "author": str,
          "cover": {"name": "cover.jpg", "data": bytes} | None,
          "images": [{"name": str, "data": bytes}],
          "chapters": [{"index": int, "title": str, "html": str}],
          "segments": [{"index": int, "chapter_index": int, "text": str}],
        }
"""

from __future__ import annotations

import os
from typing import List, Optional, Set

import ebooklib
from bs4 import BeautifulSoup, Comment, NavigableString
from ebooklib import epub

# 正文里被当作“可翻译段落”的块级标签（首选集合）
_PRIMARY_BLOCK_TAGS: Set[str] = {"p", "h1", "h2", "h3", "h4", "h5", "h6"}
# 没有 <p> 时的退化集合（少数书用 div 排版）
_FALLBACK_BLOCK_TAGS: Set[str] = {
    "div", "li", "blockquote", "td", "h1", "h2", "h3", "h4", "h5", "h6",
}
# 常见“目录/导航页”文件名，这类文档不应当作正文章节
_NAV_FILE_NAMES: Set[str] = {
    "nav.xhtml", "nav.html", "toc.xhtml", "toc.html",
    "contents.xhtml", "tableofcontents.xhtml",
}
# 正文文档的 media type：不同书商写法不一，需全部接受
_HTML_MEDIA_TYPES: Set[str] = {"application/xhtml+xml", "text/html"}
# 正文文档的文件后缀（media type 缺失时的兜底判断）
_HTML_EXTENSIONS = (".xhtml", ".html", ".htm")


# ======================================================================
# 内部工具
# ======================================================================
def _is_html_item(item) -> bool:
    """
    判断一个 item 是否是 HTML 正文文档。

    为什么不能只看 get_type() == ITEM_DOCUMENT：
        ebooklib 只把 media_type 为 application/xhtml+xml 的条目标为 ITEM_DOCUMENT；
        而大量真实 EPUB（如杂志、部分自制书）把正文声明成 text/html，
        ebooklib 会把它归为 ITEM_UNKNOWN。若只认 ITEM_DOCUMENT，
        整本书的正文都会被漏掉（表现为“导入后没有内容”）。
    """
    media = (getattr(item, "media_type", "") or "").lower()
    if media in _HTML_MEDIA_TYPES:
        return True
    name = (item.get_name() or "").lower()
    return name.endswith(_HTML_EXTENSIONS)


def _ordered_documents(book: epub.EpubBook):
    """
    按“书脊(spine)阅读顺序”返回正文文档列表。
    spine 决定真实阅读顺序；缺失或不全时，用文件名排序补齐，保证结果稳定。
    """
    ordered, seen = [], set()

    def _add(item) -> None:
        if item is None or not _is_html_item(item):
            return
        key = item.get_id()
        if key in seen:
            return
        ordered.append(item)
        seen.add(key)

    spine = list(getattr(book, "spine", None) or [])

    def _is_linear(entry) -> bool:
        """spine 条目 (idref, linear)；linear="no" 表示不属于阅读主线（如封面）。"""
        if isinstance(entry, (tuple, list)) and len(entry) > 1:
            return str(entry[1]).lower() != "no"
        return True

    has_linear = any(_is_linear(e) for e in spine)

    # 1) 按 spine 顺序解析：直接用 id 取 item，兼容任意 media type
    for entry in spine:
        idref = entry[0] if isinstance(entry, (tuple, list)) else entry
        item = book.get_item_with_id(idref)
        if item is not None and has_linear and not _is_linear(entry):
            seen.add(item.get_id())  # 标记已处理，避免下一步又被补回来
            continue
        _add(item)

    # 2) spine 未覆盖到的 HTML 文档，按文件名补到末尾
    for item in sorted(book.get_items(), key=lambda it: it.get_name() or ""):
        _add(item)

    return ordered


def _flatten_toc(toc, out: List[tuple]) -> None:
    """把 ebooklib 可能嵌套的目录树拍平成 [(href, title), ...]。"""
    for item in toc or []:
        if isinstance(item, (tuple, list)) and len(item) == 2:
            section, children = item
            href = getattr(section, "href", None)
            title = getattr(section, "title", None)
            if href:
                out.append((href, title))
            _flatten_toc(children, out)
        else:
            href = getattr(item, "href", None)
            title = getattr(item, "title", None)
            if href:
                out.append((href, title))


def _doc_name_of(href: str) -> str:
    """把目录里的 href（可能带 #锚点）转成文档文件名。"""
    return (href or "").split("#", 1)[0]


def _nearest_block_tag(node: NavigableString, block_tags: Set[str]) -> Optional[str]:
    """
    向上找该文本节点最近的“块级祖先标签”，判断它是否属于可翻译区域。

    为什么要往上找：<p>Hello <b>world</b></p> 里的 "world" 直接父节点是 <b> 而不是 <p>，
    必须往上找到 <p> 才能确认它属于正文段落；同时也能避免嵌套 <div> 时同一个文本被重复处理。
    """
    for anc in node.parents:
        name = getattr(anc, "name", None)
        if name in block_tags:
            return name
        if name in ("body", "html"):
            return None
    return None


def _link_text_ratio(soup: BeautifulSoup) -> float:
    """文档里“位于 <a> 链接内的文字”占全部文字的比例。目录页该比例极高。"""
    total = len(soup.get_text(strip=True))
    if total == 0:
        return 0.0
    linked = sum(len(a.get_text(strip=True)) for a in soup.find_all("a"))
    return linked / total


def _has_prose(soup: BeautifulSoup) -> bool:
    """文档里是否存在“真正的正文段落”（长于 80 字的 <p> 文本）。"""
    for p in soup.find_all("p"):
        if len(p.get_text(strip=True)) > 80:
            return True
    return False


def _is_nav_document(soup: BeautifulSoup, doc_name: str) -> bool:
    """判断某篇文档是不是目录/导航页（不该当作正文章节）。"""
    if os.path.basename(doc_name).lower() in _NAV_FILE_NAMES:
        return True
    # 含 <nav> 且没有任何 <p> 的文档，基本可以断定是导航页
    if soup.find("nav") is not None and soup.find("p") is None:
        return True
    # 书自带的“目录页 / 栏目扉页”：文字几乎全都在 <a> 链接里，
    # 且整页没有一个真正的正文段落。这类页面的链接指向 EPUB 内部文件名，
    # 在阅读器里点开会 404，而我们的“目录”功能已覆盖其作用，故直接跳过。
    if (len(soup.find_all("a")) >= 5
            and _link_text_ratio(soup) >= 0.8
            and not _has_prose(soup)):
        return True
    return False


def _wrap_text_nodes(soup: BeautifulSoup, chapter_index: int, start_index: int):
    """
    把可翻译区域内的文本节点包成 <span class="seg" data-i="N">。

    遍历方式：按【文档顺序】遍历所有文本节点（只遍历一次，天然避免重复），
    再用“最近的块级祖先”判断它是否属于 <p>/<h1>... 等目标区域。

    :return: (segments, next_index)
    """
    segments: List[dict] = []
    idx = start_index

    # 有 <p> 就按 <p>（+标题）取；完全没有 <p> 时才退化为 div/li 等
    block_tags = _PRIMARY_BLOCK_TAGS if soup.find("p") is not None else _FALLBACK_BLOCK_TAGS

    body = soup.body or soup
    for node in list(body.find_all(string=True)):
        if isinstance(node, Comment):
            continue
        text = str(node)
        if not text.strip():
            continue  # 纯空白（换行/缩进）无需翻译
        if _nearest_block_tag(node, block_tags) is None:
            continue  # 不在正文段落区域内（如导航、脚注）

        span = soup.new_tag("span", attrs={"class": "seg", "data-i": str(idx)})
        span.append(NavigableString(text))
        node.replace_with(span)

        segments.append({"index": idx, "chapter_index": chapter_index, "text": text})
        idx += 1

    return segments, idx


def _rewrite_image_src(soup: BeautifulSoup, book_hash: str) -> None:
    """把 <img src> 改写成本地书库的静态地址（图片由 server 落盘到 assets/）。"""
    for img in soup.find_all("img"):
        src = img.get("src")
        if not src:
            continue
        img["src"] = f"/static/books/{book_hash}/assets/{os.path.basename(src)}"


def _first_heading_text(soup: BeautifulSoup) -> Optional[str]:
    """取章节里第一个标题文本，作为兜底章节名。"""
    for tag in ("h1", "h2", "h3"):
        el = soup.find(tag)
        if el and el.get_text(strip=True):
            return el.get_text(strip=True)[:60]
    return None


def _extract_cover(book: epub.EpubBook):
    """尝试取封面图片，返回 {"name", "data"} 或 None。"""
    # 1) 优先用 ebooklib 识别的封面，或文件名里带 cover 的图片
    for it in book.get_items():
        itype = it.get_type()
        is_cover = itype == ebooklib.ITEM_COVER or (
            itype == ebooklib.ITEM_IMAGE and "cover" in (it.get_name() or "").lower()
        )
        if not is_cover:
            continue
        try:
            return {"name": os.path.basename(it.get_name()), "data": it.get_content()}
        except Exception:
            continue
    # 2) 兜底：用第一张图片
    for it in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        try:
            return {"name": os.path.basename(it.get_name()), "data": it.get_content()}
        except Exception:
            continue
    return None


def _extract_images(book: epub.EpubBook) -> List[dict]:
    """导出全书所有图片（供阅读器显示插图）。"""
    images = []
    for it in book.get_items_of_type(ebooklib.ITEM_IMAGE):
        try:
            images.append({"name": os.path.basename(it.get_name()), "data": it.get_content()})
        except Exception:
            continue
    return images


# ======================================================================
# 主入口
# ======================================================================
def parse_epub(epub_path: str, book_hash: str) -> dict:
    """
    解析 EPUB，返回阅读器所需的全部零件（不写文件）。

    :param epub_path: EPUB 文件路径
    :param book_hash: 书籍唯一标识（用于拼接图片静态地址）
    """
    book = epub.read_epub(epub_path)

    # ---- 书名 / 作者 ----
    title = _meta_first(book, "title") or os.path.splitext(os.path.basename(epub_path))[0]
    author = _meta_first(book, "creator") or "未知作者"

    # ---- 目录：文件名 -> 章节标题 ----
    toc_pairs: List[tuple] = []
    _flatten_toc(book.toc, toc_pairs)
    title_by_doc = {}
    for href, t in toc_pairs:
        doc = _doc_name_of(href)
        if doc and t:
            title_by_doc.setdefault(doc, t)

    # ---- 逐章解析 ----
    chapters = []
    segments = []
    global_index = 0

    for item in _ordered_documents(book):
        try:
            soup = BeautifulSoup(item.get_content(), "html.parser")
        except Exception:
            continue

        # 跳过目录/导航页，避免出现“空章节”
        if _is_nav_document(soup, item.get_name()):
            continue

        # 章节序号从 0 连续编号（跳过导航页后依然连续，保证文件名 ch_0、ch_1 ...）
        chapter_index = len(chapters)

        # 先取标题（取标题要在包裹 span 之前，避免干扰）
        doc_name = item.get_name()
        chapter_title = (
            title_by_doc.get(doc_name)
            or _first_heading_text(soup)
            or f"第 {chapter_index + 1} 章"
        )

        # 包裹可翻译文本节点 + 改写图片地址
        chapter_segments, global_index = _wrap_text_nodes(soup, chapter_index, global_index)
        _rewrite_image_src(soup, book_hash)
        segments.extend(chapter_segments)

        # 只保留 <body> 内容，避免整页 <html>/<head> 干扰阅读样式
        body = soup.find("body")
        html = str(body if body else soup)

        chapters.append({"index": chapter_index, "title": chapter_title, "html": html})

    return {
        "title": title,
        "author": author,
        "cover": _extract_cover(book),
        "images": _extract_images(book),
        "chapters": chapters,
        "segments": segments,
    }


def get_chapter_html(book_dir: str, chapter_index: int) -> Optional[str]:
    """
    读取某章已保存的 HTML（导入时由 server 落盘为 ch_<index>.html）。
    """
    path = os.path.join(book_dir, f"ch_{chapter_index}.html")
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _meta_first(book: epub.EpubBook, name: str) -> Optional[str]:
    """安全读取 EPUB 元数据的第一个值（如 title / creator）。"""
    try:
        data = book.get_metadata("DC", name)
        if data and data[0] and data[0][0]:
            return str(data[0][0]).strip()
    except Exception:
        pass
    return None