/* ==========================================================================
   app.js —— 前端交互逻辑
   --------------------------------------------------------------------------
   这一份文件负责网页上所有“会动”的东西，分为 10 个部分：
    1. 全局状态与工具函数
    2. 书架：加载 / 导入 / 打开 / 删除
    3. 阅读器：加载章节 / 连续滚动跨章 / 顶部栏沉浸
    4. 点选翻译：选中文字 → 浮出操作栏（复制 / 划线 / 词典 / 翻译 / 朗读） → 气泡显示结果
    5. 显示语言：原文 / 对照 / 中文 三态切换（对照 = 每段英文下面紧跟该段中文）
    6. 翻译：整本「全文翻译」+「对照」模式的按章按需翻译（只翻在读的章节，省 token）
    7. 划线 / 笔记页（浮窗：可拖动、阅读器里并排显示 + 每条划线的词典释义）/ 章内注释气泡
    8. 目录 / 设置（字号 / 主题 / 翻译模型）
    9. 全文朗读（英语书：整本连续读 + 只读选中的一段）
   10. 从词典 / 划线跳回原文（点单词或划线，定位到当初那句话）

   和后端的所有通信都通过 /api/... 接口（见 server.py）。
   ========================================================================== */

/* ============================ 1. 全局状态与工具 ============================ */

// 当前正在读的书、章节、该章的中文缓存等
const state = {
  book: null,            // {book_hash, title, ...}
  chapters: [],          // [{index, title}]
  chapterIndex: 0,       // 当前正在看的章节序号
  langMode: "en",        // 显示语言：en(原文) / dual(对照) / zh(中文)，记忆在 localStorage
  isZh: false,           // 当前书是否中文书（中文书隐藏所有翻译入口，只看原文）
  // 单章阅读：true = 正文只装当前这一章，读完点章末「下一章」再跳；
  // false（默认）= 现在的连续滚动，上下滑动自动衔接前后章。记忆在 localStorage
  singleChapter: localStorage.getItem("reader:singleChapter") === "1",
  pollTimer: null,       // 全文翻译进度轮询定时器
  // 连续滚动：正文区里已经加载了哪几章（from ~ to 闭区间）
  loadedFrom: 0,
  loadedTo: -1,
  // 按章缓存数据：{章节序号: {段序号: 中文}} / {章节序号: [划线区间]}
  chapterTranslations: {},
  chapterHighlights: {},
  // 「对照」模式按需翻译的防重：正在翻的章 / 已经尝试过的章（避免反复调用 API 花钱）
  translateInFlight: new Set(),
  translateAttempted: new Set(),
  // 阅读时长：定时器 + 这一轮攒了多久（满 30 秒上报一次，关页面前把零头补交）
  readTimer: null,
  readAccum: 0,
};

// 距离正文顶部/底部多少像素时，自动加载相邻章节（实现“无缝衔接”）
const PRELOAD_MARGIN = 500;

// 常用 DOM 元素（一次性取好，避免到处 querySelector）
const $ = (id) => document.getElementById(id);
const shelfView = $("shelf-view");
const readerView = $("reader-view");
const bookGrid = $("book-grid");
const fileInput = $("file-input");
const readerContent = $("reader-content");
const readerTitle = $("reader-title");
const selToolbar = $("sel-toolbar");
const bubble = $("bubble");
const bubbleSource = $("bubble-source");
const bubbleResult = $("bubble-result");
const noteBubble = $("note-bubble");
const noteBubbleBody = $("note-bubble-body");
const langSwitch = $("lang-switch");
const translateBar = $("translate-bar");
const translateBarFill = $("translate-bar-fill");
const translateBarText = $("translate-bar-text");
const toastEl = $("toast");
const backPanelBtn = $("btn-back-panel"); // 从词典 / 划线跳回原文后的「返回列表」按钮

/**
 * 后端接口统一封装：出错时抛出异常，消息即后端返回的中文提示。
 * body 传 FormData 表示上传文件（不设 Content-Type，交给浏览器带 boundary）。
 */
async function api(method, url, body) {
  const opts = { method };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败(${res.status})`);
  return data;
}

const apiGet = (url) => api("GET", url);
const apiPost = (url, body) => api("POST", url, body || {});
const apiDelete = (url) => api("DELETE", url);

/** 轻提示（2 秒后自动消失）。 */
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2200);
}

/** 把浮层的 (left, top) 夹进窗口内（四边各留 margin），保证它完整可见、不被裁掉。 */
function clampToWindow(left, top, w, h, margin) {
  return {
    left: Math.max(margin, Math.min(left, window.innerWidth - w - margin)),
    top: Math.max(margin, Math.min(top, window.innerHeight - h - margin)),
  };
}

/* ---- 浮窗：按住标题栏可拖动 + 阅读器里的「并排模式」（笔记页 / 词典页共用） ----
   阅读器里看笔记 / 词典时，用户要的是「边看原文边看释义」：
   浮窗不铺暗色遮罩、也不挡鼠标（见 style.css 的 .modal.panel-float），
   正文照常滚动 / 选词 / 划线，窗口本身拖到顺手的位置即可对照着看。 */

/** 让一个浮窗（.notes-box / .modal-box）可以按住标题栏（handleSelector）拖动。 */
function makePanelDraggable(box, handleSelector) {
  let drag = null;
  box.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;         // 标题栏上的返回 / 关闭按钮不算拖动
    if (!e.target.closest(handleSelector)) return;  // 只有标题栏能拖
    const r = box.getBoundingClientRect();
    // 从「flex 居中」切成固定定位，之后靠 left/top 移动
    box.style.position = "fixed";
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.margin = "0";
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    box.classList.add("panel-dragging");
    document.body.style.userSelect = "none";        // 拖动时别顺手选中标题文字
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const pos = clampToWindow(e.clientX - drag.dx, e.clientY - drag.dy,
                              box.offsetWidth, box.offsetHeight, 0);
    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
  });
  document.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    box.classList.remove("panel-dragging");
    document.body.style.userSelect = "";
  });
}

// 笔记页 / 词典页都装上拖动（脚本在 body 末尾，元素已存在）
makePanelDraggable($("notes-modal").querySelector(".notes-box"), ".notes-head");
makePanelDraggable($("dict-modal").querySelector(".notes-box"), ".notes-head");

/**
 * 切换浮窗的「并排模式」：
 *   开 → 去掉暗色遮罩、鼠标可穿透到正文，并默认停靠在窗口右侧；
 *   关 → 清掉拖动留下的定位，恢复成居中弹窗（书架页打开时就是这样）。
 */
function setPanelFloat(modal, floating) {
  const box = modal.querySelector(".notes-box, .modal-box");
  modal.classList.toggle("panel-float", floating);
  if (!floating) {
    box.style.position = box.style.left = box.style.top = box.style.margin = "";
    return;
  }
  if (!box.style.position) { // 没被拖过就先靠右停靠
    const pos = clampToWindow(window.innerWidth - box.offsetWidth - 24, 64,
                              box.offsetWidth, box.offsetHeight, 0);
    box.style.position = "fixed";
    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
  }
}

/** 关掉所有并排浮窗（返回书架时用 —— 浮窗模式点得到顶栏的「返回」）。 */
function closeFloatPanels() {
  document.querySelectorAll(".modal.panel-float:not([hidden])").forEach((m) => (m.hidden = true));
}

// 窗口尺寸变化时把开着的浮窗重新夹回可视范围，免得它跑到屏幕外
window.addEventListener("resize", () => {
  document.querySelectorAll(".modal.panel-float:not([hidden])").forEach((modal) => {
    const box = modal.querySelector(".notes-box, .modal-box");
    const pos = clampToWindow(box.offsetLeft, box.offsetTop,
                              box.offsetWidth, box.offsetHeight, 0);
    box.style.left = `${pos.left}px`;
    box.style.top = `${pos.top}px`;
  });
});

/** 视图切换：shelf（书架） / reader（阅读器）。 */
function showView(name) {
  shelfView.classList.toggle("active", name === "shelf");
  readerView.classList.toggle("active", name === "reader");
  if (name === "shelf") {
    stopTts(); // 回书架就别念了（朗读控制条也一并收起）
    hideBackPanel(); // 「返回词典 / 返回划线」也收掉
    clearJumpHighlight();
  }
  hideBubble();
  hideSelToolbar();
  // 关键：切视图时必须清掉残留的文字选区。
  // 否则回到书架后，鼠标每次松开都会命中“选区”检查，把操作栏又浮出来（用户报过的 bug）。
  const sel = window.getSelection();
  if (sel && sel.removeAllRanges) sel.removeAllRanges();
}

/* ============================ 2. 书架 ============================ */

/** 加载书库并渲染。 */
async function loadBooks() {
  try {
    const books = await apiGet("/api/books");
    bookGrid.innerHTML = "";
    $("shelf-count").textContent = books.length ? `共 ${books.length} 本` : "";
    $("shelf-empty").hidden = books.length > 0;

    books.forEach((book) => bookGrid.appendChild(makeBookCard(book)));
    renderShelfStats(books);
  } catch (err) {
    toast(err.message);
  }
}

/** 把秒数变成人话：“1 小时 23 分” / “45 分钟” / “38 秒”。 */
function fmtDuration(totalSec) {
  const sec = Math.max(0, Math.floor(totalSec || 0));
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  // 满 1 小时只到分钟；差一点的秒数四舍五入（59.6 分 → 1 小时）
  if (m >= 60) return `${h + 1} 小时`;
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}

/**
 * 渲染书库统计条：本书 / 阅读时长 / 划线。
 * 划线 chip 可以点 —— 打开「笔记」总览（用户不需要翻译/阅读进度类的显示）。
 */
function renderShelfStats(books) {
  const bar = $("shelf-stats");
  bar.innerHTML = "";
  bar.hidden = books.length === 0;
  if (!books.length) return;

  const highlights = books.reduce((s, b) => s + ((b.counts || {}).highlight || 0), 0);
  // 总阅读时长：读过（满 1 秒）才显示，没读过不放占位
  const totalSec = books.reduce((s, b) => s + (b.total_read_seconds || 0), 0);
  bar.append(
    makeStatChip(String(books.length), "本书"),
    ...(totalSec > 0 ? [makeStatChip(fmtDuration(totalSec), "阅读时长")] : []),
    makeStatChip(String(highlights), "划线", openNotesOverview),
  );
}

/** 统计条上的一张 chip；传了 onClick 就变成可点的（用来打开笔记总览）。 */
function makeStatChip(num, label, onClick) {
  const chip = document.createElement("div");
  chip.className = "stat-chip" + (onClick ? " clickable" : "");
  if (onClick) {
    chip.title = "点这里查看笔记与划线";
    chip.onclick = onClick;
  }
  const n = document.createElement("span");
  n.className = "stat-num";
  n.textContent = num;
  const l = document.createElement("span");
  l.textContent = label;
  chip.append(n, l);
  return chip;
}

/** 没有封面（或封面加载失败）时的首字色块，避免卡片留白。 */
function makeCoverFallback(titleText) {
  const div = document.createElement("div");
  div.className = "cover-fallback";
  div.textContent = (titleText || "?").trim().charAt(0).toUpperCase();
  return div;
}

/**
 * 生成一张书籍卡片：封面 + 状态徽章 + 删除按钮 + 书名 + 作者 + 划线/笔记数。
 * 点封面 = 打开这本书；点右上角垃圾桶 = 删除（会先弹确认框）。
 * 按用户要求：卡片上不放翻译进度条 / 百分比，只留一个翻译状态小徽章（提示有没有中文可看）。
 */
function makeBookCard(book) {
  const p = book.progress || {};
  const total = p.total || 0;
  const done = p.done || 0;

  const card = document.createElement("div");
  card.className = "book-card";

  // ---- 封面区 ----
  const wrap = document.createElement("div");
  wrap.className = "cover-wrap";
  wrap.onclick = () => openBook(book);

  if (book.cover_url) {
    const cover = document.createElement("img");
    cover.className = "cover";
    cover.src = book.cover_url;
    cover.alt = book.title;
    // 封面加载失败 → 换成首字色块（不再是一片空白）
    cover.onerror = () => {
      cover.remove();
      wrap.prepend(makeCoverFallback(book.title));
    };
    wrap.appendChild(cover);
  } else {
    wrap.appendChild(makeCoverFallback(book.title));
  }

  // 左上角状态徽章（只表示“翻译状态”，不显示百分比进度）
  // 中文书没有翻译概念（language = "zh"），不显示徽章
  if ((book.language || "en") !== "zh") {
    const finished = total > 0 && done >= total;
    const badge = document.createElement("span");
    badge.className = finished ? "book-badge done" : "book-badge";
    badge.textContent = finished ? "已译完" : done > 0 ? "翻译中" : "未翻译";
    wrap.appendChild(badge);
  }

  // 右上角删除按钮（垃圾桶图标）
  const del = document.createElement("button");
  del.className = "book-del";
  del.title = "删除这本书";
  del.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
  del.onclick = (e) => {
    e.stopPropagation(); // 别触发“打开这本书”
    askDeleteBook(book);
  };
  wrap.appendChild(del);

  // ---- 书名 / 作者 / 划线笔记 ----
  const title = document.createElement("div");
  title.className = "book-title";
  title.textContent = book.title;

  const sub = document.createElement("div");
  sub.className = "book-sub";
  sub.textContent =
    book.author && book.author !== "未知作者" ? book.author : `共 ${book.chapter_count || 0} 章`;

  card.append(wrap, title, sub);

  // 标注统计 + 阅读时长：有过记录才显示（0 时不占地方，卡片更干净）。「想法」功能已删除
  const c = book.counts || {};
  const bits = [];
  if ((c.highlight || 0) > 0) bits.push(`划线 ${c.highlight || 0}`);
  if ((book.total_read_seconds || 0) > 0) bits.push(`读了 ${fmtDuration(book.total_read_seconds)}`);
  if (bits.length) {
    const annos = document.createElement("div");
    annos.className = "book-annos";
    annos.textContent = bits.join("　·　");
    card.appendChild(annos);
  }
  return card;
}

/* ---- 删除书籍：先弹确认框，再调接口 ---- */

let pendingDeleteBook = null;

/** 弹出删除确认框。 */
function askDeleteBook(book) {
  pendingDeleteBook = book;
  $("confirm-text").textContent = `确定要删除《${book.title}》吗？`;
  $("confirm-modal").hidden = false;
}

$("confirm-cancel").onclick = () => {
  pendingDeleteBook = null;
  $("confirm-modal").hidden = true;
};

$("confirm-ok").onclick = async () => {
  const book = pendingDeleteBook;
  pendingDeleteBook = null;
  $("confirm-modal").hidden = true;
  if (!book) return;
  try {
    await apiDelete(`/api/books/${book.book_hash}`);
    toast("已删除");
    loadBooks();
  } catch (err) {
    toast(err.message);
  }
};

/* ---- 导入 EPUB：按钮选择文件 + 直接把文件拖到书架上，两种方式都行 ---- */

/** 统一的导入入口（按钮和拖拽都走这里）。 */
async function importEpubFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".epub")) {
    toast("只支持 .epub 格式的电子书");
    return;
  }

  const importBtn = $("btn-import");
  const importText = $("btn-import-text");
  importBtn.disabled = true;
  importText.textContent = "导入中…";
  toast("正在导入并解析，请稍候…");
  try {
    const form = new FormData();
    form.append("file", file);
    const data = await api("POST", "/api/books/import", form);
    toast(data.already_exists ? "这本书已经导入过了" : `导入成功：${data.title}`);
    loadBooks();
  } catch (err) {
    toast(err.message);
  } finally {
    importBtn.disabled = false;
    importText.textContent = "导入 EPUB";
    fileInput.value = ""; // 允许重复选择同一个文件
  }
}

/** 点击「导入 EPUB」→ 打开文件选择框。 */
$("btn-import").onclick = () => fileInput.click();

/** 选好文件后上传给后端解析入库。 */
fileInput.onchange = () => importEpubFile(fileInput.files[0]);

/* 把 .epub 文件直接拖到书架页也能导入。
   dragenter/dragleave 会在子元素间反复触发，所以用一个计数器判断“真的离开了”。 */
let dragDepth = 0;
shelfView.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth += 1;
  $("drop-hint").hidden = false;
});
shelfView.addEventListener("dragover", (e) => e.preventDefault());
shelfView.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $("drop-hint").hidden = true;
});
shelfView.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop-hint").hidden = true;
  const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
  importEpubFile(file);
});

/* ---- 书架页上的「词典」和「设置」入口 ---- */

$("btn-shelf-settings").onclick = () => openSettings();

/* ---- 书架 / 阅读器「词典」：仿笔记的两级页面（总览 → 某本书的查词明细） ---- */

let dictBook = null;        // 明细页当前正在看哪本书
let dictWords = [];         // 明细页当前这本书的查词记录
let dictOverviewItems = []; // 总览的原始记录（导出全部 / 清空全部用）

/** 在两个页面之间切换：overview（总览）/ detail（明细）。 */
function showDictPage(name) {
  $("dict-overview").hidden = name !== "overview";
  $("dict-detail").hidden = name !== "detail";
}

/**
 * 打开词典面板。
 * 书架页「词典」→ 总览；阅读器「⋯ → 词典」→ 直接看当前这本书的查词明细。
 */
async function openDictPanel(book) {
  const floating = readerView.classList.contains("active");
  $("dict-modal").hidden = false;
  setPanelFloat($("dict-modal"), floating);
  if (book) await openDictDetail(book);
  else await openDictOverview();
}

$("btn-shelf-dict").onclick = () => openDictPanel();
// 阅读器「⋯ → 词典」：就在正文旁边开着，直接看当前这本书查过哪些词
$("btn-reader-dict").onclick = () => openDictPanel(state.book || null);

/** 查词记录里「这本书」的显示名（书删了 / 老记录没记到书名 → （未分类））。 */
function dictGroupTitle(item) {
  return item.book_title || "（未分类：早期查的词，没记下书名）";
}

/** 把查词记录按「在哪本书里查的」分组；items 已按时间倒序，组的先后就是最新在前。 */
function groupDictByBook(items) {
  const groups = new Map();
  items.forEach((it) => {
    const key = it.book_hash || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  });
  return Array.from(groups.values());
}

/* ========== 页 1：总览 ========== */

/** 打开词典总览（书架「词典」/ 明细页返回键）。 */
async function openDictOverview() {
  showDictPage("overview");
  const list = $("dict-book-list");
  list.innerHTML = "";
  $("dict-overview-sub").textContent = "";
  $("dict-overview-empty").hidden = true;
  $("dict-overview-actions").hidden = true;

  let items = [];
  let books = [];
  try {
    // 记录 + 书架（拿封面）一次并行拉全；书架失败也不影响看词
    [items, books] = await Promise.all([
      apiGet("/api/dictionary/history"),
      apiGet("/api/books").catch(() => []),
    ]);
  } catch (err) {
    toast(err.message);
    return;
  }
  dictOverviewItems = items;

  const groups = groupDictByBook(items);
  const byHash = new Map(books.map((b) => [b.book_hash, b]));
  // 和笔记总览一样按书架顺序（新书在前）排；未分类 / 书已删的组放最后
  const bookOrder = new Map(books.map((b, i) => [b.book_hash, i]));
  groups.sort((a, b) => {
    const ha = a[0].book_hash || "";
    const hb = b[0].book_hash || "";
    const ia = bookOrder.has(ha) ? bookOrder.get(ha) : 1e9;
    const ib = bookOrder.has(hb) ? bookOrder.get(hb) : 1e9;
    return ia - ib;
  });
  $("dict-overview-sub").textContent = items.length
    ? `${items.length} 个词 · 查自 ${groups.length} 本书`
    : "";
  $("dict-overview-empty").hidden = items.length > 0;
  $("dict-overview-actions").hidden = items.length === 0;

  groups.forEach((group) => {
    const first = group[0];
    const hash = first.book_hash || "";
    const book = byHash.get(hash) || {
      book_hash: hash,
      title: dictGroupTitle(first),
      author: "",
      cover_url: null,
    };
    list.appendChild(makeDictBookCard(book, group));
  });
}

/** 总览里的一张书卡：大数字 + 书名 + 最近查词时间 + 封面（复用笔记总览卡 .nb-card）。 */
function makeDictBookCard(book, group) {
  const card = document.createElement("div");
  card.className = "nb-card";
  card.onclick = () => openDictDetail(book);

  const info = document.createElement("div");
  info.className = "nb-info";

  const numWrap = document.createElement("div");
  numWrap.className = "nb-count";
  const num = document.createElement("span");
  num.className = "nb-num";
  num.textContent = String(group.length);
  numWrap.append(num, document.createTextNode("个词"));

  const title = document.createElement("div");
  title.className = "nb-title";
  title.textContent = `《${book.title}》`;

  const sub = document.createElement("div");
  sub.className = "nb-sub";
  sub.textContent = group[0].looked_at
    ? `最近查词 ${group[0].looked_at.slice(0, 16)}`
    : "";

  info.append(numWrap, title, sub);
  card.appendChild(info);

  if (book.cover_url) {
    const cover = document.createElement("img");
    cover.className = "nb-cover";
    cover.src = book.cover_url;
    cover.onerror = () => cover.remove(); // 封面挂了就藏起来，别留破图
    card.appendChild(cover);
  }
  return card;
}

/* ========== 页 2：某本书的查词明细 ========== */

/** 打开某本书的查词明细（总览点卡片 / 阅读器「⋯ → 词典」）。 */
async function openDictDetail(book) {
  dictBook = book;
  $("dict-modal").hidden = false;
  setPanelFloat($("dict-modal"), readerView.classList.contains("active"));
  showDictPage("detail");

  // 先把头部 / 书籍卡填上（数据没回来前也有内容看）
  $("dd-title").textContent = `《${book.title}》`;
  $("dd-sub").textContent =
    book.author && book.author !== "未知作者" ? book.author : "";
  $("dd-num").textContent = "…";
  $("dict-detail-sub").textContent = "";
  const cover = $("dd-cover");
  if (book.cover_url) {
    cover.src = book.cover_url;
    cover.hidden = false;
    cover.onerror = () => (cover.hidden = true);
  } else {
    cover.hidden = true;
    cover.removeAttribute("src");
  }
  $("dd-search-input").value = "";
  $("dd-searchbar").hidden = true;

  try {
    const items = await apiGet("/api/dictionary/history");
    if (dictBook !== book) return; // 等待期间用户已经点开了别的书
    const hash = book.book_hash || "";
    dictWords = items.filter((it) => (it.book_hash || "") === hash);
    renderDictDetail();
  } catch (err) {
    toast(err.message);
  }
}

/** 按查询日期分组（最近的日期在前）。 */
function groupDictByDate(items) {
  const groups = new Map();
  items.forEach((it) => {
    const key = (it.looked_at || "").slice(0, 10) || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  });
  return Array.from(groups.entries()).sort((a, b) => b[0].localeCompare(a[0]));
}

/** 日期分组标题：今天 / 昨天 / 2026年10月16日。 */
function dictDateLabel(key) {
  if (key === "unknown") return "更早";
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 渲染明细：按日期分组 + 搜索过滤。 */
function renderDictDetail() {
  const box = $("dd-groups");
  box.innerHTML = "";
  const keyword = $("dd-search-input").value.trim().toLowerCase();

  const list = keyword
    ? dictWords.filter((it) => {
        const e = it.entry || {};
        const hay = [it.word, ...(e.entries || []).map((x) => x.meaning)]
          .join(" ")
          .toLowerCase();
        return hay.includes(keyword);
      })
    : dictWords;

  $("dd-num").textContent = String(dictWords.length);
  $("dict-detail-sub").textContent = dictWords.length
    ? `${dictWords.length} 个词`
    : "";

  if (!dictWords.length) {
    box.appendChild(makeNotesEmpty("这本书还没有查过词",
      "阅读时选中文字，点「词典」查过的词会收在这里"));
    return;
  }
  if (!list.length) {
    box.appendChild(makeNotesEmpty("没有匹配的单词", "换个关键词试试"));
    return;
  }

  groupDictByDate(list).forEach(([key, items]) => {
    const head = document.createElement("div");
    head.className = "nd-group-head";
    const name = document.createElement("span");
    name.textContent = dictDateLabel(key);
    const cnt = document.createElement("span");
    cnt.className = "nd-group-count";
    cnt.textContent = `${items.length} 个词`;
    head.append(name, cnt);
    box.appendChild(head);
    items.forEach((it) => box.appendChild(makeDictItem(it)));
  });
}

/** 明细里的一条词条卡片：Aa 徽章 + 单词/音标/释义/例句 + 悬停 复制/删除。 */
function makeDictItem(item) {
  const entry = item.entry || {};
  const word = (entry.word || item.word || "").trim();

  const card = document.createElement("div");
  card.className = "nd-item dict-item";

  const badge = document.createElement("span");
  badge.className = "nd-badge dict-badge";
  badge.textContent = "Aa";

  const main = document.createElement("div");
  main.className = "nd-item-main dict-item-main";

  const head = document.createElement("div");
  head.className = "dict-item-head";
  const wordEl = document.createElement("span");
  wordEl.className = "dict-item-word clickable";
  wordEl.textContent = word;
  wordEl.title = "点击跳到原文里的这句话";
  wordEl.onclick = (e) => {
    e.stopPropagation();
    jumpToDictWord(item);
  };
  head.appendChild(wordEl);
  if (entry.phonetic) {
    const ph = document.createElement("span");
    ph.className = "dict-item-phonetic";
    ph.textContent = `/${String(entry.phonetic).replace(/^\/|\/$/g, "")}/`;
    head.appendChild(ph);
  }
  main.appendChild(head);

  const entries = entry.entries || [];
  if (entries.length) {
    entries.forEach((it) => {
      const row = document.createElement("div");
      row.className = "dict-entry";
      const pos = document.createElement("span");
      pos.className = "dict-pos";
      pos.textContent = it.pos || "";
      const meaning = document.createElement("span");
      meaning.textContent = it.meaning || "";
      row.append(pos, meaning);
      main.appendChild(row);
    });
  } else {
    const row = document.createElement("div");
    row.className = "dict-entry";
    row.textContent = "（词条缓存已清空，只剩单词）";
    main.appendChild(row);
  }

  if (entry.example || entry.example_zh) {
    const ex = document.createElement("div");
    ex.className = "dict-item-example";
    if (entry.example) {
      const en = document.createElement("div");
      en.className = "en";
      en.textContent = entry.example;
      ex.appendChild(en);
    }
    if (entry.example_zh) {
      const zh = document.createElement("div");
      zh.textContent = entry.example_zh;
      ex.appendChild(zh);
    }
    main.appendChild(ex);
  }

  const when = document.createElement("div");
  when.className = "dict-item-time";
  when.textContent = item.looked_at || "";
  main.appendChild(when);

  const ops = document.createElement("div");
  ops.className = "nd-item-ops";

  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.onclick = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(word);
      toast("已复制");
    } catch (err) {
      toast("复制失败：" + err.message);
    }
  };

  const del = document.createElement("button");
  del.textContent = "删除";
  del.className = "del";
  del.onclick = async (e) => {
    e.stopPropagation();
    try {
      // 只删「查词记录」这一条；phrase_cache 里的词条缓存保留，再看同一个词不花钱
      await apiDelete(`/api/dictionary/history/word?word=${encodeURIComponent(item.word)}`);
      dictWords = dictWords.filter(
        (x) => x.word.toLowerCase() !== item.word.toLowerCase()
      );
      renderDictDetail(); // 列表立刻少一条
      toast("已删除");
    } catch (err) {
      toast(err.message);
    }
  };

  ops.append(copy, del);
  card.append(badge, main, ops);
  return card;
}

/* ---- 导出 / 复制用的纯文本 ---- */

/** 一组查词记录 → 纯文本（书名 + 逐条：单词 / 音标 / 词性释义 / 例句）。 */
function dictGroupToText(group) {
  if (!group.length) return "";
  const lines = [`《${dictGroupTitle(group[0])}》查词记录`, "-".repeat(32)];
  group.forEach((item) => {
    const e = item.entry || {};
    lines.push("", (e.word || item.word || "").trim());
    if (e.phonetic) lines.push(`  /${String(e.phonetic).replace(/^\/|\/$/g, "")}/`);
    (e.entries || []).forEach((it) => lines.push(`  ${it.pos || ""} ${it.meaning || ""}`.trim()));
    if (e.example) lines.push(`  例：${e.example}`);
    if (e.example_zh) lines.push(`      ${e.example_zh}`);
  });
  return lines.join("\n");
}

/** 下载一个纯文本文件（文件名里的非法字符先清掉）。 */
function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 导出某一本书的查词记录。 */
function exportDictGroup(group) {
  if (!group.length) return;
  const title = String(dictGroupTitle(group[0])).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  downloadText(`${title} - 查词记录.txt`, dictGroupToText(group));
  toast(`已导出「${title}」的 ${group.length} 个词`);
}

/* ---- 总览 / 明细的功能按钮 ---- */

// 导出全部（按书分段）
$("dict-export-all").onclick = async () => {
  let items = [];
  try {
    items = await apiGet("/api/dictionary/history");
  } catch (err) {
    return toast(err.message);
  }
  if (!items.length) return toast("还没有查过词");
  const groups = groupDictByBook(items);
  downloadText("查词记录.txt", groups.map(dictGroupToText).join("\n\n\n"));
  toast(`已导出全部 ${items.length} 个词`);
};

// 清空全部（只清记录，词典缓存不动；和旧版行为一致，不额外弹确认）
$("dict-clear-all").onclick = async () => {
  if (!dictOverviewItems.length) return toast("还没有查过词");
  try {
    await apiDelete("/api/dictionary/history");
    toast("查词记录已清空");
    openDictOverview();
  } catch (err) {
    toast(err.message);
  }
};

// 明细：搜索 / 复制全部 / 导出本书
$("dd-act-search").onclick = () => {
  const bar = $("dd-searchbar");
  bar.hidden = !bar.hidden;
  if (!bar.hidden) {
    $("dd-search-input").focus();
  } else {
    $("dd-search-input").value = "";
    renderDictDetail();
  }
};
$("dd-search-input").oninput = () => renderDictDetail();

$("dd-act-copy").onclick = async () => {
  if (!dictWords.length) return toast("这本书还没有查过词");
  try {
    await navigator.clipboard.writeText(dictGroupToText(dictWords));
    toast(`已复制 ${dictWords.length} 个词`);
  } catch (err) {
    toast("复制失败：" + err.message);
  }
};

$("dd-act-export").onclick = () => {
  if (!dictWords.length) return toast("这本书还没有查过词");
  exportDictGroup(dictWords);
};

// 返回总览 / 关闭整个词典
$("btn-dict-back").onclick = () => openDictOverview();
$("dict-overview-close").onclick = () => ($("dict-modal").hidden = true);
$("dict-detail-close").onclick = () => ($("dict-modal").hidden = true);

/** 查词成功后刷新已经打开的词典面板：总览刷计数，明细刷当前书。 */
function refreshDictPanel() {
  if ($("dict-modal").hidden) return;
  if (!$("dict-detail").hidden && dictBook) {
    apiGet("/api/dictionary/history")
      .then((items) => {
        if (!dictBook) return;
        const hash = dictBook.book_hash || "";
        dictWords = items.filter((it) => (it.book_hash || "") === hash);
        renderDictDetail();
      })
      .catch(() => {});
  } else {
    openDictOverview();
  }
}


/** 打开一本书，进入阅读器。 */
async function openBook(book) {
  stopTts(); // 上一次的朗读（如果还在）先停掉，免得换书了还在念旧内容
  hideBackPanel(); // 换书了就不再显示上一本书的「返回词典 / 返回划线」
  clearJumpHighlight();
  state.book = book;
  // 语种：中文书（如四大名著）没有翻译概念 —— 隐藏语言开关 / 全文翻译，只看原文
  state.isZh = (book.language || "en") === "zh";
  applyLangModeForBook();
  // 恢复上次选的阅读方式：单章阅读 / 连续滚动
  readerView.classList.toggle("single-chapter", state.singleChapter);
  syncSingleChapterUI();
  state.chapterIndex = 0;
  // 换书时重置「按需翻译」的防重集合（显示语言沿用上次选择，见 setLangMode）
  state.translateInFlight.clear();
  state.translateAttempted.clear();
  readerTitle.textContent = book.title;
  showView("reader");
  // 打开书时先把顶部栏露一下（让用户知道控件在这），之后靠鼠标位置控制显隐
  showChromeTemporarily(2200);

  // 加载目录，然后把进度恢复到上次读到的章节
  try {
    state.chapters = await apiGet(`/api/books/${book.book_hash}/chapters`);
  } catch (err) {
    state.chapters = [{ index: 0, title: "正文" }];
  }
  const saved = parseInt(localStorage.getItem(`progress:${book.book_hash}`) || "0", 10);
  const startIndex = Math.min(saved || 0, Math.max(0, state.chapters.length - 1));

  // 清掉上一本书残留的缓存，从上次读到的章节开始加载
  state.chapterTranslations = {};
  state.chapterHighlights = {};
  try {
    await resetToChapter(startIndex);
  } catch (err) {
    toast(`加载失败：${err.message}`);
  }

  // 同步一次翻译进度（如果之前翻过一部分，直接显示开关可用）
  refreshTranslateState();

  // 开始给这本书计时（书架上看得到读了多久）
  startReadTimer();
}

/* ======================= 阅读时长统计 ======================= */

// 每攒满 30 秒向服务器报一次（心跳）；窗口切走 / 最小化 / 点了别的窗口时不计时
const READ_HEARTBEAT = 30;

/** 开始给当前这本书计时（打开书时调用）。 */
function startReadTimer() {
  stopReadTimer(); // 保险：先把可能残留的计时器停掉
  state.readAccum = 0;
  state.readTimer = setInterval(() => {
    // 只有“正看着这个页面”才算阅读：切走标签页 / 最小化 / 点了别的窗口都暂停
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    state.readAccum += 1;
    if (state.readAccum >= READ_HEARTBEAT) {
      reportReadTime(READ_HEARTBEAT);
      state.readAccum -= READ_HEARTBEAT;
    }
  }, 1000);
}

/** 停止计时，把没报完的零头一起补交（返回书架时调用）。 */
function stopReadTimer() {
  if (state.readTimer) {
    clearInterval(state.readTimer);
    state.readTimer = null;
  }
  // 零头够 15 秒才值得发一次请求；太少就不计较了
  if (state.readAccum >= READ_HEARTBEAT / 2 && state.book) {
    reportReadTime(Math.round(state.readAccum));
  }
  state.readAccum = 0;
}

/** 把秒数报给服务器（失败静默，不影响阅读）。 */
function reportReadTime(seconds) {
  if (!state.book || seconds <= 0) return;
  apiPost(`/api/books/${state.book.book_hash}/readtime`, { seconds }).catch(() => {});
}

// 关页面 / 刷新时的保底：用浏览器自带的 sendBeacon，页面关了也能把零头送到
window.addEventListener("pagehide", () => {
  if (!state.book || state.readAccum <= 0) return;
  const payload = JSON.stringify({ seconds: Math.min(300, Math.round(state.readAccum)) });
  navigator.sendBeacon(
    `/api/books/${state.book.book_hash}/readtime`,
    new Blob([payload], { type: "application/json" })
  );
  state.readAccum = 0;
});

/** 用户上次选的显示语言（英文书打开时恢复用；中文书强制原文，不动这个值）。 */
let savedLangMode = "en";

/** 刷新顶部「原文 / 对照 / 中文」三段控件的选中态。 */
function syncLangSwitch() {
  langSwitch.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.langMode);
  });
}

/**
 * 按当前书的语种决定显示模式与翻译入口：
 *   中文书 → 强制原文模式，隐藏「语言开关 / 全文翻译」，选字操作栏不显示 词典 / 翻译；
 *   英文书 → 恢复用户上次选的显示模式，翻译入口全部可见。
 */
function applyLangModeForBook() {
  langSwitch.hidden = state.isZh;
  $("btn-translate-book").hidden = state.isZh;
  $("btn-reader-dict").hidden = state.isZh; // 词典只查英文，中文书不给入口
  $("btn-tts").hidden = state.isZh; // 朗读只读英文原文，中文书不给入口
  selToolbar.querySelector('[data-action="translate"]').hidden = state.isZh;
  selToolbar.querySelector('[data-action="dictionary"]').hidden = state.isZh;
  if (state.isZh) {
    state.langMode = "en"; // 只看原文；刻意不写 localStorage，不影响英文书的记忆
  } else {
    state.langMode = savedLangMode;
  }
  // 朗读只读英文原文：中文书、以及英文书切到「中文」显示时都不给这个按钮
  selToolbar.querySelector('[data-action="tts"]').hidden =
    state.isZh || state.langMode === "zh";
  syncLangSwitch();
}

/* ============================ 3. 阅读器（连续滚动） ============================ */
/*
   关于“连续滚动”：
     正文区 #reader-content 里可以同时装着多个 <section class="chapter">，
     每滚动到接近底部就自动把下一章追加进来，接近顶部就把上一章插到前面。
     这样上下滑动时章节自然衔接，不会出现“只能看这一章”的情况。
*/

/** 向后端要一章的数据（HTML + 中文缓存 + 划线）。 */
function fetchChapter(index) {
  return apiGet(`/api/books/${state.book.book_hash}/chapter/${index}`);
}

/** 把一章的数据做成一个 <section class="chapter"> 区块。 */
function makeChapterSection(index, data) {
  const sec = document.createElement("section");
  sec.className = "chapter";
  sec.dataset.chapter = String(index);

  const divider = document.createElement("div");
  divider.className = "chapter-divider";
  divider.textContent =
    (state.chapters[index] && state.chapters[index].title) || `第 ${index + 1} 章`;

  const inner = document.createElement("div");
  inner.className = "inner";
  inner.innerHTML = data.html || "";

  // 章内注释角标（如《红楼梦》的 [1]）：点击不跳转，弹出注释内容气泡。
  // 角标 <a href="本章.html#mN"> 与注释 <a id="mN"> 在同一段 HTML 里，
  // 目标 id 在本章内找得到 → 弹气泡；找不到（跨章引用）→ 只拦截不动作，
  // 绝不真的跳转（那些相对地址在服务器上不存在，跳了就是 404）。
  inner.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (!href.includes("#")) return; // 普通外链不拦
    e.preventDefault();
    e.stopPropagation();
    const m = href.match(/#(.+)$/);
    const target = m && inner.querySelector(`a[id="${CSS.escape(m[1])}"]`);
    if (!target) return;
    showChapterNote(target, a.getBoundingClientRect());
  });

  // 记下每一段的“原文”，之后切换中文 / 还原划线都靠它
  inner.querySelectorAll("span.seg").forEach((span) => {
    span.dataset.orig = span.textContent;
  });

  sec.append(divider, inner);

  // 单章阅读的章末翻页条：平时由 CSS 隐藏，开启单章阅读才显示。
  // 读完这一章点「下一章」才跳；「上一章」同理（目录也能跳）。
  if (state.chapters.length > 1) {
    const nav = document.createElement("div");
    nav.className = "chapter-nav";

    const prev = document.createElement("button");
    prev.type = "button";
    prev.dataset.delta = "-1";
    prev.textContent = "‹ 上一章";
    prev.disabled = index <= 0;

    const info = document.createElement("span");
    info.className = "chapter-nav-info";
    info.textContent = `第 ${index + 1} / ${state.chapters.length} 章`;

    const next = document.createElement("button");
    next.type = "button";
    next.dataset.delta = "1";
    next.textContent = "下一章 ›";
    next.disabled = index >= state.chapters.length - 1;

    nav.append(prev, info, next);
    sec.appendChild(nav);
  }

  // 缓存该章的中文与划线，再按当前模式渲染一遍
  state.chapterTranslations[index] = data.translations || {};
  state.chapterHighlights[index] = data.highlights || [];
  rerenderSection(sec); // 统一入口：按当前显示模式渲染（含对照译文块）

  return sec;
}

/** 取已加载的某一章区块。 */
function chapterSection(index) {
  return readerContent.querySelector(`section.chapter[data-chapter="${index}"]`);
}

/** 在正文末尾追加下一章。 */
async function appendChapter(index) {
  if (index > state.chapters.length - 1) return false;
  readerContent.appendChild(makeChapterSection(index, await fetchChapter(index)));
  state.loadedTo = index;
  // 对照模式下，新加载的章节若没译文则按需补翻
  if (state.langMode === "dual") ensureChapterTranslated(index);
  return true;
}

/** 在正文开头插入上一章，并修正滚动位置（否则画面会“跳”一下）。 */
async function prependChapter(index) {
  if (index < 0) return false;
  const heightBefore = readerContent.scrollHeight;
  const topBefore = readerContent.scrollTop;
  readerContent.insertBefore(makeChapterSection(index, await fetchChapter(index)),
                             readerContent.firstChild);
  state.loadedFrom = index;
  readerContent.scrollTop = topBefore + (readerContent.scrollHeight - heightBefore);
  // 对照模式下，新加载的章节若没译文则按需补翻
  if (state.langMode === "dual") ensureChapterTranslated(index);
  return true;
}

/** 清空正文区，从某一章重新开始（打开书 / 点目录跳转时用）。 */
async function resetToChapter(index) {
  stopTts(); // 跳章后原来的朗读内容已经不在正文里了，先停掉（打开书时这里本来就是停着的）
  const sec = makeChapterSection(index, await fetchChapter(index)); // 先拿到数据再清空
  readerContent.innerHTML = "";
  readerContent.appendChild(sec);
  state.loadedFrom = index;
  state.loadedTo = index;
  state.chapterIndex = index;
  readerContent.scrollTop = 0;
  updateCurrentChapterUI();
  autoLoadAdjacent(); // 万一一章填不满屏幕，继续补下一章
  // 对照模式下，先把当前这一章按需翻好
  if (state.langMode === "dual") ensureChapterTranslated(index);
}

/** 单章阅读：点章末「上一章 / 下一章」再跳（带防连点，避免快速点击加载两章）。 */
let chapterJumping = false;
async function jumpToChapter(index) {
  if (chapterJumping) return;
  chapterJumping = true;
  try {
    await resetToChapter(index);
  } catch (err) {
    toast(`加载失败：${err.message}`);
  } finally {
    chapterJumping = false;
  }
}

readerContent.addEventListener("click", (e) => {
  const btn = e.target.closest(".chapter-nav button[data-delta]");
  if (!btn || btn.disabled || !state.singleChapter) return;
  const sec = btn.closest("section.chapter");
  const ci = sec ? parseInt(sec.dataset.chapter, 10) : state.chapterIndex;
  const target = ci + parseInt(btn.dataset.delta, 10);
  if (target < 0 || target >= state.chapters.length) return;
  jumpToChapter(target);
});

/** 区块相对正文区顶部的像素位置（用于跳转与进度计算）。 */
function sectionTop(sec) {
  return sec.getBoundingClientRect().top - readerContent.getBoundingClientRect().top
    + readerContent.scrollTop;
}

/* 说明：不再需要「上一章 / 下一章」按钮 —— 上下滚动会自动衔接相邻章节，
   需要跳转时用右上角「目录」。 */

/**
 * 检查是否需要衔接相邻章节。
 * 滚动时调用；每次成功加载新章后也会再调一次（链式）——
 * 因为有的章节很短，一屏没填满就没法再滚动，必须主动继续加载。
 */
let loadingAdjacent = false;
async function autoLoadAdjacent() {
  // 单章阅读：正文只装当前这一章，绝不自动补前后章
  // （否则「对照」模式会顺手把下一章也翻译了，既花钱又容易翻到用户还没看的内容）
  if (state.singleChapter || loadingAdjacent || !state.book) return;

  const nearBottom = readerContent.scrollTop + readerContent.clientHeight
    >= readerContent.scrollHeight - PRELOAD_MARGIN;
  const nearTop = readerContent.scrollTop <= PRELOAD_MARGIN;

  try {
    if (nearBottom && state.loadedTo < state.chapters.length - 1) {
      loadingAdjacent = true;
      await appendChapter(state.loadedTo + 1);
    } else if (nearTop && state.loadedFrom > 0) {
      loadingAdjacent = true;
      await prependChapter(state.loadedFrom - 1);
    } else {
      return; // 不需要再加载
    }
  } catch (err) {
    return; // 加载失败不要打断阅读，下次滚动会再试
  } finally {
    loadingAdjacent = false;
  }

  updateCurrentChapterUI();
  autoLoadAdjacent(); // 内容还不够填满屏幕 → 继续加载下一章
}

/** 滚动事件。 */
function onReaderScroll() {
  updateCurrentChapterUI();
  autoLoadAdjacent();
  hideSelToolbar(); // 滚动时收起浮出的操作栏，免得它停在原地
  hideNoteBubble(); // 注释气泡也随滚动收起（角标已经不在原位了）
  // 说明：顶部栏不再因滚动而强制显示 —— 它只在鼠标移到窗口最顶部时才滑出（更沉浸）
}
readerContent.addEventListener("scroll", onReaderScroll);

/** 判断“当前在看第几章”，并刷新标题 / 底部进度 / 阅读位置记忆。 */
function updateCurrentChapterUI() {
  const secs = Array.from(readerContent.querySelectorAll("section.chapter"));
  if (!secs.length || !state.book) return;

  const line = readerContent.scrollTop + 80; // 以正文区上方 80px 处为准
  let cur = secs[0];
  for (const sec of secs) {
    if (sectionTop(sec) <= line) cur = sec;
    else break;
  }
  const ci = parseInt(cur.dataset.chapter, 10);
  state.chapterIndex = ci;

  readerTitle.textContent = (state.chapters[ci] && state.chapters[ci].title) || state.book.title;
  localStorage.setItem(`progress:${state.book.book_hash}`, String(ci));
}

/* ---- 沉浸式顶部栏：平时隐藏，鼠标移到窗口最顶部才滑出 + 「更多」菜单 + 全屏按钮 ---- */

const CHROME_ZONE = 50;   // 鼠标进入窗口顶部这 50px 内，顶部栏就滑出
const moreDropdown = $("more-dropdown");

let lastMouseY = 0;        // 记录鼠标纵坐标（用于“露一下再收起”的判断）
let chromeGrace = false;   // 刚打开书的一小段“宽限期”，期间不因鼠标位置立刻收起
let chromeShowTimer = null;

/** 直接设置顶部栏显示 / 隐藏（收起动画由 CSS 的 .chrome-hidden 负责）。 */
function setChromeVisible(visible) {
  readerView.classList.toggle("chrome-hidden", !visible);
}

/** 显示顶部栏（打开书、切换全屏时用）。 */
function showChrome() {
  if (state.book) setChromeVisible(true);
}

/** 打开书时用：先把顶部栏露出来一下，让用户知道控件在这里；之后交给鼠标位置控制。 */
function showChromeTemporarily(ms) {
  chromeGrace = true;
  setChromeVisible(true);
  clearTimeout(chromeShowTimer);
  chromeShowTimer = setTimeout(() => {
    chromeGrace = false;
    if (state.book && lastMouseY > CHROME_ZONE) setChromeVisible(false);
  }, ms);
}

// 核心：鼠标贴到窗口最顶部 → 滑出顶部栏；鼠标在下面 → 收起，专心阅读
document.addEventListener("mousemove", (e) => {
  lastMouseY = e.clientY;
  if (!state.book) return;
  if (e.clientY <= CHROME_ZONE) {
    setChromeVisible(true);
    return;
  }
  if (chromeGrace) return; // 刚打开书的一小会儿，先别收起
  // 下拉菜单 / 普通弹窗打开时不收起，否则它们会被跟着藏掉。
  // 并排浮窗（.panel-float）不算：它不挡鼠标，顶栏照常按鼠标位置自动隐藏，读着更沉浸。
  if (!moreDropdown.hidden) return;
  if (document.querySelector(".modal:not([hidden]):not(.panel-float)")) return;
  setChromeVisible(false);
});

/** 展开 / 收起「更多」下拉菜单；展开时把它对齐到「⋯」按钮正下方。 */
function setMoreMenu(open) {
  moreDropdown.hidden = !open;
  if (!open) return;
  const rect = $("btn-more").getBoundingClientRect();
  moreDropdown.style.top = `${rect.bottom + 6}px`;
  moreDropdown.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
}

$("btn-more").onclick = (e) => {
  e.stopPropagation(); // 不要触发下面“点别处收起”的判断
  setMoreMenu(moreDropdown.hidden);
};
// 点菜单里的任意一项后自动收起
moreDropdown.addEventListener("click", () => setMoreMenu(false));
// 点菜单以外的地方 ⇒ 收起
document.addEventListener("mousedown", (e) => {
  if (!moreDropdown.hidden && !e.target.closest("#more-dropdown") &&
      !e.target.closest("#btn-more")) {
    setMoreMenu(false);
  }
});

/* ---- 单章阅读开关（⋯ 菜单第一项） ---- */

/** 刷新菜单文字：让用户一眼知道现在是开还是关。 */
function syncSingleChapterUI() {
  const btn = $("btn-single-chapter");
  if (!btn) return;
  btn.textContent = state.singleChapter ? "单章阅读：开" : "单章阅读：关";
  btn.title = state.singleChapter
    ? "当前只显示一章；点章末「下一章」才跳转"
    : "当前是连续滚动；点一下改成单章阅读";
}

/** 切换 单章阅读 / 连续滚动（两种方式都保留，随时可换）。 */
function setSingleChapter(on) {
  if (state.singleChapter === on) return;
  state.singleChapter = on;
  localStorage.setItem("reader:singleChapter", on ? "1" : "0");
  readerView.classList.toggle("single-chapter", on);
  syncSingleChapterUI();
  if (!state.book) return;

  stopTts(); // 切换阅读方式时先停朗读，避免念到已经被移走的章节
  if (on) {
    // 把当前这一章单独装回来（去掉已经预载的前后章），滚动回到本章开头
    resetToChapter(state.chapterIndex).catch((err) =>
      toast(`切换失败：${err.message}`)
    );
    toast("已开启单章阅读：读完点章末「下一章」再跳转");
  } else {
    toast("已切回连续滚动：上下滑动自动衔接");
    autoLoadAdjacent(); // 当前章太短的话，先补下一章把屏幕填满
  }
}

$("btn-single-chapter").onclick = () => {
  setSingleChapter(!state.singleChapter);
};

/** 「沉浸」按钮：进入 / 退出全屏（全屏后浏览器标签栏、地址栏都会隐藏）。 */
$("btn-immersive").onclick = async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    toast("当前浏览器不允许全屏：" + err.message);
  }
  showChrome();
};

document.addEventListener("fullscreenchange", () => {
  $("btn-immersive").textContent = document.fullscreenElement ? "退出沉浸" : "沉浸";
  showChrome();
});

/** 返回书架。 */
$("btn-back").onclick = () => {
  stopPolling();
  stopReadTimer(); // 停止计时并补交零头，书架上的时长才是最新的
  setMoreMenu(false);
  clearTimeout(chromeShowTimer);
  chromeGrace = false;
  readerView.classList.remove("chrome-hidden");
  closeFloatPanels(); // 阅读器里开着的笔记 / 词典浮窗一并收掉（并排模式下顶栏是点得到的）
  state.book = null;
  showView("shelf");
  loadBooks(); // 返回时刷新一下进度显示
};

/* ============================ 4. 点选翻译 ============================ */

// 记录最近一次选中文字，供气泡里的动作（书签/笔记/划线）使用
let lastSelection = { text: "", segIndex: null };

// 记录“按下鼠标那一刻”的选区文本与坐标：
// 用来区分「用户真的在选字」和「只是点了正文空白处」——后者浏览器不会清掉已有选区，
// 不判断的话操作栏会被反复重新浮出来（用户反馈的“关不掉 / 一直存在”问题的根因）。
let selectionTextAtMouseDown = "";
let mouseDownPoint = { x: 0, y: 0 };

document.addEventListener("mousedown", (e) => {
  const s = window.getSelection();
  selectionTextAtMouseDown = s ? s.toString().trim() : "";
  mouseDownPoint = { x: e.clientX, y: e.clientY };
});

/** 鼠标松开时判断是否有“新选中”的文字。 */
document.addEventListener("mouseup", (e) => {
  // 点在气泡、浮出操作栏、弹窗上时不处理
  // （用可选链：合成事件 / 拖到 document 上时 target 可能没有 closest）
  if (e.target.closest?.("#bubble") || e.target.closest?.("#sel-toolbar") ||
      e.target.closest?.(".modal")) return;

  // 只有在阅读器页面才浮出操作栏（书架页不该出现；#reader-content 隐藏时仍在 DOM 里，
  // 不加这个判断的话，残留选区会让操作栏在书架页反复冒出来）
  if (!readerView.classList.contains("active")) {
    hideSelToolbar();
    return;
  }

  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : "";

  if (!text || !isSelectionInsideContent(sel)) {
    hideSelToolbar();
    return;
  }

  // 判断这次是“拖拽选字”还是“原地点击”：
  //   拖拽（鼠标有明显位移）或选区内容变了 → 用户确实在选字，浮出操作栏；
  //   原地点击且选区没变 → 只是碰了下正文，收起操作栏（不要重新浮出）。
  const moved =
    Math.abs(e.clientX - mouseDownPoint.x) + Math.abs(e.clientY - mouseDownPoint.y) > 4;
  if (!moved && text === selectionTextAtMouseDown) {
    hideSelToolbar();
    return;
  }
  showSelToolbar(sel);
});

/** 判断选区是否落在正文区域内（避免选中工具栏文字）。 */
function isSelectionInsideContent(sel) {
  if (!sel.rangeCount) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  return readerContent.contains(node.nodeType === 3 ? node.parentNode : node);
}

/**
 * 在选区旁边浮出操作栏（复制 / 划线 / 想法 / 翻译），并保证它完整落在窗口内。
 *
 * 默认放在选区**下方**：因为浏览器（Chrome）自带的"选中文字浮条"一般出现在选区**上方**，
 * 我们放下面才不会和它重叠、被它压住导致点不到（用户反馈过这个问题）。
 * 下面实在放不下时，才退回放到上方。
 */
function showSelToolbar(sel) {
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selToolbar.hidden = false;
  selToolbar.style.display = "flex"; // 内联样式显隐（不依赖 CSS，缓存过期也不会失效）
  const w = selToolbar.offsetWidth;
  const h = selToolbar.offsetHeight;

  // 默认放选区下方（浏览器自带浮条在上方，放下面才不会被它压住）；下方放不下才改放上方
  let top = rect.bottom + 10;
  if (top + h > window.innerHeight - 8) top = rect.top - h - 10;
  const pos = clampToWindow(rect.left + rect.width / 2 - w / 2, top, w, h, 8);
  selToolbar.style.left = `${pos.left}px`;
  selToolbar.style.top = `${pos.top}px`;
  scheduleSelToolbarHide(); // 浮出后开始倒计时，闲置几秒自动消失
}

// 闲置自动收起：用户希望操作栏“用完能关掉 / 自动消失”，免得一直挡住正文。
let selToolbarTimer = null;

function scheduleSelToolbarHide() {
  clearTimeout(selToolbarTimer);
  selToolbarTimer = setTimeout(hideSelToolbar, 4000);
}

function hideSelToolbar() {
  clearTimeout(selToolbarTimer);
  selToolbar.hidden = true;
  selToolbar.style.display = "none"; // 双保险：用内联样式强制隐藏，避免旧 CSS 缓存导致操作栏卡在页面上
}

/** 取选区所在的“段”（span.seg）的序号，用于标注定位。 */
function segIndexFromSelection(sel) {
  if (!sel || !sel.anchorNode) return null;
  let node = sel.anchorNode;
  if (node.nodeType === 3) node = node.parentNode;
  const seg = node.closest ? node.closest(".seg") : null;
  return seg ? parseInt(seg.dataset.i, 10) : null;
}

/** 取选区所在段落的原文，作为翻译时的上下文。 */
function contextFromSelection(sel) {
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentNode;
  const p = node && node.closest ? node.closest("p") : null;
  return p ? p.textContent.trim().slice(0, 500) : "";
}

/**
 * 当前查词选区所在的「哪一章、哪一段」（存进查词记录）。
 * 词典面板里点这个词时，阅读器据此跳回当初查词的原文位置。
 */
function currentSelectionLocation() {
  const segIndex = lastSelection.segIndex;
  if (segIndex === null || segIndex === undefined || !state.book) return {};
  const seg = readerContent.querySelector(
    `span.seg[data-i="${CSS.escape(String(segIndex))}"]`
  );
  if (!seg) return {};
  return { chapter_index: chapterIndexOf(seg), seg_index: segIndex };
}

/**
 * 浮出操作栏上的按钮：
 *   复制   → 复制选中的原文
 *   划线   → 给选中的这几个字加底色（不用先翻译！）
 *   词典   → 弹出词典气泡
 *   翻译   → 弹出译文气泡
 *   朗读   → 只把选中的这段念出来（读完就停，不接着读全文）
 */
selToolbar.addEventListener("mousedown", (e) => e.preventDefault()); // 防止点击时选区被取消
// 鼠标在操作栏上移动 → 重新计时，避免用户正要点击时它自己先消失了
selToolbar.addEventListener("mousemove", scheduleSelToolbarHide);
selToolbar.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  if (!state.book) return;

  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : "";
  if (!text) return hideSelToolbar();

  lastSelection = {
    text,
    segIndex: segIndexFromSelection(sel),
    context: contextFromSelection(sel),
  };
  const rect = sel.getRangeAt(0).getBoundingClientRect();

  try {
    if (action === "copy") {
      await navigator.clipboard.writeText(text);
      toast("已复制原文");
    } else if (action === "highlight") {
      await highlightSelection();
      toast("已划线");
    } else if (action === "dictionary") {
      hideSelToolbar();
      showDictionary(rect, text);
      return;
    } else if (action === "translate") {
      hideSelToolbar();
      showBubble(rect, text);
      return;
    } else if (action === "tts") {
      // 只读刚选中的这段文字，读完就停（不会接着读全文）
      hideSelToolbar();
      startTtsSelection(sel);
      return;
    }
  } catch (err) {
    toast(err.message);
  }
  hideSelToolbar();
});

/** 气泡锚点（译文返回后用它重新贴合选区）；bubbleMoved 记录用户是否手动拖过。 */
let bubbleAnchorRect = null;
let bubbleMoved = false;

/** 显示气泡（先显示“正在翻译…”，再异步替换为结果）。 */
function showBubble(rect, sourceText) {
  bubbleSource.textContent = sourceText;
  bubbleResult.textContent = "正在翻译…";
  bubbleResult.className = "bubble-result loading";
  bubble.hidden = false;

  bubbleAnchorRect = rect;
  bubbleMoved = false;
  placeBubble();

  // 请求翻译
  apiPost("/api/translate", { text: sourceText, context: lastSelection.context || "" })
    .then((data) => {
      bubbleResult.textContent = data.translation;
      bubbleResult.className = "bubble-result";
      if (!bubbleMoved) placeBubble(); // 译文变长后重新摆位，保证整段可见
    })
    .catch((err) => {
      bubbleResult.textContent = err.message;
      bubbleResult.className = "bubble-result error";
      if (!bubbleMoved) placeBubble();
    });
}

/* ---- 词典查词：查选中单词/短语的英汉释义（后端带缓存，查过的词不再花钱） ---- */

/** 在气泡里展示词典结果。 */
function showDictionary(rect, word) {
  bubbleSource.textContent = word;
  bubbleResult.textContent = "查询中…";
  bubbleResult.className = "bubble-result loading";
  bubble.hidden = false;

  bubbleAnchorRect = rect;
  bubbleMoved = false;
  placeBubble();

  // 带上 book_hash：查词记录按"在哪本书里查的"分格显示（词典面板里一组一本书）
  // 带上章节 / 段落：以后在词典面板里点这个词，可以直接跳回原文里的那句话
  const loc = currentSelectionLocation();
  apiPost("/api/dictionary", {
    text: word,
    book_hash: state.book ? state.book.book_hash : "",
    chapter_index: loc.chapter_index,
    seg_index: loc.seg_index,
  })
    .then((entry) => {
      renderDictionary(entry);
      // 词典面板开着的话同步刷新，刚查的词会排在最前面（面板 = 查词记录）
      if (!$("dict-modal").hidden) refreshDictPanel();
      if (!bubbleMoved) placeBubble(); // 内容变高后重新摆位，保证整条可见
    })
    .catch((err) => {
      bubbleResult.textContent = err.message;
      bubbleResult.className = "bubble-result error";
      if (!bubbleMoved) placeBubble();
    });
}

/**
 * 把词条渲染到容器里（都用 DOM 拼，避免 HTML 注入）。
 * 默认渲染进翻译气泡；词典面板 / 笔记条目会传自己的容器进来。
 *
 * opts.compact = 笔记条目下用：上面就是划线的词本身，不再重复显示单词，
 *               也不带例句（几十条划线各带一句例句会把列表撑得很长）。
 */
function renderDictionary(entry, container, opts) {
  const box = container || bubbleResult;
  const compact = !!(opts && opts.compact);
  if (box === bubbleResult) box.className = "bubble-result"; // 气泡里才用气泡的样式
  box.textContent = "";

  // 第一行：词 + 音标（紧凑版只留音标，单词本身上面已经有了）
  if (!compact || entry.phonetic) {
    const head = document.createElement("div");
    head.className = "dict-head";
    if (!compact) {
      const wordEl = document.createElement("span");
      wordEl.className = "dict-word";
      wordEl.textContent = entry.word || "";
      head.appendChild(wordEl);
    }
    if (entry.phonetic) {
      const ph = document.createElement("span");
      ph.className = "dict-phonetic";
      ph.textContent = `/${String(entry.phonetic).replace(/^\/|\/$/g, "")}/`;
      head.appendChild(ph);
    }
    box.appendChild(head);
  }

  // 释义行：词性 + 中文
  const entries = entry.entries || [];
  entries.forEach((it) => {
    const row = document.createElement("div");
    row.className = "dict-entry";
    const pos = document.createElement("span");
    pos.className = "dict-pos";
    pos.textContent = it.pos || "";
    const meaning = document.createElement("span");
    meaning.textContent = it.meaning || "";
    row.append(pos, meaning);
    box.appendChild(row);
  });
  if (!entries.length) {
    const row = document.createElement("div");
    row.className = "dict-entry";
    row.textContent = "（没查到释义，换一个词试试）";
    box.appendChild(row);
  }

  // 例句（紧凑版不带，笔记列表要短）
  if (entry.example && !compact) {
    const ex = document.createElement("div");
    ex.className = "dict-example";
    const en = document.createElement("div");
    en.className = "dict-example-en";
    en.textContent = entry.example;
    ex.appendChild(en);
    if (entry.example_zh) {
      const zh = document.createElement("div");
      zh.textContent = entry.example_zh;
      ex.appendChild(zh);
    }
    box.appendChild(ex);
  }
}

/**
 * 把气泡摆到选区旁边，并保证它完整落在窗口内：
 * 下方放不下就改放上方；上方也放不下就贴顶（此时气泡内部可上下滚动）。
 */
function placeBubble() {
  if (bubble.hidden || !bubbleAnchorRect) return;
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const rect = bubbleAnchorRect;

  let top = rect.bottom + 10;
  if (top + h > window.innerHeight - 12) {
    top = rect.top - h - 10;          // 优先改放到选区上方
  }
  // 兜底：无论如何都把气泡夹在窗口内，保证整段译文都能看到（不会被窗口底部裁掉）。
  // 因为气泡本身有 max-height:70vh，h 一定小于窗口高度，所以夹取后必定完整可见。
  const pos = clampToWindow(rect.left + rect.width / 2 - w / 2, top, w, h, 12);
  bubble.style.left = `${pos.left}px`;
  bubble.style.top = `${pos.top}px`;
}

function hideBubble() {
  bubble.hidden = true;
  bubbleAnchorRect = null;
}

/* ---- 气泡拖动：按住气泡任意空白处就能把它拖到别处 ---- */
let bubbleDrag = null;

bubble.addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) return; // 点在按钮上不触发拖动
  const r = bubble.getBoundingClientRect();
  bubbleDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
  e.preventDefault();                     // 防止拖动时误选中气泡里的文字
  document.body.style.userSelect = "none";
});

document.addEventListener("mousemove", (e) => {
  if (!bubbleDrag) return;
  bubbleMoved = true;
  const pos = clampToWindow(e.clientX - bubbleDrag.dx, e.clientY - bubbleDrag.dy,
                            bubble.offsetWidth, bubble.offsetHeight, 4);
  bubble.style.left = `${pos.left}px`;
  bubble.style.top = `${pos.top}px`;
});

document.addEventListener("mouseup", () => {
  if (!bubbleDrag) return;
  bubbleDrag = null;
  document.body.style.userSelect = "";
});

// 点击别处：关闭气泡（译文/注释）+ 收起浮出的操作栏（操作栏内部点按不受影响）
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#bubble")) hideBubble();
  if (!e.target.closest("#sel-toolbar")) hideSelToolbar();
  if (!e.target.closest("#note-bubble")) hideNoteBubble();
});

// 按 Esc 收起气泡 / 操作栏 / 菜单，并关闭打开中的弹窗（目录/设置/笔记/词典/确认框）
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideBubble();
    hideSelToolbar();
    hideNoteBubble();
    setMoreMenu(false);
    document.querySelectorAll(".modal:not([hidden])").forEach((m) => (m.hidden = true));
  }
});

/* ============================ 5. 显示语言：原文 / 对照 / 中文 ============================ */

/** 转义 HTML 特殊字符（重建 innerHTML 时必须转义，否则会破坏正文结构）。 */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 合并重叠 / 相邻的划线区间，并按位置排序。 */
function mergeRanges(pairs, maxLen) {
  const list = pairs
    .map((p) => [Math.max(0, Math.min(p[0], maxLen)), Math.max(0, Math.min(p[1], maxLen))])
    .filter((p) => p[1] > p[0])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of list) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** 取某一段（span.seg）所在章节的序号。 */
function chapterIndexOf(span) {
  const sec = span.closest("section.chapter");
  return sec ? parseInt(sec.dataset.chapter, 10) : state.chapterIndex;
}

/**
 * 按当前模式渲染某一段：
 *   中文模式 → 整段换成译文；
 *   原文模式 → 显示英文，并把“划线区间”精确包进 <mark>（只标选中的那几个字）。
 */
function renderSegText(span) {
  const i = span.dataset.i;
  const ci = chapterIndexOf(span);
  const orig = span.dataset.orig !== undefined ? span.dataset.orig : span.textContent;
  const zh = (state.chapterTranslations[ci] || {})[i];

  if (state.langMode === "zh" && zh) {
    span.textContent = zh;
    span.classList.add("is-translated");
    return;
  }
  span.classList.remove("is-translated");

  const ranges = (state.chapterHighlights[ci] || []).filter(
    (h) => String(h.seg_index) === String(i)
  );
  if (!ranges.length) {
    span.textContent = orig;
    return;
  }

  // 旧数据没有 start/end 时，退回“整段划线”
  const pairs = ranges.map((h) =>
    (h.start === null || h.start === undefined || h.end === null || h.end === undefined)
      ? [0, orig.length]
      : [h.start, h.end]
  );

  let html = "";
  let cursor = 0;
  for (const [s, e] of mergeRanges(pairs, orig.length)) {
    html += escapeHtml(orig.slice(cursor, s));
    html += `<mark class="hl">${escapeHtml(orig.slice(s, e))}</mark>`;
    cursor = e;
  }
  html += escapeHtml(orig.slice(cursor));
  span.innerHTML = html;
}

/** 取某个 span 所属的“可翻译块”（对照模式按这个块插入整段中文）。 */
function blockOf(span) {
  return span.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, div");
}

/**
 * 对照模式：为每个英文段落插入一段紧跟其下的整段中文译文块（.seg-zh）。
 *
 * 为什么按“块”而不是按单个 span.seg：
 *   一个自然段（<p>）可能被拆成多个 span.seg（中间夹了 <b>/<a> 等），
 *   对照时要显示的是“整段中文”，所以把该块内所有 seg 的译文按文档顺序拼接起来。
 * 进入 / 退出对照模式都会先把旧的 .seg-zh 全部清掉，保证不留残影。
 */
function renderDualBlocks(sec) {
  sec.querySelectorAll(".seg-zh").forEach((el) => el.remove());
  if (state.langMode !== "dual") return;

  const ci = parseInt(sec.dataset.chapter, 10);
  const inner = sec.querySelector(".inner") || sec;
  const seen = new Set();

  inner.querySelectorAll("span.seg").forEach((span) => {
    const blk = blockOf(span);
    // 跳过异常情形（找不到块 / 块就是正文容器本身）
    if (!blk || blk === inner || seen.has(blk)) return;
    seen.add(blk);

    const zh = Array.from(blk.querySelectorAll("span.seg"))
      .map((s) => (state.chapterTranslations[ci] || {})[s.dataset.i] || "")
      .join("")
      .trim();
    if (!zh) return; // 这一段还没有译文 → 不显示译文块（不占位）

    const div = document.createElement("div");
    div.className = "seg-zh";
    div.textContent = zh; // 用 textContent 赋值，避免任何注入风险
    blk.insertAdjacentElement("afterend", div);
  });
}

/** 统一的“按章重绘”入口：先按模式渲染每个段，再按模式增删对照译文块。 */
function rerenderSection(sec) {
  sec.querySelectorAll("span.seg").forEach(renderSegText);
  renderDualBlocks(sec);
}

/** 重新渲染正文区里所有章节（切语言 / 划线变化 / 译文刷新后调用）。 */
function rerenderAllSegs() {
  readerContent.querySelectorAll("section.chapter").forEach(rerenderSection);
}

/* ---- 「重排时别把滚动位置弄丢」----
   用户反馈：点「原文 / 对照」时画面会往上或往下跳，得自己滑回原来的地方。
   原因：对照模式会在每段英文下面插一整块中文（.seg-zh），切成原文又全删掉；
   正文上方的高度一变，同样的 scrollTop 看到的内容就整个窜位了。
   而 #reader-content 又关掉了浏览器自带的滚动锚定（overflow-anchor: none，
   见 style.css —— 那个是为了手动修正"向上补载章节"的滚动位置），所以这里自己锚：
     ① 记住"视口顶部那一行"（span.seg）离正文区顶部的距离；
     ② 重排完再量一次，把差值补进 scrollTop —— 眼睛盯着的那一行原地不动。 */

/** 记下当前"视口顶部那一行"的锚点（找不到就返回 null）。 */
function captureReadingAnchor() {
  const top = readerContent.getBoundingClientRect().top;
  for (const sec of readerContent.querySelectorAll("section.chapter")) {
    if (sec.getBoundingClientRect().bottom <= top + 1) continue; // 整章都已经滚到视口上方，跳过
    for (const seg of sec.querySelectorAll("span.seg")) {
      const r = seg.getBoundingClientRect();
      if (r.bottom > top + 1) return { seg, gap: r.top - top };
    }
  }
  return null;
}

/** 把滚动位置补回锚点行的原位（重排结束后调用）。 */
function restoreReadingAnchor(anchor) {
  if (!anchor || !anchor.seg.isConnected) return;
  const top = readerContent.getBoundingClientRect().top;
  const delta = anchor.seg.getBoundingClientRect().top - top - anchor.gap;
  if (Math.abs(delta) < 1) return; // 位置本来就没变 → 别动，免得抖一下
  const max = Math.max(0, readerContent.scrollHeight - readerContent.clientHeight);
  readerContent.scrollTop = Math.max(0, Math.min(readerContent.scrollTop + delta, max));
}

/** 带着「阅读位置保持不变」跑一次重排。 */
function rerenderKeepingPosition(render) {
  const anchor = captureReadingAnchor();
  render();
  restoreReadingAnchor(anchor);
}

/** 已加载章节里是否已有中文。 */
function hasAnyTranslation() {
  return Object.values(state.chapterTranslations).some((m) => Object.keys(m).length > 0);
}

/** 应用显示语言模式：en(原文) / dual(对照) / zh(中文)。 */
function setLangMode(mode) {
  if (mode !== "en" && mode !== "dual" && mode !== "zh") mode = "en";
  state.langMode = mode;
  savedLangMode = mode; // 记住英文书的显示模式（中文书会强制原文，不走这里）
  localStorage.setItem("reader:langMode", mode); // 记住选择，下次打开还是这个模式

  syncLangSwitch(); // 刷新顶部三段控件的选中态
  // 「朗读」只读英文原文：切到「中文」显示时把选字栏里的按钮藏起来
  selToolbar.querySelector('[data-action="tts"]').hidden = state.isZh || mode === "zh";

  // 纯本地重排，不重新请求数据；带着锚点重排 —— 切原文 / 对照时当前这一行不会跑掉
  rerenderKeepingPosition(rerenderAllSegs);

  if (mode === "zh" && state.book && !hasAnyTranslation()) {
    toast("还没有中文，请点击「全文翻译」，或切到「对照」自动翻译");
  }
  if (mode === "dual") {
    ensureLoadedChaptersTranslated(); // 对照模式：把在读章节里还没翻的补上
  }
}

/** 顶部「原文 / 对照 / 中文」三段控件的点击事件。 */
langSwitch.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) setLangMode(btn.dataset.mode);
});

/* ============================ 6. 全文翻译 ============================ */

/** 点击「全文翻译」。 */
$("btn-translate-book").onclick = async () => {
  if (!state.book) return;
  try {
    const progress = await apiPost(`/api/books/${state.book.book_hash}/translate`, {});
    renderTranslateProgress(progress);
    startPolling();
  } catch (err) {
    toast(err.message);
  }
};

/** 点击「停止」。 */
$("btn-cancel-translate").onclick = async () => {
  if (!state.book) return;
  try {
    await apiPost(`/api/books/${state.book.book_hash}/translate/cancel`, {});
    toast("正在停止，已翻译的部分会保留");
  } catch (err) {
    toast(err.message);
  }
};

/** 把进度对象渲染到顶部进度条。 */
function renderTranslateProgress(p) {
  const total = p.total || 0;
  const done = p.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  translateBar.hidden = false;
  translateBarFill.style.width = `${percent}%`;
  translateBarText.textContent = `${p.message || "正在翻译…"}（${done}/${total} 段）`;
}

/** 开始轮询翻译进度。 */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.book) return stopPolling();
    try {
      const p = await apiGet(`/api/books/${state.book.book_hash}/translate/progress`);
      renderTranslateProgress(p);
      if (p.status !== "running") {
        stopPolling();
        if (p.status === "done" || p.status === "cancelled") {
          // 翻译结束：重新拉取已加载章节的中文，让开关立即可用
          await reloadLoadedChapters();
          setTimeout(() => (translateBar.hidden = true), 1500);
        }
        if (p.status === "error") toast(p.message || "翻译出错");
      }
    } catch (err) {
      stopPolling();
    }
  }, 1500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/** 重新拉取“已加载章节”的中文与划线并重绘（全文翻译完成后调用）。 */
async function reloadLoadedChapters() {
  if (!state.book) return;
  const secs = Array.from(readerContent.querySelectorAll("section.chapter"));
  for (const sec of secs) {
    const ci = parseInt(sec.dataset.chapter, 10);
    try {
      const data = await fetchChapter(ci);
      state.chapterTranslations[ci] = data.translations || {};
      state.chapterHighlights[ci] = data.highlights || [];
      rerenderKeepingPosition(() => rerenderSection(sec));
    } catch (err) {
      /* 单章失败不影响其它章 */
    }
  }
}

/** 进入书时检查一下历史翻译进度（决定是否提示）。 */
async function refreshTranslateState() {
  if (!state.book || state.isZh) return; // 中文书没有翻译概念
  try {
    const p = await apiGet(`/api/books/${state.book.book_hash}/translate/progress`);
    if (p.status === "running") {
      renderTranslateProgress(p);
      startPolling();
    }
  } catch (err) {
    /* 忽略 */
  }
}

/* ---------------- 「对照」模式的按需翻译：只翻“在读且还没译文”的章节 ---------------- */

/** 某章是否还有段落缺译文（用于判断要不要触发按需翻译）。 */
function chapterNeedsTranslation(ci) {
  const sec = chapterSection(ci);
  if (!sec) return false;
  const trans = state.chapterTranslations[ci] || {};
  const segs = sec.querySelectorAll("span.seg");
  if (!segs.length) return false;
  for (const s of segs) {
    if (!trans[s.dataset.i]) return true; // 只要有一段没译文就需要翻
  }
  return false;
}

/**
 * 按需翻译一章（对照模式用）。
 * 去重 + 失败不重试：避免用户来回滚动时反复调用 API 花钱。
 */
async function ensureChapterTranslated(ci) {
  if (!state.book || state.langMode !== "dual") return;
  if (state.translateInFlight.has(ci) || state.translateAttempted.has(ci)) return;
  if (!chapterNeedsTranslation(ci)) return;

  state.translateInFlight.add(ci);
  state.translateAttempted.add(ci);
  toast("正在翻译本章…");
  try {
    const data = await apiPost(
      `/api/books/${state.book.book_hash}/chapter/${ci}/translate`, {});
    state.chapterTranslations[ci] = data.translations || {};
    state.chapterHighlights[ci] = data.highlights || {};
    const sec = chapterSection(ci);
    // 译文到位后立刻重绘、插入对照译文块；插在上方的译文会改高度，所以同样要锚住阅读位置
    if (sec) rerenderKeepingPosition(() => rerenderSection(sec));
  } catch (err) {
    toast(err.message);
  } finally {
    state.translateInFlight.delete(ci);
  }
}

/** 对照模式下，把“当前已加载的所有章节”里缺译文的都补翻一遍（串行，省并发）。 */
async function ensureLoadedChaptersTranslated() {
  if (!state.book || state.langMode !== "dual") return;
  // 整本书的全文翻译正在跑：不重复翻译，等它的进度轮询结束后统一刷新
  if (state.pollTimer) return;
  const secs = Array.from(readerContent.querySelectorAll("section.chapter"));
  for (const sec of secs) {
    const ci = parseInt(sec.dataset.chapter, 10);
    await ensureChapterTranslated(ci);
  }
}

/* ============================ 7. 标注：划线 ============================ */

/** 气泡里的动作按钮（复制 / 划线）。 */
bubble.addEventListener("click", async (e) => {
  const action = e.target.dataset.action;
  if (!action || !state.book) return;

  try {
    if (action === "copy") {
      await navigator.clipboard.writeText(bubbleResult.textContent);
      toast("译文已复制");
      return;
    }
    if (action === "highlight") {
      await highlightSelection();
      toast("已划线");
    }
  } catch (err) {
    toast(err.message);
  }
});

/* ---- 章内注释气泡（点角标弹出，可拖动，不遮挡阅读） ---- */

let noteBubbleDrag = null; // 拖动状态：{startX, startY, baseLeft, baseTop}

/** 隐藏注释气泡。 */
function hideNoteBubble() {
  noteBubble.hidden = true;
}

/**
 * 显示 / 重新摆放注释气泡。
 * :param rect: 被点角标的屏幕位置 —— 气泡默认出现在角标上方居中，
 *              越界时自动收进窗口；用户拖过之后记住位置（本章节内）。
 */
function placeNoteBubble(rect) {
  const bw = noteBubble.offsetWidth;
  const bh = noteBubble.offsetHeight;
  // 默认出现在角标上方居中；上方放不下就改放到下方
  let top = rect.top - bh - 10;
  if (top < 12) top = rect.bottom + 10;
  const pos = clampToWindow(rect.left + rect.width / 2 - bw / 2, top, bw, bh, 12);
  noteBubble.style.left = `${pos.left}px`;
  noteBubble.style.top = `${pos.top}px`;
}

/**
 * 点了章内注释角标：从章末注释段落里取出注释文本，弹气泡。
 * 注释段落结构：<p class="note"><a id="mN"></a>[N] 注释内容…</p>
 * 文本取整段并去掉其中的回链 <a>，只留注释文字本身。
 */
function showChapterNote(anchorEl, anchorRect) {
  const p = anchorEl.closest("p") || anchorEl.parentElement;
  if (!p) return;
  const clone = p.cloneNode(true);
  clone.querySelectorAll("a").forEach((x) => x.remove());
  const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return toast("没有找到这条注释的内容");

  const box = document.createElement("div");
  box.textContent = text;
  noteBubbleBody.innerHTML = "";
  noteBubbleBody.appendChild(box);
  noteBubble.hidden = false;
  placeNoteBubble(anchorRect); // 先显示才有尺寸，再按角标位置摆放
}

// 注释气泡标题栏：按住拖动（只在气泡已显示时生效）
noteBubble.addEventListener("mousedown", (e) => {
  if (noteBubble.hidden) return;
  const head = e.target.closest(".note-bubble-head");
  if (!head || e.target.closest("button")) return; // 点关闭按钮不算拖动
  e.preventDefault();
  noteBubbleDrag = {
    startX: e.clientX,
    startY: e.clientY,
    baseLeft: noteBubble.offsetLeft,
    baseTop: noteBubble.offsetTop,
  };
});

document.addEventListener("mousemove", (e) => {
  if (!noteBubbleDrag) return;
  // 拖动时气泡可能超出窗口：限制在可视范围内
  const pos = clampToWindow(
    noteBubbleDrag.baseLeft + e.clientX - noteBubbleDrag.startX,
    noteBubbleDrag.baseTop + e.clientY - noteBubbleDrag.startY,
    noteBubble.offsetWidth, noteBubble.offsetHeight, 8);
  noteBubble.style.left = `${pos.left}px`;
  noteBubble.style.top = `${pos.top}px`;
});

document.addEventListener("mouseup", () => (noteBubbleDrag = null));

// 点气泡内的关闭按钮
$("note-bubble-close").onclick = hideNoteBubble;

/** 计算某个节点在“整段拼接文本”里的字符位置。 */
function textOffsetIn(span, node, offset) {
  if (node.nodeType === 3) {
    // 文本节点：累加它之前所有文本节点的长度
    let total = 0;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + offset;
      total += n.nodeValue.length;
    }
    return total;
  }
  // 元素节点：offset 表示“第几个子节点”，累加它前面子节点的文字长度
  let total = 0;
  for (let k = 0; k < offset && k < node.childNodes.length; k++) {
    total += node.childNodes[k].textContent.length;
  }
  return Math.min(total, span.textContent.length);
}

/**
 * 给“用户真正选中的那段文字”精确划线，并保存到后端。
 * 关键点：这里算出的是选区在段内的字符区间 [start, end)，
 *        所以只给这几个字加底色，而不是整段。
 */
async function highlightSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  if (state.langMode === "zh") {
    toast("中文模式下无法精确定位划线，请先切回「原文」或「对照」");
    return;
  }

  const range = sel.getRangeAt(0);
  const spans = Array.from(readerContent.querySelectorAll("span.seg"))
    .filter((span) => range.intersectsNode(span));

  for (const span of spans) {
    const i = parseInt(span.dataset.i, 10);
    const ci = chapterIndexOf(span);
    const orig = span.dataset.orig !== undefined ? span.dataset.orig : span.textContent;

    // 该段与选区重叠的字符区间（默认整段，再按选区两端收紧）
    let start = 0;
    let end = orig.length;
    if (span.contains(range.startContainer)) {
      start = textOffsetIn(span, range.startContainer, range.startOffset);
    }
    if (span.contains(range.endContainer)) {
      end = textOffsetIn(span, range.endContainer, range.endOffset);
    }
    if (end <= start) continue;

    const picked = orig.slice(start, end);

    // ① 本地立即生效
    (state.chapterHighlights[ci] = state.chapterHighlights[ci] || []).push({
      seg_index: i, start, end,
    });
    renderSegText(span);

    // ② 存到后端（下次打开这本书仍然看得到）
    try {
      await apiPost(`/api/books/${state.book.book_hash}/annotations`, {
        type: "highlight", chapter_index: ci, seg_index: i,
        start, end, text: picked.slice(0, 200),
      });
    } catch (err) {
      toast(err.message);
    }
  }
}

/* ---- 笔记 / 划线：仿微信读书的两级页面（总览 → 某本书的明细） ---- */

let notesBook = null;   // 详情页当前正在看哪本书
let notesAll = [];      // 该书全部划线
let notesChapters = []; // 该书目录（[{index,title}]，取章节标题用）

/** 在两个页面之间切换：overview（总览）/ detail（明细）。 */
function showNotesPage(name) {
  $("notes-overview").hidden = name !== "overview";
  $("notes-detail").hidden = name !== "detail";
}

/* ========== 页 1：总览 ========== */

/** 打开笔记总览（书架页「笔记」按钮 / 统计 chip / 明细页的返回键）。 */
async function openNotesOverview() {
  $("notes-modal").hidden = false;
  // 在阅读器里打开 → 并排浮窗（可拖动、只浮在上面不占正文的位，边读边看笔记）
  setPanelFloat($("notes-modal"), readerView.classList.contains("active"));
  showNotesPage("overview");
  try {
    // 每本书的划线/笔记数量和封面都在 /api/books 里，一次拿全
    const books = await apiGet("/api/books");
    renderNotesOverview(books);
  } catch (err) {
    toast(err.message);
  }
}

/** 渲染总览：只显示留了划线的书，每本一张卡。 */
function renderNotesOverview(books) {
  const list = $("notes-book-list");
  list.innerHTML = "";
  const withNotes = books.filter((b) => ((b.counts || {}).highlight || 0) > 0);
  const total = withNotes.reduce((s, b) => s + ((b.counts || {}).highlight || 0), 0);
  $("notes-overview-sub").textContent = withNotes.length
    ? `${total} 条划线 · 留在了 ${withNotes.length} 本书上`
    : "";
  $("notes-overview-empty").hidden = withNotes.length > 0;

  withNotes.forEach((book) => list.appendChild(makeNotesBookCard(book)));
}

/** 总览里的一张书卡：大数字 + 书名 + 封面。 */
function makeNotesBookCard(book) {
  const count = (book.counts || {}).highlight || 0;

  const card = document.createElement("div");
  card.className = "nb-card";
  card.onclick = () => openNotesDetail(book);

  const info = document.createElement("div");
  info.className = "nb-info";

  const numWrap = document.createElement("div");
  numWrap.className = "nb-count";
  const num = document.createElement("span");
  num.className = "nb-num";
  num.textContent = String(count);
  numWrap.append(num, document.createTextNode("条划线"));

  const title = document.createElement("div");
  title.className = "nb-title";
  title.textContent = `《${book.title}》`;

  info.append(numWrap, title);
  card.appendChild(info);

  if (book.cover_url) {
    const cover = document.createElement("img");
    cover.className = "nb-cover";
    cover.src = book.cover_url;
    cover.onerror = () => cover.remove(); // 封面挂了就藏起来，别留破图
    card.appendChild(cover);
  }
  return card;
}

/* ========== 页 2：明细 ========== */

/** 打开某本书的笔记明细（总览点卡片 / 阅读器「⋯ → 笔记 / 划线」）。 */
async function openNotesDetail(book) {
  notesBook = book;
  $("notes-modal").hidden = false;
  // 在阅读器里打开 → 并排浮窗（可拖动、只浮在上面不占正文的位，边读边看笔记）
  setPanelFloat($("notes-modal"), readerView.classList.contains("active"));
  showNotesPage("detail");

  // 先把头部 / 书籍卡填上（数据没回来前也有内容看）
  $("nd-title").textContent = `《${book.title}》`;
  $("nd-sub").textContent =
    book.author && book.author !== "未知作者" ? book.author : "";
  $("nd-num").textContent = "…";
  $("notes-detail-sub").textContent = "";
  const cover = $("nd-cover");
  if (book.cover_url) {
    cover.src = book.cover_url;
    cover.hidden = false;
    cover.onerror = () => (cover.hidden = true);
  } else {
    cover.hidden = true;
  }
  $("nd-search-input").value = "";
  $("nd-searchbar").hidden = true;

  try {
    // 标注列表 + 目录（拿章节标题）并行拉；目录拉失败不碍事（退回“第 N 章”）
    const [annos, chapters] = await Promise.all([
      apiGet(`/api/books/${book.book_hash}/annotations`),
      apiGet(`/api/books/${book.book_hash}/chapters`).catch(() => []),
    ]);
    if (notesBook !== book) return; // 等待期间用户已经点开了别的书
    notesAll = annos.filter((a) => a.type === "highlight"); // 笔记页只管划线
    notesChapters = chapters;
    renderNotesDetail();
  } catch (err) {
    toast(err.message);
  }
}

/** 章节名：优先用目录标题。 */
function noteChapterName(ci) {
  const ch = notesChapters.find((c) => c.index === ci);
  return (ch && ch.title) || `第 ${ci + 1} 章`;
}

/** 把标注按章节分组，返回按章节序号升序排好的 [章节序号, 条目数组] 列表。 */
function groupByChapter(items) {
  const byChapter = new Map();
  items.forEach((a) => {
    if (!byChapter.has(a.chapter_index)) byChapter.set(a.chapter_index, []);
    byChapter.get(a.chapter_index).push(a);
  });
  return Array.from(byChapter.keys())
    .sort((x, y) => x - y)
    .map((ci) => [ci, byChapter.get(ci)]);
}

/* ---- 笔记条目下的词典释义（功能行的「释义」开关） ----
   划线的多是单词 / 短语，正好能用词典查：音标 + 词性 + 中文意思。
   查过的词服务端有缓存，再查不花钱；这里批量查的词**不写进「查词记录」**
   （接口带 record:false），词典面板里只留用户自己主动查过的词。 */
let notesDictOn = localStorage.getItem("reader:notesDict") !== "0"; // 默认开（用户要求笔记里能看词义）
const NOTE_DICT_MAXLEN = 60;      // 后端词典接口的上限：只适合单词 / 短语
const NOTE_DICT_CONCURRENCY = 3;  // 一次最多 3 个请求，别把后端和钱包一起压垮
const noteDictCache = new Map();  // 词 → 词条（本地缓存：重渲染 / 再打开都是秒出）
const noteDictFailed = new Map(); // 词 → 失败原因（同一次会话里不反复重试）
const noteDictBoxes = new Map();  // 词 → 正在等结果的词条区（同一个词可能出现在多条里）
const noteDictQueue = [];
let noteDictRunning = 0;

/** 给一条划线的词条区取释义：先查本地缓存，没有就排队请求。 */
function fillNoteDict(word, box) {
  if (!word) return;
  if (noteDictCache.has(word)) {
    renderDictionary(noteDictCache.get(word), box, { compact: true });
    return;
  }
  if (noteDictFailed.has(word)) return showNoteDictMsg(box, noteDictFailed.get(word));
  if (word.length > NOTE_DICT_MAXLEN) {
    return showNoteDictMsg(box, "整句太长，词典只查单词或短语（可点上面的「翻译」看整句）");
  }

  box.textContent = "正在查词…";
  const waiting = noteDictBoxes.get(word);
  if (waiting) {
    waiting.push(box); // 这个词已经排上队了，跟着一起填
    return;
  }
  noteDictBoxes.set(word, [box]);
  noteDictQueue.push(word);
  pumpNoteDictQueue();
}

/** 并发地把队列里的词查完（结果同时填给所有等它的词条区）。 */
function pumpNoteDictQueue() {
  while (noteDictRunning < NOTE_DICT_CONCURRENCY && noteDictQueue.length) {
    const word = noteDictQueue.shift();
    noteDictRunning += 1;
    apiPost("/api/dictionary", { text: word, record: false }) // 批量查词不记进「查词记录」
      .then((entry) => {
        noteDictCache.set(word, entry);
        (noteDictBoxes.get(word) || []).forEach(
          (box) => renderDictionary(entry, box, { compact: true }));
      })
      .catch((err) => {
        noteDictFailed.set(word, err.message);
        (noteDictBoxes.get(word) || []).forEach((box) => showNoteDictMsg(box, err.message));
      })
      .finally(() => {
        noteDictBoxes.delete(word);
        noteDictRunning -= 1;
        updateNoteDictTip();
        pumpNoteDictQueue();
      });
  }
  updateNoteDictTip();
}

/** 词条区里显示一句提示（太长 / 查询失败）。 */
function showNoteDictMsg(box, msg) {
  box.textContent = msg;
}

/** 更新功能行下方的「释义」状态提示（只在还在查询时显示进度，查完就收起）。 */
function updateNoteDictTip() {
  const tip = $("nd-dict-tip");
  const left = noteDictQueue.length + noteDictRunning;
  if (!notesDictOn || !notesAll.length || left <= 0) {
    tip.hidden = true;
    tip.textContent = "";
    return;
  }
  tip.hidden = false;
  tip.textContent = `正在查释义…还剩 ${left} 个（查过的词不会再花钱）`;
}

/** 渲染明细：按章分组 + 搜索过滤。 */
function renderNotesDetail() {
  const box = $("nd-groups");
  box.innerHTML = "";
  const keyword = $("nd-search-input").value.trim().toLowerCase();

  const list = keyword
    ? notesAll.filter((a) => (a.text || "").toLowerCase().includes(keyword))
    : notesAll;

  $("nd-num").textContent = String(notesAll.length);
  $("notes-detail-sub").textContent = notesAll.length
    ? `${notesAll.length} 条划线`
    : "";
  $("nd-act-dict").classList.toggle("active", notesDictOn); // 开关当前是开是关

  if (!notesAll.length) {
    box.appendChild(makeNotesEmpty("这本书还没有划线",
      "阅读时选中文字，点「划线」就会出现在这里"));
    updateNoteDictTip();
    return;
  }
  if (!list.length) {
    box.appendChild(makeNotesEmpty("没有匹配的内容", "换个关键词试试"));
    updateNoteDictTip();
    return;
  }

  // 按章节分组（升序），组头 = 章节名 + 条数
  groupByChapter(list).forEach(([ci, items]) => {
    const head = document.createElement("div");
    head.className = "nd-group-head";
    const name = document.createElement("span");
    name.textContent = noteChapterName(ci);
    const cnt = document.createElement("span");
    cnt.className = "nd-group-count";
    cnt.textContent = `${items.length} 条`;
    head.append(name, cnt);
    box.appendChild(head);

    items.forEach((a) => box.appendChild(makeNoteItem(a)));
  });
  updateNoteDictTip();
}

/** 空状态块（总览/明细/搜索无结果共用）。 */
function makeNotesEmpty(titleText, tipText) {
  const empty = document.createElement("div");
  empty.className = "notes-page-empty";
  const t = document.createElement("p");
  t.className = "notes-empty-title";
  t.textContent = titleText;
  const tip = document.createElement("p");
  tip.className = "notes-empty-tip";
  tip.textContent = tipText;
  empty.append(t, tip);
  return empty;
}

/** 明细里的一条划线卡片：徽章 + 原文 + 词义（可选）+ 悬停 复制/删除。 */
function makeNoteItem(a) {
  const word = (a.text || "").replace(/\s+/g, " ").trim(); // 去掉换行/多余空格，查词典更准

  const li = document.createElement("div");
  li.className = "nd-item";

  const badge = document.createElement("span");
  badge.className = "nd-badge hl";
  badge.textContent = "A";

  const main = document.createElement("div");
  main.className = "nd-item-main";

  const text = document.createElement("div");
  text.className = "nd-item-text";
  text.textContent = word || "（无内容）";
  if (word) {
    // 点划线文字 → 跳回原文里这句话的位置，方便对照原句
    text.classList.add("clickable");
    text.title = "点击跳到原文里的这句话";
    text.onclick = (e) => {
      e.stopPropagation();
      jumpToNote(a);
    };
  }
  main.appendChild(text);

  // 词典释义（「释义」开关打开时有）：词条渲染复用阅读器气泡那套
  if (notesDictOn && word) {
    const dict = document.createElement("div");
    dict.className = "nd-item-dict";
    main.appendChild(dict);
    fillNoteDict(word, dict);
  }

  const ops = document.createElement("div");
  ops.className = "nd-item-ops";

  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.onclick = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(a.text || "");
      toast("已复制");
    } catch (err) {
      toast("复制失败：" + err.message);
    }
  };

  const del = document.createElement("button");
  del.textContent = "删除";
  del.className = "del";
  del.onclick = async (e) => {
    e.stopPropagation();
    try {
      await apiDelete(`/api/annotations/${a.id}`);
      notesAll = notesAll.filter((x) => x.id !== a.id);
      renderNotesDetail(); // 列表立刻少一条
      await repaintHighlightAfterDelete(a); // 正文里的黄色底色同步清掉
      toast("已删除");
    } catch (err) {
      toast(err.message);
    }
  };

  ops.append(copy, del);
  li.append(badge, main, ops);
  return li;
}

/**
 * 删除一条划线后，把阅读器正文里的底色同步清掉：
 * ① 先从内存缓存里去掉并重绘；② 再按服务器该章最新数据重绘一次（双保险）。
 * 只在“被删的这本书正开着”时才需要做。
 */
async function repaintHighlightAfterDelete(a) {
  if (!state.book || !notesBook || state.book.book_hash !== notesBook.book_hash) return;
  const ci = a.chapter_index;
  if (a.type === "highlight" && Array.isArray(state.chapterHighlights[ci])) {
    state.chapterHighlights[ci] = state.chapterHighlights[ci].filter(
      (h) => !(String(h.seg_index) === String(a.seg_index) &&
               (h.start ?? null) === (a.char_start ?? null) &&
               (h.end ?? null) === (a.char_end ?? null))
    );
    rerenderAllSegs();
  }
  if (chapterSection(ci)) {
    const fresh = await fetchChapter(ci);
    state.chapterTranslations[ci] = fresh.translations || {};
    state.chapterHighlights[ci] = fresh.highlights || [];
    rerenderAllSegs();
  }
}

/** 全部划线拼成纯文本（复制 / 导出用）。刻意用纯文本，不加 Markdown 标题。 */
function allNotesToText() {
  const lines = [`《${notesBook.title}》划线`, "-".repeat(32)];
  groupByChapter(notesAll).forEach(([ci, items]) => {
    lines.push("", noteChapterName(ci), "-".repeat(24));
    items.forEach((a) => {
      const t = (a.text || "").replace(/\s+/g, " ").trim();
      if (t) lines.push(t);
    });
  });
  return lines.join("\n");
}

/* ---- 入口按钮 ---- */

// 书架页「笔记」→ 总览
$("btn-shelf-notes").onclick = () => openNotesOverview();

// 阅读器「⋯ → 笔记 / 划线」→ 直接看当前这本的明细
$("btn-notes").onclick = () => {
  if (state.book) openNotesDetail(state.book);
};

// 明细页 ← → 回总览（重新拉一遍计数，删除/新增之后数字才是新的）
$("btn-notes-back").onclick = () => openNotesOverview();

// 总览页 / 明细页的「×」→ 关闭整个笔记页
$("notes-overview-close").onclick = () => ($("notes-modal").hidden = true);
$("notes-detail-close").onclick = () => ($("notes-modal").hidden = true);

// 「释义」开关：给每条划线显示 / 收起词典释义（状态记在 localStorage，下次打开照旧）
$("nd-act-dict").onclick = () => {
  notesDictOn = !notesDictOn;
  localStorage.setItem("reader:notesDict", notesDictOn ? "1" : "0");
  if (notesDictOn) noteDictFailed.clear(); // 重新打开时给之前失败的词一次机会
  renderNotesDetail();
};

// 搜索：点「搜索笔记」展开/收起输入框，输入即过滤
$("nd-act-search").onclick = () => {
  $("nd-searchbar").hidden = !$("nd-searchbar").hidden;
  if (!$("nd-searchbar").hidden) {
    $("nd-search-input").focus();
  } else {
    $("nd-search-input").value = "";
    renderNotesDetail();
  }
};
$("nd-search-input").oninput = () => renderNotesDetail();

// 复制全部
$("nd-act-copy").onclick = async () => {
  if (!notesAll.length) return toast("还没有可复制的内容");
  try {
    await navigator.clipboard.writeText(allNotesToText());
    toast(`已复制 ${notesAll.length} 条`);
  } catch (err) {
    toast("复制失败：" + err.message);
  }
};

// 导出全部 → 一个 .txt（下载工具函数与词典导出共用）
$("nd-act-export").onclick = () => {
  if (!notesAll.length) return toast("还没有可导出的内容");
  const title = String(notesBook.title).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  downloadText(`${title} - 笔记.txt`, allNotesToText());
  toast("已导出");
};

/* ============================ 8. 目录 / 设置 ============================ */

/** 打开目录。 */
$("btn-toc").onclick = () => {
  const ul = $("toc-list");
  ul.innerHTML = "";
  state.chapters.forEach((ch) => {
    const li = document.createElement("li");
    li.textContent = ch.title;
    if (ch.index === state.chapterIndex) li.classList.add("current");
    li.onclick = () => {
      $("toc-modal").hidden = true;
      resetToChapter(ch.index);
    };
    ul.appendChild(li);
  });
  $("toc-modal").hidden = false;
};

/** 打开设置面板（阅读器顶栏的「设置」和书架页的「设置」共用）。 */
function openSettings() {
  $("font-value").textContent = currentFontSize;
  $("settings-modal").hidden = false;
  loadLlmSettings(); // 把当前的大模型配置读回来填进表单
}
$("btn-settings").onclick = openSettings;

// 关闭弹窗（点“关闭”或点遮罩）
document.querySelectorAll(".modal-close").forEach((btn) => {
  btn.onclick = () => (btn.closest(".modal").hidden = true);
});
document.querySelectorAll(".modal").forEach((modal) => {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
});

// ---- 字号 ----
let currentFontSize = parseInt(document.body.dataset.fontSize || "19", 10);
const savedFont = localStorage.getItem("reader:fontSize");
if (savedFont) currentFontSize = parseInt(savedFont, 10);

function applyFontSize(size) {
  currentFontSize = Math.max(14, Math.min(30, size));
  document.documentElement.style.setProperty("--reader-font-size", `${currentFontSize}px`);
  $("font-value").textContent = currentFontSize;
  localStorage.setItem("reader:fontSize", String(currentFontSize));
}
$("font-plus").onclick = () => applyFontSize(currentFontSize + 1);
$("font-minus").onclick = () => applyFontSize(currentFontSize - 1);

// ---- 主题 ----
// 主题的真正来源是 config.ini（首屏由后端直接渲染，重启后不丢、也不会先闪白）。
// localStorage 只作为快速缓存；桌面窗口的标题栏由 pywebview 的 Python 侧同步改色。
const THEME_KEY = "reader:theme";
const serverTheme = document.body.dataset.theme === "dark" ? "dark" : "light";
let currentTheme = serverTheme;

/** 把主题同步给桌面窗口（标题栏颜色），浏览器里打开时静默跳过。 */
function syncWindowTheme(theme) {
  const api = window.pywebview && window.pywebview.api;
  if (!api || typeof api.set_theme !== "function") return;
  try {
    api.set_theme(theme);
  } catch (err) {
    /* 标题栏改色失败不影响阅读 */
  }
}

/**
 * 切换主题。
 * opts.persist=true 时同时写回 config.ini（用户点击时）；
 * opts.syncWindow=false 可跳过窗口标题栏同步（一般不需要）。
 */
function applyTheme(theme, opts = {}) {
  const next = theme === "dark" ? "dark" : "light";
  currentTheme = next;
  document.body.dataset.theme = next;

  document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
    const on = btn.dataset.themeChoice === next;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });

  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (err) {
    /* 隐私模式下 localStorage 可能不可写，主题仍会在本次运行中生效 */
  }

  if (opts.persist) {
    apiPost("/api/theme", { theme: next }).catch((err) => {
      console.warn("主题保存失败：", err);
    });
  }
  if (opts.syncWindow !== false) syncWindowTheme(next);
}

$("theme-light").onclick = () => applyTheme("light", { persist: true });
$("theme-dark").onclick = () => applyTheme("dark", { persist: true });

// pywebview 的 JS 桥接就绪后再同步一次（页面刚打开时可能还没注入）
window.addEventListener("pywebviewready", () => syncWindowTheme(currentTheme));

/* ---- 翻译模型设置：选厂商 + 填 API Key / Base URL / 模型名 ---- */

// 常见厂商的默认接口地址与模型名（选了厂商会自动填这两项，仍可手动改）
const LLM_PRESETS = {
  deepseek: { base_url: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  moonshot: { base_url: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  qwen: { base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  zhipu: { base_url: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
};

/** 打开设置面板时，把后端当前的配置读回来填进表单。 */
async function loadLlmSettings() {
  try {
    const s = await apiGet("/api/settings");
    $("llm-api-key").value = s.api_key || "";
    $("llm-base-url").value = s.base_url || "";
    $("llm-model").value = s.model || "";
    // 根据 base_url 反推是哪个厂商（匹配不到就选“自定义”）
    let provider = "custom";
    Object.keys(LLM_PRESETS).forEach((k) => {
      if (LLM_PRESETS[k].base_url === s.base_url) provider = k;
    });
    $("llm-provider").value = provider;
  } catch (err) {
    /* 读不到就留空，不打断设置面板 */
  }
}

// 切换厂商 → 自动填好默认的 Base URL 与模型名
$("llm-provider").onchange = () => {
  const preset = LLM_PRESETS[$("llm-provider").value];
  if (preset) {
    $("llm-base-url").value = preset.base_url;
    $("llm-model").value = preset.model;
  }
};

/** 收集表单里的模型配置。 */
function collectLlmSettings() {
  return {
    provider: $("llm-provider").value,
    api_key: $("llm-api-key").value.trim(),
    base_url: $("llm-base-url").value.trim(),
    model: $("llm-model").value.trim(),
  };
}

// 「保存」→ 写进 config.ini 并立即生效（后端会顺手换掉在用的翻译器）
$("llm-save").onclick = async () => {
  const body = collectLlmSettings();
  if (!body.api_key) return toast("请先填写 API Key");
  if (!body.base_url) return toast("请先填写 Base URL");
  if (!body.model) return toast("请先填写模型名");

  const btn = $("llm-save");
  btn.disabled = true;
  try {
    await apiPost("/api/settings", body);
    toast("已保存，立即生效");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
};

// 「测试连接」→ 用表单里的配置发一次最小请求
$("llm-test").onclick = async () => {
  const body = collectLlmSettings();
  if (!(body.api_key && body.base_url && body.model)) {
    return toast("请先填完整 API Key / Base URL / 模型名");
  }
  const btn = $("llm-test");
  btn.disabled = true;
  btn.textContent = "测试中…";
  try {
    const r = await apiPost("/api/settings/test", body);
    toast(r.message || "连接成功");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
};

/* ============================ 9. 全文朗读（英语书） ============================ */
/*
   只给英文书用（中文书连「朗读」按钮都不显示，见 applyLangModeForBook）。

   朗读声音从哪来：
     桌面版窗口（WebView2）里只能拿到中文声音（惠惠 / 康康 / 瑶瑶），
     浏览器自带的朗读念英文会变成“中文腔”，所以改成——
     前端把句子发给后台 /api/tts，后台用 Windows 自带的英文声音（如 Microsoft Zira）
     合成 WAV 音频，前端用 <audio> 播放：
       - 不联网、不花钱，声音是地道英文；
       - 可以暂停 / 继续 / 调语速；
       - 读完一句马上接下一句（下一句提前在后台合成好，中间几乎没停顿）。

   整体行为：
     - 从当前屏幕上看得到的第一段英文开始读，读完一章自动加载并接着读下一章；
     - 正在读的那一段加淡绿底色，并自动滚到屏幕中间，方便边听边看；
     - 右下角浮出控制条：暂停 / 继续、停止、语速。

   几个容易踩的点（改的时候别踩回去）：
     1. 后台合成是异步的，每次开始 / 停止 / 改语速都让 token 加一：
        旧的请求和旧的播放回调看到 token 对不上就直接忽略，否则会“停止后又念起来”
        或者一句读两遍。
     2. 浏览器不让“没有用户点击”的页面自动放声音，所以点「朗读」时先播一下静音，
        把当前 <audio> 解锁，后面异步拿到音频才放得出来。
     3. 正文滚动到底时阅读器自己也会补载下一章；这里补载要用 loadingAdjacent 让一让，
        两边同时补会把同一章插进正文两遍。
     4. 每句音频是用 Blob 地址播的，播完必须 revoke，不然听一整本会一直占内存。
*/

const ttsBar = $("tts-bar");
const ttsPauseBtn = $("tts-pause");
const ttsStopBtn = $("tts-stop");
const ttsRateBtn = $("tts-rate");
const ttsBtn = $("btn-tts");

// 静音小片段：点「朗读」的同一瞬间播一下，用来解锁浏览器的音频播放权限
const TTS_SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

const TTS_RATES = [0.8, 1, 1.2, 1.5]; // 点「语速」按这个顺序循环
const tts = {
  active: false,   // 是否处于朗读状态（包括“暂停”）
  paused: false,   // 是否按了暂停
  mode: "book",    // "book" = 从当前位置读全文；"selection" = 只读选中的那一段
  rate: 1,         // 朗读速度：1 = 正常
  chapter: -1,     // 正在读第几章
  chunks: [],      // 当前章的句子列表：[{seg, text, start, end}]
  pos: 0,          // 下一句的下标
  token: 0,        // 每次开始 / 停止 / 改速都 +1；旧请求和旧回调看到对不上就不理它
  audio: new Audio(), // 复用一个播放器，每句换一个音频地址
  currentUrl: null,   // 当前这句的临时音频地址（播完要释放）
  prefetch: null,     // 提前合成好的下一句：{text, rate, url}
  pendingUrl: null,   // 暂停时刚好合成好的这一句，点「继续」马上播
  loading: false,     // 是否正在等后台合成
  loadingToken: 0,    // 正在等的那次合成属于哪一轮（防止旧请求把新请求的状态清掉）
};

tts.audio.preload = "auto";

// 记住上次选的语速
const savedTtsRate = parseFloat(localStorage.getItem("reader:ttsRate") || "");
if (TTS_RATES.includes(savedTtsRate)) tts.rate = savedTtsRate;

/** 从正文里取“能读的英文文字”：跳过空段和章末注释（注释本来就被 CSS 藏着）。 */
function ttsTextOf(span) {
  if (span.closest("p.note, aside")) return "";
  const raw = span.dataset.orig !== undefined ? span.dataset.orig : span.textContent;
  const text = (raw || "").replace(/\s+/g, " ").trim();
  return /[A-Za-z]/.test(text) ? text : ""; // 纯数字 / 符号（如角标 [1]）不读
}

/**
 * 把一段原文切成句子，并带上每句在原文字符串里的起止位置。
 * 返回 [{text, start, end}]：text 是给朗读用的纯文本，start/end 用来只高亮这一句。
 *
 * 注意：缩写里的句号会临时换成占位符（长度不变，所以偏移不变），
 * 这样 U.S. / Mr. / e.g. 不会被误当成句子结尾。
 */
function splitTtsSentences(text) {
  const out = [];
  if (!text) return out;
  const abbr =
    /\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|u\.s|u\.k|no|fig|inc|ltd|co|corp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\./gi;
  const safe = text.replace(abbr, (m) => m.replace(/\./g, "\u0001"));
  const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;
  let m;
  while ((m = re.exec(safe)) !== null) {
    if (!m[0]) {
      re.lastIndex++; // 防止空匹配卡死
      continue;
    }
    const start = m.index;
    const end = m.index + m[0].length;
    const raw = safe.slice(start, end);
    const sentence = raw.replace(/\u0001/g, ".").replace(/\s+/g, " ").trim();
    if (!sentence) continue;
    // 首尾空白不算进高亮范围
    let s = start;
    let e = end;
    while (s < e && /\s/.test(safe[s])) s++;
    while (e > s && /\s/.test(safe[e - 1])) e--;
    if (e > s) out.push({ text: sentence, start: s, end: e });
  }
  return out;
}

/** 把某一章里所有能读的段落切成句子列表（保持正文顺序，带字符位置）。 */
function buildTtsChunks(ci) {
  const sec = chapterSection(ci);
  if (!sec) return [];
  const chunks = [];
  sec.querySelectorAll("span.seg").forEach((span) => {
    if (!ttsTextOf(span)) return;
    const raw = span.dataset.orig !== undefined ? span.dataset.orig : span.textContent;
    splitTtsSentences(raw).forEach((p) => {
      if (!/[A-Za-z]/.test(p.text)) return; // 纯数字 / 符号角标不读
      chunks.push({ seg: span, text: p.text, start: p.start, end: p.end });
    });
  });
  return chunks;
}

/** 找到“当前屏幕上第一段能读的文字”，从它开始念。 */
function firstVisibleTtsSeg() {
  const box = readerContent.getBoundingClientRect();
  const line = box.top + 90; // 顶栏下方一点
  const secs = readerContent.querySelectorAll("section.chapter");
  for (const sec of secs) {
    if (sec.getBoundingClientRect().bottom <= line) continue; // 整章已经滚上去，跳过
    for (const span of sec.querySelectorAll("span.seg")) {
      if (!ttsTextOf(span)) continue;
      if (span.getBoundingClientRect().bottom > line) return span;
    }
  }
  // 兜底：屏幕上全是图片 / 空白时，从已加载正文的最后一段开始（通常就在屏幕底部附近），
  // 这样至少能接着往下读，不会突然跳回全书第一段。
  let last = null;
  for (const sec of secs) {
    for (const span of sec.querySelectorAll("span.seg")) {
      if (ttsTextOf(span)) last = span;
    }
  }
  return last;
}

/* ---- 控制条 / 按钮状态 ---- */

function updateTtsRateBtn() {
  ttsRateBtn.textContent = `${tts.rate.toFixed(1)}×`;
}

function syncTtsUI() {
  if (tts.active) {
    const label = tts.paused ? "继续" : "暂停";
    ttsBtn.textContent = label;
    ttsPauseBtn.textContent = label;
  } else {
    ttsBtn.textContent = "朗读";
    ttsPauseBtn.textContent = "暂停";
  }
}

/* ---- 音频播放的小工具 ---- */

/** 播完 / 停止后把临时音频地址释放掉（不释放会一直占内存）。 */
function releaseTtsUrl() {
  if (tts.currentUrl) {
    URL.revokeObjectURL(tts.currentUrl);
    tts.currentUrl = null;
  }
}

/** 丢掉提前合成好的下一句。 */
function clearTtsPrefetch() {
  if (tts.prefetch) {
    URL.revokeObjectURL(tts.prefetch.url);
    tts.prefetch = null;
  }
}

/** 丢掉暂停时准备好的那一句。 */
function clearTtsPendingUrl() {
  if (tts.pendingUrl) {
    URL.revokeObjectURL(tts.pendingUrl);
    tts.pendingUrl = null;
  }
}

/** 点「朗读」的那一下先播静音：把播放器解锁，后面异步拿到的音频才放得出来。 */
function unlockTtsAudio() {
  try {
    tts.audio.pause();
    tts.audio.src = TTS_SILENT_WAV;
    const p = tts.audio.play();
    if (p && p.then) {
      p.then(() => {
        // 如果真正的朗读音频已经开始放了，就不要去暂停它
        if (tts.audio.src === TTS_SILENT_WAV || tts.audio.src.startsWith("data:")) {
          tts.audio.pause();
          tts.audio.currentTime = 0;
        }
      }).catch(() => {});
    }
  } catch (err) {
    // 解锁失败不影响后面正常播放（有的环境本来就允许自动播放）
  }
}

/** 让后台把一句英文合成成音频，返回临时音频地址。 */
async function requestTtsAudio(text, rate) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, rate }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `朗读失败(${res.status})`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** 播放一句的音频；播完自动接下一句。 */
function playTtsAudio(url, token) {
  tts.currentUrl = url;
  tts.audio.onended = () => {
    if (token !== tts.token) return;
    releaseTtsUrl();
    if (!tts.active || tts.paused) return;
    speakNextTts();
  };
  tts.audio.onerror = () => {
    if (token !== tts.token || !tts.active) return;
    releaseTtsUrl();
    speakNextTts(); // 这一句音频有问题就跳过，别把整本卡住
  };
  tts.audio.src = url;
  const p = tts.audio.play();
  if (p && p.catch) {
    p.catch(() => {
      if (token !== tts.token || !tts.active) return;
      stopTts();
      toast("浏览器不让播放声音，请再点一次「朗读」试试");
    });
  }
}

/* ---- 开始 / 暂停 / 继续 / 停止 ---- */

function startTts() {
  if (!state.book || state.isZh) return;
  const startSeg = firstVisibleTtsSeg();
  if (!startSeg) return toast("正文还没加载好，稍等一下再点「朗读」");

  clearJumpHighlight(); // 去掉之前“点词跳回原文”的淡蓝标记，免得和绿色朗读高亮叠在一起
  clearTtsSelectionHighlight(); // 全文朗读没有选中区域，只留当前句
  tts.active = true;
  tts.paused = false;
  tts.mode = "book";
  tts.token += 1;
  tts.chapter = chapterIndexOf(startSeg);
  tts.chunks = [];
  tts.pos = 0;
  clearTtsPrefetch();
  clearTtsPendingUrl();
  releaseTtsUrl();
  unlockTtsAudio(); // 必须在用户点按钮的这一刻解锁播放权限

  ttsBar.hidden = false;
  updateTtsRateBtn();
  syncTtsUI();
  startTtsChapter(tts.chapter, startSeg);
}

/**
 * 把「用户选中的文字」按段切成句子（带字符位置）。
 * 跨段选中也能逐句读、逐句标；算法和划线功能一致（按选区两端收紧）。
 */
function selectionTtsChunks(sel) {
  if (!sel || !sel.rangeCount) return { chunks: [], ranges: [] };
  const range = sel.getRangeAt(0);
  const spans = Array.from(readerContent.querySelectorAll("span.seg"))
    .filter((span) => range.intersectsNode(span));
  const chunks = [];
  const ranges = [];

  spans.forEach((span) => {
    const orig = span.dataset.orig !== undefined ? span.dataset.orig : span.textContent;
    if (!orig) return;
    let start = 0;
    let end = orig.length;
    if (span.contains(range.startContainer)) {
      start = textOffsetIn(span, range.startContainer, range.startOffset);
    }
    if (span.contains(range.endContainer)) {
      end = textOffsetIn(span, range.endContainer, range.endOffset);
    }
    if (end <= start) return;
    // 整段选中区域也标绿（不是只标当前一句）
    const picked = rangeFromOffsets(span, start, end);
    if (picked) ranges.push(picked);
    const raw = orig.slice(start, end);
    splitTtsSentences(raw).forEach((p) => {
      if (!/[A-Za-z]/.test(p.text)) return;
      chunks.push({ seg: span, text: p.text, start: start + p.start, end: start + p.end });
    });
  });
  return { chunks, ranges };
}

/**
 * 只朗读用户刚选中的这段文字（选字操作栏的「朗读」）。
 * 读完就停；整个选中区域标淡绿，正在读的那一句颜色更深，读完 / 停止恢复原色。
 */
function startTtsSelection(sel) {
  if (!state.book || state.isZh) return;
  const { chunks, ranges } = selectionTtsChunks(sel);
  if (!chunks.length) return toast("选中的内容里没有可朗读的英文");

  // 先把选中的蓝色选区收掉，改成“整个选中区域 + 当前句”的绿色
  if (sel) sel.removeAllRanges();
  clearJumpHighlight(); // 去掉之前点词跳转留下的淡蓝标记
  stopTts(); // 正在全文朗读的话先停掉，避免两路声音打架

  tts.active = true;
  tts.paused = false;
  tts.mode = "selection";
  tts.token += 1;
  tts.chapter = chapterIndexOf(chunks[0].seg);
  tts.chunks = chunks;
  tts.pos = 0;
  markTtsSelection(ranges); // 你选中的整段先标绿，当前句再加深
  clearTtsPrefetch();
  clearTtsPendingUrl();
  releaseTtsUrl();
  unlockTtsAudio(); // 必须在用户点按钮的这一刻解锁播放权限

  ttsBar.hidden = false;
  updateTtsRateBtn();
  syncTtsUI();
  speakNextTts();
}

function pauseTts() {
  if (!tts.active || tts.paused) return;
  tts.paused = true;
  if (!tts.audio.paused) tts.audio.pause(); // 停在这一句中间，点「继续」从原处接着念
  syncTtsUI();
}

function resumeTts() {
  if (!tts.active || !tts.paused) return;
  tts.paused = false;
  if (tts.pendingUrl) {
    // 暂停时刚好把这一句合成好了：直接播
    const url = tts.pendingUrl;
    tts.pendingUrl = null;
    playTtsAudio(url, tts.token);
  } else if (tts.loading && tts.loadingToken === tts.token) {
    // 正在后台合成这一句，合成完会自动接着播
  } else if (tts.currentUrl) {
    tts.audio.play(); // 这一句播到一半时暂停的：从原处继续
  } else {
    speakNextTts(); // 刚好在两句之间按的暂停：直接开始下一句
  }
  syncTtsUI();
}

/** 彻底停止（退出阅读器 / 跳章 / 点「停止」都用它）。 */
function stopTts() {
  if (!tts.active) return;
  tts.active = false;
  tts.paused = false;
  tts.token += 1; // 让还在路上的请求 / 播放回调全部失效
  tts.loading = false;
  tts.audio.onended = null;
  tts.audio.onerror = null;
  tts.audio.pause();
  try {
    tts.audio.removeAttribute("src");
    tts.audio.load(); // 真正停掉还在下载的音频
  } catch (err) {
    // 忽略：不同浏览器对空 src 的处理略有差别
  }
  releaseTtsUrl();
  clearTtsPrefetch();
  clearTtsPendingUrl();
  clearTtsSelectionHighlight();
  clearTtsSentenceHighlight(); // 停止后整段选中区域和当前句都恢复原色
  tts.chunks = [];
  tts.pos = 0;
  ttsBar.hidden = true;
  syncTtsUI();
}

/* ---- 真正的朗读循环 ---- */

/** 开始读某一章；fromSeg 表示从这一段的第几句开始。 */
function startTtsChapter(ci, fromSeg) {
  tts.chapter = ci;
  tts.chunks = buildTtsChunks(ci);
  tts.pos = 0;
  if (fromSeg) {
    const i = tts.chunks.findIndex((c) => c.seg === fromSeg);
    if (i > 0) tts.pos = i;
  }
  if (!tts.chunks.length) {
    advanceTtsChapter(); // 空章直接跳到下一章
    return;
  }
  speakNextTts();
}

/** 读下一句：先拿音频（下一句通常已经提前合成好），拿到就播。 */
async function speakNextTts() {
  if (!tts.active || tts.paused) return;
  if (tts.pos >= tts.chunks.length) {
    if (tts.mode === "selection") {
      // 只读选中的这一段：读完就收工，不接着往下读
      stopTts();
      toast("朗读完毕");
    } else if (state.singleChapter) {
      // 单章阅读：只念当前这一章，念完等用户点「下一章」，不偷偷加载下一章
      stopTts();
      toast("本章读完了，点章末「下一章」继续");
    } else {
      advanceTtsChapter();
    }
    return;
  }
  const token = tts.token;
  if (tts.loading && tts.loadingToken === token) return; // 这一轮已经在合成中，别重复发请求

  tts.loading = true;
  tts.loadingToken = token;

  const item = tts.chunks[tts.pos++];
  highlightTtsSentence(item); // 只标“正在读的这一句”，不整段变绿

  let url = null;
  // 下一句刚好提前合成好了 → 直接用，衔接几乎没停顿
  if (tts.prefetch && tts.prefetch.text === item.text && tts.prefetch.rate === tts.rate) {
    url = tts.prefetch.url;
    tts.prefetch = null;
  }
  try {
    if (!url) url = await requestTtsAudio(item.text, tts.rate);
  } catch (err) {
    if (token !== tts.token) return;
    stopTts();
    toast(err.message);
    return;
  } finally {
    if (tts.loadingToken === token) {
      tts.loading = false;
      tts.loadingToken = 0;
    }
  }

  if (token !== tts.token || !tts.active) {
    URL.revokeObjectURL(url); // 等音频的时候用户已经停止 / 重新开始了
    return;
  }
  if (tts.paused) {
    // 音频准备好了但用户正好按了暂停：先存着，点「继续」马上播
    clearTtsPendingUrl();
    tts.pendingUrl = url;
    return;
  }
  playTtsAudio(url, token);
  prefetchNextTts(token);
}

/** 提前把下一句合成好，读完这一句就能马上接上（失败就算了，播到时会再要）。 */
function prefetchNextTts(token) {
  if (!tts.active || tts.paused) return;
  const next = tts.chunks[tts.pos];
  if (!next) return;
  if (tts.prefetch && tts.prefetch.text === next.text && tts.prefetch.rate === tts.rate) return;

  const rate = tts.rate;
  requestTtsAudio(next.text, rate)
    .then((url) => {
      // 这期间用户停止 / 改语速 / 已经读到别的句子了：预取的这条不要了
      if (token !== tts.token || !tts.active || tts.rate !== rate || tts.chunks[tts.pos] !== next) {
        URL.revokeObjectURL(url);
        return;
      }
      clearTtsPrefetch();
      tts.prefetch = { text: next.text, rate, url };
    })
    .catch(() => {});
}

/**
 * 当前章读完了：加载并接着读下一章；全书读完就停。
 * 正文滚到底时阅读器自己也会补载下一章，这里用 loadingAdjacent 让一让，
 * 避免两边同时补载、把同一章插进正文两遍。
 */
async function advanceTtsChapter() {
  if (!tts.active) return;
  if (state.singleChapter) {
    // 单章阅读不该自动补下一章（空章也交给用户点「下一章」）
    stopTts();
    toast("本章没有可继续朗读的内容，点章末「下一章」翻页");
    return;
  }
  const token = tts.token;
  // 最多连跳 5 章（跳过只有图片 / 广告的空章），防止无限循环
  for (let tries = 0; tries < 5; tries++) {
    const next = tts.chapter + 1;
    if (next >= state.chapters.length) {
      stopTts();
      toast("这本书已经读完了");
      return;
    }
    const loaded = await ensureTtsChapterLoaded(next, token);
    if (!tts.active || token !== tts.token) return;
    if (!loaded) {
      stopTts();
      toast("下一章加载失败，朗读已停止");
      return;
    }
    const chunks = buildTtsChunks(next);
    if (chunks.length) {
      tts.chapter = next;
      tts.chunks = chunks;
      tts.pos = 0;
      speakNextTts();
      return;
    }
    tts.chapter = next; // 这一章没文字，继续看下一章
  }
  stopTts();
}

/** 保证某一章已经在正文里（没有就补载进来），最多等几秒。 */
async function ensureTtsChapterLoaded(index, token) {
  for (let i = 0; i < 40; i++) {
    if (chapterSection(index)) return true;
    if (!tts.active || token !== tts.token) return false;
    if (!loadingAdjacent) {
      loadingAdjacent = true;
      try {
        await appendChapter(index);
      } catch (err) {
        // 偶尔请求慢 / 失败：歇一下再试
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        loadingAdjacent = false;
      }
      if (chapterSection(index)) return true;
    } else {
      // 阅读器正在自己补载邻章，等它补完再看
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  return !!chapterSection(index);
}

/** 清掉「整段选中区域」的淡绿底。 */
function clearTtsSelectionHighlight() {
  if (window.CSS && CSS.highlights) {
    try {
      CSS.highlights.delete("tts-selection");
    } catch (err) {
      // 旧浏览器不支持就算了
    }
  }
}

/** 把用户选中的整段区域标成淡绿（当前正在读的那一句会在上面再叠一层深绿）。 */
function markTtsSelection(ranges) {
  clearTtsSelectionHighlight();
  if (!window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
  if (!ranges || !ranges.length) return;
  try {
    CSS.highlights.set("tts-selection", new Highlight(...ranges));
  } catch (err) {
    // 不支持就算了
  }
}

/** 清掉「正在读的这一句」的绿色（CSS Custom Highlight）。 */
function clearTtsSentenceHighlight() {
  if (window.CSS && CSS.highlights) {
    try {
      CSS.highlights.delete("tts-current");
    } catch (err) {
      // 旧浏览器不支持就算了
    }
  }
}

/** 滚动到某一段（拿不到句子范围时的兜底）。 */
function scrollTtsSeg(seg) {
  const box = readerContent.getBoundingClientRect();
  const r = seg.getBoundingClientRect();
  if (r.top < box.top + 90 || r.bottom > box.bottom - 90) {
    const target =
      readerContent.scrollTop + (r.top - box.top) -
      readerContent.clientHeight / 2 + r.height / 2;
    readerContent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

/** 滚动到当前句子（只在这句跑出视口时才滚）。 */
function scrollTtsRange(range) {
  const box = readerContent.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  if (r.top < box.top + 90 || r.bottom > box.bottom - 90) {
    const target =
      readerContent.scrollTop + (r.top - box.top) -
      readerContent.clientHeight / 2 + r.height / 2;
    readerContent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

/**
 * 只给「正在读的这一句」加淡绿底；上一句的颜色立刻清掉，读完 / 停止后恢复原色。
 * 用 CSS Custom Highlight API 标精确的字符区间，不碰 DOM，也不会整段变绿。
 * 中文模式下显示的是译文、偏移对不上：只滚动，不标色。
 */
function highlightTtsSentence(item) {
  clearTtsSentenceHighlight();
  const seg = item.seg;
  if (!seg) return;
  const orig = seg.dataset.orig !== undefined ? seg.dataset.orig : seg.textContent;
  if ((seg.textContent || "") !== orig) {
    scrollTtsSeg(seg);
    return;
  }
  if (item.start === undefined || item.start === null ||
      item.end === undefined || item.end === null) {
    scrollTtsSeg(seg);
    return;
  }
  const range = rangeFromOffsets(seg, item.start, item.end);
  if (!range) {
    scrollTtsSeg(seg);
    return;
  }
  if (window.CSS && CSS.highlights && typeof Highlight === "function") {
    try {
      CSS.highlights.set("tts-current", new Highlight(range));
    } catch (err) {
      // 不支持就算了，至少还会滚动到当前句
    }
  }
  scrollTtsRange(range);
}

/** 点「语速」：0.8 → 1.0 → 1.2 → 1.5 循环；正在读的话从这一句开头用新速度重念。 */
function cycleTtsRate() {
  const i = TTS_RATES.indexOf(tts.rate);
  tts.rate = TTS_RATES[(i + 1) % TTS_RATES.length];
  localStorage.setItem("reader:ttsRate", String(tts.rate));
  updateTtsRateBtn();
  if (!tts.active || tts.paused) return; // 暂停时等继续后自然生效
  // 合成好的音频改不了速度：停掉这一句，回到它的开头，用新速度重新合成
  tts.token += 1;
  tts.audio.onended = null;
  tts.audio.onerror = null;
  tts.audio.pause();
  releaseTtsUrl();
  clearTtsPrefetch();
  clearTtsPendingUrl();
  if (tts.pos > 0) tts.pos -= 1;
  speakNextTts();
}

// 顶部「朗读」按钮：没开始 → 开始；正在读 → 暂停；暂停中 → 继续
ttsBtn.onclick = () => {
  if (tts.active) {
    if (tts.paused) resumeTts();
    else pauseTts();
  } else {
    startTts();
  }
};
ttsPauseBtn.onclick = () => {
  if (tts.paused) resumeTts();
  else pauseTts();
};
ttsStopBtn.onclick = stopTts;
ttsRateBtn.onclick = cycleTtsRate;

updateTtsRateBtn(); // 把记住的语速显示到按钮上

/* ============================ 10. 从词典 / 划线跳回原文 ============================ */
/*
   需求：在「词典」面板点一个词、或在「笔记·划线」面板点一条划线，
   直接跳回当初那句话在原文里的位置，并自动选中那一句，方便对照原句记忆。

   位置从哪来：
     - 划线：annotations 本来就存了 chapter_index / seg_index / char_start / char_end；
     - 查词：查词时把 chapter_index / seg_index 一起存进 dict_history；
       老记录没存位置 → 调 /api/books/<hash>/locate 按词在全书里现搜一次（后端有缓存）。
*/

let jumpingToOriginal = false;
let jumpOrigin = null; // 这次跳转是从哪来的：{type:"dict"|"notes", book}

/** 显示左下角的「返回词典 / 返回划线」按钮。 */
function showBackPanel(origin) {
  if (!origin) return;
  jumpOrigin = origin;
  backPanelBtn.textContent = origin.type === "notes" ? "‹ 返回划线" : "‹ 返回词典";
  backPanelBtn.hidden = false;
}

/** 收起左下角的返回按钮（回书架 / 换书 / 点过它之后）。 */
function hideBackPanel() {
  backPanelBtn.hidden = true;
  jumpOrigin = null;
}

/** 清掉“跳转目标”的淡蓝底（CSS Custom Highlight）。 */
function clearJumpHighlight() {
  if (window.CSS && CSS.highlights) {
    try {
      CSS.highlights.delete("jump-target");
    } catch (err) {
      // 旧浏览器不支持就算了
    }
  }
}

/** 只给目标词 / 目标划线加淡蓝底（不改 DOM，不会选中一大块）。返回是否成功。 */
function markJumpRange(range) {
  clearJumpHighlight();
  if (window.CSS && CSS.highlights && typeof Highlight === "function") {
    try {
      CSS.highlights.set("jump-target", new Highlight(range));
      return true;
    } catch (err) {
      return false;
    }
  }
  return false;
}

/** 点「返回词典 / 返回划线」：回到刚才的列表，接着点下一个词。 */
backPanelBtn.onclick = async () => {
  const origin = jumpOrigin;
  if (!origin) return;
  hideBackPanel();
  clearJumpHighlight();
  const sel = window.getSelection();
  if (sel) sel.removeAllRanges();
  if (origin.type === "notes") {
    await openNotesDetail(origin.book); // 阅读器里打开 → 并排浮窗
  } else {
    await openDictPanel(origin.book);
  }
};

/**
 * 跳到原文后，把「从哪个列表跳来的」那个面板留在正文旁边：
 *   - 书架打开的是普通弹窗 → 转成阅读器里的并排浮窗（不铺遮罩、正文照常滚动）；
 *   - 另一个列表（词典 / 划线）收起来，免得挡两层面板。
 * 这样用户可以一边看原文里的词，一边对照词典释义，再点下一个词。
 */
function focusStudyPanel(origin) {
  if (!origin) return;
  const dictModal = $("dict-modal");
  const notesModal = $("notes-modal");
  const keep = origin.type === "notes" ? notesModal : dictModal;
  const other = origin.type === "notes" ? dictModal : notesModal;
  other.hidden = true;
  keep.hidden = false;
  setPanelFloat(keep, true); // 阅读器里打开 → 并排浮窗
}

/** 词典里点单词：先确定位置（新记录直接有，老记录按词搜索），再跳过去。 */
async function jumpToDictWord(item) {
  if (!dictBook) return;
  if (!dictBook.book_hash) {
    return toast("这条是早期查的词，没有记录书名，找不到原文位置");
  }
  const word = (item.word || "").trim();
  if (!word) return;

  let loc = null;
  if (item.chapter_index !== null && item.chapter_index !== undefined &&
      item.seg_index !== null && item.seg_index !== undefined) {
    loc = { chapter_index: item.chapter_index, seg_index: item.seg_index };
  } else {
    // 老记录：按词在原文里搜一次（后端会缓存结果）
    toast("正在原文里定位这个词…");
    try {
      loc = await apiPost(`/api/books/${dictBook.book_hash}/locate`, { word });
    } catch (err) {
      toast(err.message);
      return;
    }
  }
  jumpToBookLocation(dictBook, loc.chapter_index, loc.seg_index, word, null, null, {
    type: "dict",
    book: dictBook,
  });
}

/** 划线面板里点一条划线：按存好的章节 / 段落 / 字符位置跳过去。 */
function jumpToNote(a) {
  if (!notesBook) return;
  jumpToBookLocation(
    notesBook,
    a.chapter_index,
    a.seg_index,
    (a.text || "").replace(/\s+/g, " ").trim(), // 老数据没字符区间时按文字找
    a.char_start,
    a.char_end,
    { type: "notes", book: notesBook }
  );
}

/**
 * 跳到某本书的某一章、某一段，只把「那个词 / 那段划线」标出来并滚到屏幕中间。
 * 这本书没开着就自动打开；开的是别的书就先切过去。
 * origin = 从哪个列表跳来的（用于左下角「返回词典 / 返回划线」）。
 */
async function jumpToBookLocation(
  book, chapterIndex, segIndex, word, charStart, charEnd, origin
) {
  if (jumpingToOriginal || !book) return;
  if (!(chapterIndex >= 0)) {
    return toast("这条记录没有原文位置");
  }
  jumpingToOriginal = true;
  try {
    hideBackPanel();
    clearJumpHighlight();
    focusStudyPanel(origin); // 词典 / 划线列表留在正文旁边，方便对照
    hideBubble();
    hideSelToolbar();
    hideNoteBubble();

    if (!state.book || state.book.book_hash !== book.book_hash) {
      await openBook(book);
    }
    // 查的是英文，跳过去看原文最直观（中文书 / 已经是原文 / 对照都不动）
    if (!state.isZh && state.langMode === "zh") setLangMode("en");

    await resetToChapter(chapterIndex);
    const sec = chapterSection(chapterIndex);
    if (!sec) return toast("没有找到这一章");
    showBackPanel(origin); // 左下角给一个「返回列表」，方便点下一个词

    let seg = null;
    if (segIndex !== null && segIndex !== undefined) {
      seg = sec.querySelector(`span.seg[data-i="${CSS.escape(String(segIndex))}"]`);
    }
    if (!seg && word) seg = findSegWithWord(sec, word);
    if (!seg) return toast("没有在原文里找到这句话");

    revealOriginalTarget(seg, word, charStart, charEnd);
  } catch (err) {
    toast(err.message);
  } finally {
    jumpingToOriginal = false;
  }
}

/** 在某一章里按词找第一段包含它的文字（位置兜底）。 */
function findSegWithWord(sec, word) {
  const needle = word.toLowerCase();
  for (const span of sec.querySelectorAll("span.seg")) {
    const text =
      (span.dataset.orig !== undefined ? span.dataset.orig : span.textContent) || "";
    if (text.toLowerCase().includes(needle)) return span;
  }
  return null;
}

/**
 * 只把「目标词 / 目标划线」标出来（淡蓝底）并滚到屏幕中间。
 * 不再扩展到整句、也不闪整段：用户只是要看看这个词在原文哪一句里。
 */
function revealOriginalTarget(seg, word, charStart, charEnd) {
  const text = seg.dataset.orig !== undefined ? seg.dataset.orig : seg.textContent;
  let start = -1;
  let end = -1;

  const hasChars =
    charStart !== null && charStart !== undefined &&
    charEnd !== null && charEnd !== undefined;
  if (hasChars) {
    // 划线：用存下来的精确字符区间（就是用户当初划过的那几个字）
    start = Math.max(0, Math.min(Number(charStart), text.length));
    end = Math.max(start, Math.min(Number(charEnd), text.length));
  }
  if ((start < 0 || end <= start) && word) {
    // 查词（或老划线没存区间）：在段里找到这段文字的第一次出现
    const hit = text.toLowerCase().indexOf(word.toLowerCase());
    if (hit >= 0) {
      start = hit;
      end = hit + word.length;
    }
  }
  if (start < 0 || end <= start) {
    seg.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  const range = rangeFromOffsets(seg, start, end);
  if (!range) {
    seg.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }

  // 优先只加一层淡蓝底（不产生选区）；老浏览器才退回“只选中这个词”
  const marked = markJumpRange(range);
  if (!marked) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 把这个词滚到屏幕中间
  const r = range.getBoundingClientRect();
  const box = readerContent.getBoundingClientRect();
  const target =
    readerContent.scrollTop + (r.top - box.top) -
    readerContent.clientHeight / 2 + r.height / 2;
  readerContent.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

/** 把「段内第 start~end 个字符」变成 DOM Range（会跳过 <mark> 拆出来的多个文本节点）。 */
function rangeFromOffsets(root, start, end) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode = null;
  let startOff = 0;
  let endNode = null;
  let endOff = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!len) continue;
    if (startNode === null && start <= pos + len) {
      startNode = node;
      startOff = Math.max(0, start - pos);
    }
    if (startNode !== null && end <= pos + len) {
      endNode = node;
      endOff = Math.max(0, end - pos);
      break;
    }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  try {
    range.setStart(startNode, Math.min(startOff, startNode.nodeValue.length));
    range.setEnd(endNode, Math.min(endOff, endNode.nodeValue.length));
  } catch (err) {
    return null;
  }
  return range;
}

/* ============================ 启动 ============================ */
applyFontSize(currentFontSize);

// 主题：优先用 config.ini 注入的主题（首屏已经是对的）；如果旧版本只在
// localStorage 里留过选择，这一次把它迁移到后端，之后每台机器都记得住。
const cachedTheme = localStorage.getItem(THEME_KEY);
const hasCachedTheme = cachedTheme === "light" || cachedTheme === "dark";
const initialTheme = hasCachedTheme ? cachedTheme : serverTheme;
applyTheme(initialTheme, {
  persist: hasCachedTheme && initialTheme !== serverTheme,
});

// 恢复上次的显示语言模式（默认「原文」）。
// 先存进 savedLangMode 再套用：打开中文书时 openBook 会强制「原文」，
// 但不动这里的记忆，下次打开英文书还是恢复用户自己的选择。
savedLangMode = localStorage.getItem("reader:langMode") || "en";
setLangMode(savedLangMode);

// 恢复上次选的阅读方式（单章阅读 / 连续滚动）
readerView.classList.toggle("single-chapter", state.singleChapter);
syncSingleChapterUI();

loadBooks();
loadBooks();