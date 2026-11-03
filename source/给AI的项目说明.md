# 译读 · 英文阅读器 · 给 AI 的项目交接说明

> 本文件给「下一个接手改代码 / 修 bug 的 AI」看。若本文与代码不一致，**以代码为准**；改完代码请同步更新本文。
> 创建：2026-10-12　最后更新：2026-10-21（第 18 轮：新增英文全文朗读；声音走后台 System.Speech 合成，不用浏览器 Web Speech）

---

## 0. 30 秒速览

- **项目源码**：`D:\EPUBReader\source` —— Windows 本地 EPUB 阅读器（Flask + 原生 HTML/CSS/JS + pywebview 桌面壳）。
  - 运行目录（软件 + 数据）：`D:\EPUBReader`；用户实际双击桌面快捷方式 `D:\桌面图标\译读.lnk` → `D:\EPUBReader\EPUBReader.exe`。
  - `state`（reader.db / webview）与 `static\books` 都是 `D:\EPUBReader` 下的**真实目录**，不是快捷链接；移动/删除源码文件夹不影响软件运行。
  - 源码改动后要重新打包 exe，见第 0.1 节；只改前端（app.js/style.css）并重新打包也可以，exe 启动时会把新文件同步到 exe 旁 static。
- **开发启动**：双击 `启动阅读器.bat`（= `python main.py`）；网址 http://127.0.0.1:5000。
- **打包**：`pyinstaller --noconfirm --clean EPUBReader.spec`（约 30MB，启动约 3 秒）。
- **改动怎么生效**（务必主动提醒用户）：
  - 改 `.py`、`config.ini`、`templates/index.html` → **必须重启服务 / 重新打包**（Jinja 模板在 `debug=False` 时会缓存，光刷新浏览器没用）。
  - 只改 `static/app.js` / `static/style.css` → 源码模式刷新即可；exe 模式需要重新打包，启动时按内容比对自动覆盖到 exe 旁 static。
  - ⚠️ 最常见坑：旧服务 / 旧 exe 还在跑时，新进程只会复用旧服务 —— 先完全关掉旧窗口（任务栏 / 任务管理器）再启动。
- **三条铁律**：全程中文回复 / 代码保留详细中文注释 / 改完必须告诉用户怎么生效。
- 最重要的节：**第 2 节（不许破坏的行为）**和**第 7 节（踩过的坑）**。

---

## 1. 用户是谁 · 对 AI 的硬性要求

用户是**零基础、非程序员**，全程通过对话让 AI 改代码。必须遵守：

1. 全程中文；步骤具体到"哪个文件、双击什么、按什么键"；要改就直接改好，不留"用户自行修改"的活。
2. 改完**先自己验证**（跑服务 / 调接口 / 浏览器实测）再汇报；用户反感"没测就说好了"。
3. **未经确认不花 API 大钱**（整本重翻、批量重导）；大改动前先向用户说明；必要时先备份 `state/reader.db`。
4. 不要擅自改变使用习惯（启动方式、界面布局、按钮含义）。
5. **不删真书测删除功能**——删书连翻译进度一起删，重导同一本要重新花钱翻（测试用假 hash）。

---

## 2. 当前功能与界面（全部已实现，**不许破坏**）

### 2.1 书架页

- 顶栏：`我的书架 · 共 N 本` + 右侧 `词典 / 笔记 / 设置 / + 导入 EPUB`（导入中变"导入中…"并禁用）。
- **词典面板 = 查词记录（2026-10-17 改成和笔记页一样的两级页面）**（第 14 轮新增；**刻意不放查询框，用户明确要求**）：总览 → 某本书的明细，不再是一长串按书堆叠的方框。
  - **总览**：每本查过词的书一张卡（大数字 `N 个词` + 书名 + 最近查词时间 + 封面），按最近查词时间倒序；底部 `导出全部` / `清空全部`（只清记录、**不动词典缓存**）。
  - **明细**（点书卡进入）：书籍卡 + 功能行 `搜索单词 / 复制全部 / 导出`；词条按**查询日期**分组（今天 / 昨天 / 2026年10月16日…，组头吸顶），每条显示完整词条（单词 / 音标 / 词性 / 中文释义 / 例句 / 查询时间），鼠标悬停浮现 `复制 / 删除`。
  - **单词可单独删除**：`DELETE /api/dictionary/history/word?word=...`，只删 `dict_history` 这一条，`phrase_cache` 里的词条缓存保留（再看同一个词不花钱）。全部清空仍是 `DELETE /api/dictionary/history`。
  - **点单词跳回原文（2026-10-21 新增）**：点词条里的**单词本身** → 自动打开那本书、定位到当初查词的章节 / 段落，**只把那个词加一层淡蓝底**并滚到屏幕中间（不再选中整句 / 闪整段——用户明确说“只需要标注一个词”）。**词典面板不关闭**，由 `focusStudyPanel()` 转成并排浮窗留在正文旁边（透明遮罩、正文照常滚动），可以直接点列表里的下一个词继续定位；左下角另有「‹ 返回词典」。实现：`jumpToDictWord` / `jumpToBookLocation` / `revealOriginalTarget`，用 CSS Custom Highlight API（`::highlight(jump-target)`）只标 Range，不改 DOM；不支持时才退回“只选中这个词”。location 存 `dict_history.chapter_index / seg_index`；老记录没有位置时调 `POST /api/books/<hash>/locate` 按词现搜一次（后端 `_LOCATE_CACHE` 缓存）。早期没记书名（`book_hash` 为空）的记录无法跳，会提示。
  - 面板入口：**书架顶栏「词典」→ 总览**；**阅读器 `⋯ → 词典` → 直接打开当前这本书的明细**。阅读器里仍是并排浮窗（可拖动，正文不动）。
  - 查词的入口只有一个：**阅读器里选中文字 → 操作栏「词典」**（`showDictionary` 带当前 `book_hash`；查成功 → 已打开的词典面板同步刷新）。
  - 同一个词不分大小写只留一条；**换一本书再查同一个词，记录会跟到新书那组**（表不会越滚越长）。老记录（没记到书名）/ 书已删 → 归到「（未分类：早期查的词，没记下书名）」；2026-10-17 已把用户现有的 23 条老记录手工归到 `TheEconomist.2026.10.17`（只改数据，不改分组逻辑）。
- 统计条只有 2 张 chip：`本书` / `划线`（划线可点，直接打开笔记总览）。**进度类 chip 已删，不要加回**。
- 书卡：封面（缺失或加载失败 → 书名首字色块兜底，不留白）；左上角翻译状态徽章 `未翻译/翻译中/已译完`（无百分比；**中文书不显示徽章**）；右上角悬停浮现垃圾桶（确认后删除）；书名（最多 2 行）+ 作者 + `划线 N`（为 0 整行不显示）。**没有进度条**。
- 删除书：`DELETE /api/books/<hash>`，连翻译进度 / 划线一起清，不可恢复。
- 导入：按钮选文件，或直接**拖 `.epub` 进书架**（拖拽出现虚线提示层）；同名文件（sha1 相同）提示"已经导入过了"。
- 空书架有提示态；主题记忆 `config.ini [ui] default_theme`（启动首屏由后端注入）+ `localStorage: reader:theme`（快速缓存）。改名 / 换图标只改 `APP_TITLE`、`index.html <title>`、`icon.ico`、`static/brand.png`。

### 0.1 打包 / 部署（桌面版）

- 在 `D:\EPUBReader\source` 目录执行：`pyinstaller --noconfirm --clean EPUBReader.spec`，产物在 `source\dist\EPUBReader.exe`。
- 把 exe 复制到 `D:\EPUBReader\EPUBReader.exe` 即可；**config.ini / state / static\books 原样保留**。
  - `D:\EPUBReader\state` 和 `D:\EPUBReader\static\books` 现在是真实目录（2026-10-18 从失效 junction 恢复），**不要再改回指向源码目录的链接**；否则源码一移动，软件就会报 `WinError 183` 起不来。
  - 数据备份在 `D:\EPUBReader\backup`；用户删掉 `D:\桌面图标\新建文件夹` 不会影响软件。
- exe 启动时 `app.py:_ensure_static_in_base()` 会用 `filecmp` 比较内容，把新 `static/app.js`、`style.css`、`brand.png` 覆盖到 exe 旁；**不要再改回“文件不存在才复制”**（否则升级后永远看到旧界面）。
- 桌面快捷方式：`D:\桌面图标\译读.lnk`，目标 `D:\EPUBReader\EPUBReader.exe`，图标用 exe 第 0 号图标。

### 2.2 阅读器页

- **顶栏**平时完全隐藏，鼠标进窗口最顶部 50px 内才滑出（`CHROME_ZONE` / `setChromeVisible`），移开收起（菜单 / 弹窗打开时不收）；开书先 `showChromeTemporarily(2200)` 露 2.2 秒。
  只留 `返回+章节名 | 语言开关 | 目录 | ⋯`；其余收进 `⋯` 菜单（全文翻译 / 词典 / 笔记·划线 / 设置 / 沉浸）。
  中文书隐藏 `⋯` 里的全文翻译与词典（`applyLangModeForBook`）。
- **窗口标题栏跟随应用主题**（2026-10-17 修）：`app.py:_apply_titlebar()` 用 Win11 `DWMWA_CAPTION_COLOR/TEXT_COLOR/BORDER_COLOR` 把标题栏染成与 `--bg` 完全相同的颜色；前端切主题时通过 `AppApi.set_theme()`（pywebview JS 桥）实时改色，不再跟 Windows 系统主题走。pywebview 自带的 `update_title_bar_theme` 会被替换掉，防止系统切主题时把标题栏改回去。
- **正文必须能选中**：`webview.create_window(..., text_select=True)` 是红线；pywebview 默认 `text_select=False` 会给 `body` 注入 `user-select:none`，划线 / 翻译 / 词典全部失效（2026-10-17 修）。
- **主题持久化**：`webview.start(private_mode=False, storage_path=state/webview)`，否则 pywebview 关窗会清空 localStorage（主题 / 字号 / 阅读进度全丢）。主题同时写 `config.ini`，重启后首屏直接是深色，不闪白。
- **顶栏是浮层，不挤正文**：顶栏 / 翻译进度条都用 `position:absolute`，正文 `padding-top` 预留高度，顶栏滑出 / 收起时正文**一动不动**。
- **正文**：连续滚动跨章无缝衔接（滚动近顶 / 底约 500px 自动加载邻章，短章链式补载，prepend 修正 `scrollTop`，`overflow-anchor: none`）；宽 **720px 居中**（⚠️ 曾改成过撑满全屏，用户嫌宽、读着累，要求改回，**别再改成 100%**）；隐藏滚动条；不显示章节分隔标题（曾像"顶部残影"，已被 CSS `display:none`）。
- **两种阅读方式（2026-10-21 新增，⋯ 菜单第一项「单章阅读：开 / 关」）**：
  - 默认**连续滚动**（上面的行为不变）；
  - 开启**单章阅读**后，正文只装当前这一章，章末出现 `‹ 上一章 / 第 N / M 章 / 下一章 ›`，点按钮才换章；`state.singleChapter` 记忆在 `localStorage: reader:singleChapter`（默认关）。
  - 单章模式下 `autoLoadAdjacent()` 直接返回，**绝不预载前后章**——这样「对照」模式也不会顺手把下一章翻译了（用户明确要求两种方式都要保留，避免误翻下面的内容）。
  - TTS 整本朗读在单章模式下读完本章会停并提示点「下一章」，不会自动补载；切换方式时会 `stopTts()` 并 `resetToChapter(当前章)` 重建正文。
- **三态语言模式**（`原文 | 对照 | 中文`，记忆 `localStorage: reader:langMode`，集中在 `setLangMode()`）：
  - `对照` = 每个自然段英文下方紧跟该段**整段**中文（块级 `.seg-zh`），不是逐句；
  - 切对照会**按需自动翻译**在读章节里没翻过的段（花 API 费，用户已知晓同意）。防重 / 防死循环：前端 `translateInFlight` / `translateAttempted`、全文翻译轮询中跳过、后端 `_CHAPTER_LOCK` 串行化。
- **中文书零翻译概念**：导入时按中文字符占比 ≥30% 判语种存 `books.language`（老书启动自动回填 `backfill_languages()`）；中文书隐藏语言开关 / 全文翻译 / 操作栏词典·翻译 / 书架徽章，强制原文模式；且**刻意不写 `reader:langMode`**，不要污染英文书的语言记忆。
- **选字操作栏**（`#sel-toolbar`）：`复制 / 划线 / 词典 / 翻译 / 朗读`（**没有 × 按钮**；中文书只留 复制 / 划线，`applyLangModeForBook` 控制；英文书切到「中文」显示时也隐藏「朗读」，`setLangMode` 控制）。
  浮在选区**下方**（Chrome 自带选中浮条在上方、网页关不掉，会挡住我们；下方放不下才退回上方）；闲置约 4 秒自动消失；点别处 / Esc 收起；点正文空白不能反复冒出（靠 `selectionTextAtMouseDown` / `mouseDownPoint` 区分"拖选用字"与"原地点击"）。
- **翻译气泡**（`#bubble`）：可拖动、`max-height:70vh` 内部滚动、定位后"夹取"到窗口内不被裁；气泡内可 复制 / 划线。
- **注释气泡**（`#note-bubble`）：点正文注释角标（`[N]` 上标，如四大名著）弹出注释内容（可拖动、限制在窗口内；Esc / 点外 / 滚动正文关闭）。
  ⚠️ 含 `#` 的链接一律 `preventDefault`（真跳会 404）；目标锚点在本章才弹，不在就什么都不做。
  角标样式与正文同色、无下划线（`.reader-content .inner a`）；章末注释列表 `p.note` 由 CSS 隐藏，JS 从 DOM 取文本（`showChapterNote`）。
- **全文朗读**（2026-10-21 新增，**只给英文书**）：顶部栏「朗读」→ 从当前屏幕上第一段英文开始，逐句朗读，自动一章接一章读到全书结束；中文书由 `applyLangModeForBook` 隐藏入口。
  - **只读选中的一段**：选中文字 → 操作栏「朗读」→ 按选区跨段收集句子，只读刚选中的内容，读完就停（`tts.mode = "selection"`）；**整个选中区域标淡绿（`::highlight(tts-selection)`），正在读的那一句再叠深一点（`::highlight(tts-current)`）**，开始前会清掉蓝色原生选区。
  - 正在读的**那一个句子**加 `::highlight(tts-current)` 淡绿底（CSS Custom Highlight，按句子字符区间标，不整段变绿），并自动滚到这句；读完这一句 / 停止朗读后颜色自动清掉、恢复原色。全文朗读没有选中区域，所以只显示当前句。右下角浮出控制条：暂停 / 继续、停止、语速（0.8× / 1.0× / 1.2× / 1.5×，记忆 `localStorage: reader:ttsRate`）。
  - **声音不走浏览器自带的 Web Speech**：实测 WebView2 里 `speechSynthesis.getVoices()` 只有中文声音（Huihui / Kangkang / Yaoyao），念英文是中文腔。改成前端把每句发给 `POST /api/tts`，后台用 Windows 自带英文声音（优先 Zira）合成 WAV，前端用 `<audio>` 播放。
  - 前端逐句切分（缩写如 U.S. / Mr. 不误切），每句带原文字符偏移（`{seg, text, start, end}`），用于只高亮当前句；播放时提前合成下一句（prefetch），句间几乎无停顿；音频用 Blob 地址，播完必须 `revokeObjectURL`。
  - 点「朗读」的同一瞬间先播静音把 `<audio>` 解锁（浏览器自动播放限制）；暂停是真的暂停音频，继续从原处接着念；改语速会重念当前这一句。
  - 退出阅读器 / 跳章 / 换书都会 `stopTts()`，不会出现“回书架还在念”。
- **划线**：`annotations` 表存 `(seg_index, char_start, char_end)`，渲染 `<mark class="hl">` 只包选中字符区间（旧数据无区间 → 整段高亮）；**删除划线后正文颜色必须立刻消失**（`repaintHighlightAfterDelete`：内存缓存 + 重拉该章双保险，历史修过的 bug，别弄丢）；中文模式禁止划线。
- **全文翻译**：后台跑、顶部进度条（`#translate-bar` 浮层）、可停止、断点续传（翻过的永久保留）。
- **设置弹窗**：字号 / 主题 / 翻译模型（厂商下拉 + API Key / Base URL / 模型名 + 测试连接 + 保存 → 写 `config.ini`，**立即生效**不重启）。
- **切换语言 / 译文到位时保住阅读位置**（第 15 轮修）：切「原文 / 对照 / 中文」或在对照模式下等着译文陆续到位时，画面**不许跳**（用户报过"点一次就得自己滑回原处"）。原因：对照会在每段下面插整块中文、切回原文又删掉，正文上方的高度一变、同样的 `scrollTop` 就窜位了；而 `#reader-content` 关掉了浏览器自带的滚动锚定（`overflow-anchor: none`）。
  做法：`captureReadingAnchor()` 记住"视口顶部那一行"（`span.seg`）离正文区顶部的距离，重排后 `restoreReadingAnchor()` 把差值补进 `scrollTop`；统一走 `rerenderKeepingPosition(render)`。
  **所有会改高度的重排都要套上它**（现有 3 处）：`setLangMode()`、`ensureChapterTranslated()`（按需译文到位）、`reloadLoadedChapters()`（全文翻译结束）。实测三种模式来回切，锚点行漂移 0px。
- **阅读进度**：`localStorage: progress:<book_hash>`。
- **笔记 / 词典浮窗（「并排模式」，第 15 轮）**：在阅读器里打开笔记或词典 → 弹窗变成**可拖动浮窗**：按住标题栏（`.notes-head` / `.modal-head`）拖到任意位置（`makePanelDraggable` + `clampToWindow`）。
  - 浮窗加 `.modal.panel-float`：**不铺暗遮罩、整层 `pointer-events:none`、窗口本身 `auto`** —— 正文照常滚动 / 选词 / 划线，真正做到「边看原文边看词典 / 笔记」（实测浮窗开着滚轮仍滚正文）。
  - **正文一动不动**（用户明确要求「中间原文的界面不要动」）：浮窗只浮在上面，**不占正文的位、不缩窄 / 不左移正文列**，`.reader-content` 的 `padding` 和 `.inner` 的 720px 阅读宽度都不许动。挡到字就自己把浮窗拖开 / 关掉（见第 7 节坑 15：曾用 `padding-right` 让正文让位，用户否掉，已删，**别再改回去**）。
  - 书架页打开仍是**普通居中弹窗**（`setPanelFloat(modal, false)` 会清掉拖动留下的内联定位）；`Esc` / 关闭键 / `返回书架`（`closeFloatPanels`）都能关。
  - 因为遮罩不再接鼠标事件，**点浮窗外的空白不再关闭它** —— 笔记明细页右上角因此补了 `#notes-detail-close`（占位宽度复用 `.notes-head-pad`，标题仍居中）。
  - 浮窗不算「弹窗打开」，顶栏照常按鼠标位置自动显隐（`mousemove` 里用 `.modal:not([hidden]):not(.panel-float)` 判断）。

### 2.3 笔记页（`#notes-modal`，仿微信读书两级页面，**划线专用**）

- 入口三个：书架顶部「笔记」、统计条「划线」chip、`⋯ → 笔记·划线`（直达该书明细）。
- 页 1 总览：每本留过划线的书一张卡（大数字 `N 条划线` + 书名 + 封面）。
- 页 2 明细：按**章**分组（组头吸顶），功能行 `搜索 / 复制全部 / 释义 / 导出笔记`，条目 = 绿色 `A` 徽章 + 划线原文（+ 词典释义），悬停浮现 复制 / 删除；**点击划线原文会跳回阅读器，只把那段划线加淡蓝底**，**笔记面板不关闭、留在正文旁边当并排浮窗**（左下角另有「‹ 返回划线」）；明细页右上角 `×` 关闭整个笔记页（`#notes-detail-close`）。
- 复制全部 / 导出 = 整本按章拼**纯文本**，文件 `书名 - 笔记.txt`；搜索为客户端过滤。
- **「释义」开关**（第 15 轮；默认开，记忆 `localStorage: reader:notesDict`）：给每条划线在下方显示词典词条（音标 / 词性 / 中文意思）。
  - 渲染复用 `renderDictionary(entry, box, {compact:true})`：**compact = 不重复单词、不带例句**（几十条都带例句会把列表撑得很长）；条目区 `.nd-item-dict`，状态提示 `#nd-dict-tip` **只在查询中显示进度，查完自动隐藏**（用户明确说不要“已给每条划线显示词典释义…”那句常驻提示，别再把它加回来）。
  - 请求**并发 3 个**（`NOTE_DICT_CONCURRENCY`），本地 `noteDictCache` + 服务端 `phrase_cache` 双层缓存 → 关掉再打开秒出、不重复花钱；失败 / 超 60 字的整句只显示一句提示、不反复重试（关掉再打开会 `noteDictFailed.clear()` 给一次重试机会）。
  - 批量查词**带 `record:false`**，不写进「查词记录」—— 词典面板里只留用户自己主动查过的词。
- 在阅读器里打开时是**并排浮窗**（见 2.2 最后一条）；书架页打开仍是居中弹窗。
- Esc 可关闭（所有 `.modal` 都支持）。

### 2.4 已按用户要求**删除**的功能（**不要加回来**）

- 「想法 / 笔记」功能（2026-10-15 删，笔记页改划线专用；库里残留 note 记录不展示；server 仍接受 note 类型，无需处理）。
- 书签功能（2026-10-14 删）。
- 底部信息栏、上 / 下一章按钮、独立「译」按钮、操作栏「×」、顶栏"闲置 2.5 秒自动收起"、章节分隔标题、书架进度条 / 百分比 / 已译段数 chip。
- 中文书的任何翻译 UI；注释角标跳转、蓝色角标样式。

### 2.5 未确认的提议（**用户没点头前不要擅自做**）

疑似广告页跳过开关（Economist 电子书里夹着原书自带的中文广告页）/ 翻完整本后导出中文 EPUB / 书架搜索、排序、"继续阅读"入口。

### 2.6 防打架与缓存治理（通用硬性要求）

- **禁止浏览器翻译本页**：`<html translate="no">` + `<meta name="google" content="notranslate">`（否则浏览器翻译会改掉 `span.seg` 文字，对照 / 重绘全乱）。
- 首页 HTML `Cache-Control: no-cache`（防"新 JS 配旧 HTML"白屏）；静态资源按 mtime 加 `?v=`（`_asset_version()`）；所有浮层的 `hidden` 由 `style.css` 开头的全局 `[hidden]{display:none!important}` 统一兜底（见坑 2），操作栏另设内联 `style.display`。
- "改完却看到旧界面"九成是**旧服务没关**（见 0 节与第 7 节坑 5）。

---

## 3. 配置（config.ini）

| 段 | 键 | 说明 |
|---|---|---|
| `[api]` | `api_key` / `base_url` / `model` | OpenAI 兼容接口；当前 DeepSeek + `deepseek-chat` |
| `[translation]` | `max_workers=5`、`max_chars_per_req=1800`、`request_timeout=120`、`max_retries=6`、`retry_wait_base=2`、`glossary_sample=120`、`summary_window=8`、`temperature=0.3` | 并发 / 单请求拼批上限 / 超时与指数退避重试 / 术语表全书抽样段数 / 前文摘要窗口 / 温度 |
| `[server]` | `host` / `port=5000` / `auto_open_browser=true` | 改端口要同步改 `启动阅读器.bat` 里两处 5000 |
| `[ui]` | `default_font_size=19` / `default_theme=dark` | 默认字号 / **上次选择的主题**（用户切主题时会被后端写回，启动首屏直接用它） |

- API 配置必须全放 `config.ini`，**代码不得写死**。
- 设置面板保存走 `config.py: save_api_settings()`：按行正则替换只改 `[api]` 三行（`configparser` 写回会丢全部中文注释）。
- 主题保存走 `config.py: save_theme()`，只改 `[ui] default_theme`；读取一律 `utf-8-sig`，写回 `utf-8`（无 BOM）。

---

## 4. 技术栈与文件

Python 3.13 + Flask / ebooklib / BeautifulSoup / openai / tenacity / SQLite；前端原生无框架（改完刷新即生效）。
正文解析用的是 BeautifulSoup 内置的 `html.parser`，**不需要 lxml**（`requirements.txt` 里已移除）。

| 文件 | 职责（改前先看文件头注释） |
|---|---|
| `main.py` | 网页版入口：读配置 → 起 Flask → 自动开浏览器 |
| `app.py` | **桌面版入口**：起 Flask → pywebview 原生窗口（标题栏配色 / 主题持久 / 文字可选 / 静态资源同步） |
| `config.py` + `config.ini` | 配置读取校验；`save_api_settings()` / `save_theme()` 按行写回（保留中文注释，兼容 UTF-8 BOM） |
| `epub_processor.py` | 解析 EPUB：spine 顺序取章节、清洗正文、抽可译段 |
| `state_manager.py` | **全部 SQL**（books / segments / meta / phrase_cache / annotations / dict_history），线程安全；含 `detect_language()` 语种检测 |
| `translator.py` | AI 层：分批切片、术语表、前文摘要、并发重试、全文 + 按章翻译、`lookup_word()` 词典、`test_connection()` |
| `tts_engine.py` | **朗读引擎**：pythonnet 调 .NET `System.Speech`，用 Windows 英文声音（优先 Zira）把一句英文合成 WAV；全局锁串行，首次调用约 0.5s、之后每句约 0.05s |
| `server.py` | 全部 HTTP 接口 + `_asset_version()` + 主题保存接口 |
| `templates/index.html` | 页面骨架（**改了要重启服务**） |
| `static/app.js` | 全部前端交互（文件头有目录） |
| `static/style.css` | 样式与主题变量（`body[data-theme]` + CSS 变量） |
| `static/brand.png` | 应用图标（书架左上角 / favicon），与 `icon.ico` 同源 |
| `icon.ico` / `icon_preview.png` | exe / 窗口 / 快捷方式图标；`make_icon.py` 生成（多尺寸） |
| `EPUBReader.spec` + `version_info.txt` | PyInstaller 打包配置 / 版本资源（产品名「译读」） |
| `state/reader.db` | SQLite 数据（翻译缓存 / 进度 / 标注） |
| `state/webview/` | WebView2 的 localStorage / cookie（**别删**，主题 / 字号 / 进度在里面） |
| `static/books/<sha1>/` | 每本书解析产物：`ch_*.html` / `titles.json` / `assets/` / `cover.jpg` |
| `启动阅读器.bat` | **必须纯 ASCII 不能有中文**（见坑 7） |

---

## 5. 核心设计（为什么这么写）

1. **`span.seg` + `data-i` 管线**：服务端把每个可译节点包成 `<span class="seg" data-i="全书自增序号">`；译文回填、中文切换、划线定位全靠 `data-i` 对齐。前端把原文存 `span.dataset.orig`，重绘以它为准——**不要直接改 textContent 不留原文**。译文 / 划线按章缓存在 `state.chapterTranslations` / `chapterHighlights`，切模式纯前端重绘不重新请求。
2. **断点续传**：`segments` 三态 `pending / done / failed`，只跳过 `done`；崩溃重启后继续。
3. **翻译绝不整本发**：一次请求合并多段（受 `max_chars_per_req` 限制）+ 全书术语表（统一人名地名）+ 前文摘要窗口（保持前后一致）；整本发会截断、前后不一致（用户教训）。
4. **词语翻译缓存**：`phrase_cache` 按文本 hash（词典键加 `dict|` 前缀），同一个词查第二次不花钱。
5. **对照模式块级渲染**：`renderSegText()` 管单 seg 的"原文/中文 + 精确划线"；`renderDualBlocks()` 按**块级祖先**（通常 `<p>`，可能被拆成多个 seg）把整块译文拼成一段中文插 `.seg-zh`；每次先 remove 本节旧 `.seg-zh` 防残影。统一入口 `rerenderSection()`，`makeChapterSection` / `highlightSelection` / `reloadLoadedChapters` 都走它。
6. **词典走大模型**：`Translator.lookup_word()` 让模型返回结构化 JSON（音标 / 词性 / 释义 / 例句），不引第三方词典依赖。
7. **数据库平滑升级**：加列用 `PRAGMA table_info` 判断 + `ALTER TABLE ADD COLUMN`，保证旧库升级不丢数据。
8. **「⋯」菜单 DOM 刻意放 `header` 外面**（放里面被 `overflow:hidden` 裁掉），由 `setMoreMenu()` 绝对定位对齐到「⋯」下方。

---

## 6. 数据与接口速查

### SQLite 表

`books`（书库，含 `language` 列）/ `segments`（翻译缓存进度，`book_hash + seg_index`）/ `meta`（术语表、前文摘要）/ `phrase_cache`（词语缓存）/ `annotations`（类型 `highlight` / `note`，`note` 已废不展示；划线含 char 区间）/ `dict_history`（查词记录：`word` 主键 `COLLATE NOCASE` + `looked_at` + `book_hash` + `chapter_index` / `seg_index`（2026-10-21 新增，点词跳回原文用；老库用 `PRAGMA table_info` + `ALTER TABLE` 自动补列，老记录为 NULL 时按词现搜），只记词不存释义；重复查用 `INSERT OR REPLACE` 刷新时间和书，所以表不会越滚越长）。

### HTTP 接口（server.py）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 页面（不缓存） |
| GET / POST / DELETE | `/api/books`、`/api/books/import`、`/api/books/<hash>` | 书架列表（含划线数）/ 导入（sha1 判重）/ 删书 |
| POST | `/api/books/<hash>/readtime` | 阅读时长心跳上报（body `{"seconds":n}`，夹在 1~300；books 的 `total_read_seconds` 累加） |
| GET | `/api/books/<hash>/chapters`、`.../chapter/<n>` | 目录 / 某章正文（已包 span.seg）+ 译文 + 划线 |
| POST | `/api/books/<hash>/locate` | **按词在原文里找位置**（body `{word}`，返回第一处 `{chapter_index, seg_index, text}`；老查词记录跳回原文用，结果有内存缓存） |
| POST | `/api/tts` | **英语朗读**：body `{text, rate}`，返回一句英文的 WAV 音频（Windows 英文声音合成；无英文声音时返回中文错误） |
| POST | `/api/books/<hash>/chapter/<n>/translate` | 按需翻一章（全文翻译进行中直接返回现状） |
| POST | `/api/translate`、`/api/dictionary` | 点词翻译 / 词典（都带缓存；词典**查成功后**才写查词记录，传 `record:false` 则不写 —— 笔记页批量释义用；传 `book_hash` + `chapter_index` / `seg_index` 记下"在哪本书、哪一段查的"，供词典面板分格 + 点词跳回原文） |
| GET / DELETE | `/api/dictionary/history` | 查词记录（最近查的排前面、最多 200 条；每条会按 `dict\|` 前缀去 `phrase_cache` 把**完整词条**取回来一起返回，并连表带出 `book_hash` / `book_title` 供前端分组）/ 清空记录 |
| DELETE | `/api/dictionary/history/word?word=...` | 删除单个词的查词记录（大小写不敏感；只删记录，不删词条缓存） |
| POST + GET + POST | `/api/books/<hash>/translate`、`.../translate/progress`、`.../translate/cancel` | 全文翻译 启动（后台线程）/ 进度（1.5s 轮询）/ 停止 |
| GET / POST | `/api/books/<hash>/annotations`，DELETE `/api/annotations/<id>` | 标注查增 / 删 |
| GET / POST | `/api/settings`，POST `/api/settings/test` | 读 / 存模型配置（存完立即生效）/ 测连接 |

### 排查命令（PowerShell，项目目录）

```powershell
# 服务是否在跑 / 书的状态
(Invoke-WebRequest http://127.0.0.1:5000/api/books -UseBasicParsing).Content
# 查数据库（书 / 翻译进度 / 标注数）
python -c "import sqlite3;c=sqlite3.connect(r'state\reader.db');print(c.execute('select title,chapter_count,seg_count from books').fetchall());print(c.execute('select status,count(*) from segments group by status').fetchall());print('annos',c.execute('select count(*) from annotations').fetchone())"
# 谁占着 5000 端口（排查旧服务没关）
(Get-NetTCPConnection -LocalPort 5000 -State Listen).OwningProcess
```

---

## 7. 踩过的坑（改时千万别踩回去）

1. **ebooklib 漏正文**：`get_items_of_type(ITEM_DOCUMENT)` 只认 `application/xhtml+xml`，真书多为 `text/html` 被归 `ITEM_UNKNOWN` 丢掉 → 已改按 `spine` + 后缀判断（`_ordered_documents` / `_is_html_item`）。`spine` 里 `linear="no"`（封面）要跳过；书自带目录页（链接占比 ≥0.8 且无长段落）要跳过。
2. **`hidden` 属性失效**：`.modal` / `.sel-toolbar` 等自带 `display` 会覆盖浏览器对 `[hidden]` 的默认 `display:none`。**已在 `style.css` 开头用一条 `[hidden] { display: none !important; }` 全局兜底**，新加浮层不必再逐个补规则；操作栏另外仍设内联 `style.display` 作双保险。这个坑害得用户抱怨"操作栏关不掉"好几轮。
3. **不重启不生效**：Flask `debug=False`，改 `.py` / Jinja 模板必须重启服务。
4. **首页 HTML 被浏览器缓存**：会出现"新 JS 配旧 HTML"→ 报错 / 空白，已用 `no-cache` 解决。
5. **旧服务进程挡道**：旧服务占着 5000 时启动脚本只开网页 → 先 `Ctrl+C` 再启动；用 `Get-NetTCPConnection` 查占用。
6. **SQLite 加列**：老库 `CREATE TABLE IF NOT EXISTS` 不会补列，必须迁移。
7. **`启动阅读器.bat` 必须纯 ASCII**：cmd 解析含多字节字符的 .bat 会错位（`'em' 不是内部或外部命令`），UTF-8 / GBK 都一样；提示文字用英文，中文说明放本文件。自查：`(Get-Content -Encoding Byte 启动阅读器.bat | Where-Object { $_ -gt 127 }).Count` 应为 0。
8. **旧划线数据兼容**：早期无 char 区间（NULL）→ 渲染退化为整段高亮。
9. **别删真书测删除**：`DELETE /api/books/<hash>` 连已翻段落一起删，重导要重新花钱翻译。
10. **用户看到的"×"可能不是页面元素**：跟着鼠标动 → 是鼠标指针 / 截图准星。
11. **Chrome 自带选中文字浮条网页关不掉**：我们的操作栏放选区**下方**回避。
12. **`configparser` 写回丢注释**：`save_api_settings()` 用按行正则替换（见第 3 节）。
13. **浏览器翻译和阅读器打架**：`translate="no"` + `notranslate`（见 2.6）；注意浏览器 / 扩展自己的浮条网页无权移除。
14. **保存设置立即生效**：`POST /api/settings` 写完文件会更新内存 `cfg` 并重建 `Translator`，用户不用重启。
15. **浮窗不许挪动正文**：2026-10-16 第 15 轮第一版给 `.reader-content` 加了 `padding-right: var(--panel-reserve)`（浮窗打开时正文列左移让位），用户回「中间原文的界面不要动」→ 已全部删掉（`syncPanelOpen` / `--panel-reserve` / `#reader-view.panel-open` 都不存在了）。**正文的 `padding` 与 `.inner` 的 720px 是红线**，浮窗只负责"浮在上面 + 能拖走"。
16. **重排不许弄丢阅读位置**：任何"会改正文高度"的重排（插 / 删对照译文块、中文换原文、`innerHTML` 重建）都必须走 `rerenderKeepingPosition()`（`captureReadingAnchor` / `restoreReadingAnchor`），否则用户点一下「原文 / 对照」画面就窜走 —— 用户明确抱怨过。注意 `#reader-content` 的 `overflow-anchor: none` 是为了手动修正"向上补载章节"的滚动，**不要**直接改成 `auto` 图省事（会和 `prependChapter` 的手动修正叠加成双倍跳动）。
17. **pywebview 默认清 localStorage**：`webview.start()` 的 `private_mode` 默认是 `True`，关窗会清 cookies / localStorage，主题、字号、阅读进度（`progress:<hash>`）、语言模式全丢。必须 `private_mode=False` + `storage_path=state/webview`。**这是用户报“每次设深色、重开又变白”的根因。**
18. **pywebview 默认禁止选字**：`create_window` 的 `text_select` 默认 `False`，pywebview 会注入 `body{user-select:none}`。阅读器靠选中文字划线 / 翻译 / 查词，必须 `text_select=True`。实测 `getComputedStyle(body).userSelect` 应为 `auto`（不是 `none`）。
19. **标题栏会跟系统主题走**：pywebview 的 WinForms 壳会按 `AppsUseLightTheme` 自动设置标题栏，并在系统主题变化时回调。只用 DWM 设一次会被它覆盖，所以要 `native.update_title_bar_theme = api.apply_current` 接管，并让前端切主题时通过 `AppApi.set_theme()` 实时同步。深色下标题栏 / 正文都必须是 `#16181c`，浅色都是 `#f7f7f5`（实测采样过）。
20. **升级后静态资源不更新**：`_ensure_static_in_base()` 曾经“目标文件存在就跳过”，导致换了新 exe 仍加载旧 app.js。已改为 `filecmp.cmp(..., shallow=False)` 内容比对；改这段时别退回“只判断存在”。
21. **config.ini 可能带 BOM**：Windows 记事本另存为 UTF-8 会加 BOM，`configparser.read(encoding="utf-8")` 会报 `MissingSectionHeaderError` 直接起不来。读取一律用 `utf-8-sig`（`load_config` / `save_api_settings` / `save_theme`），写入用 `utf-8`（不要 BOM）。
22. **桌面版没有英文朗读声音**：WebView2 的 `speechSynthesis.getVoices()` 实测只有 Huihui / Kangkang / Yaoyao 三个中文声音（系统 SAPI 里明明有 Zira，但 WebView2 不给），所以**不能**用浏览器自带的 Web Speech 读英文。现在的做法是后台 `tts_engine.py` 用 `System.Speech` 合成 WAV。
    - `clr.AddReference("System.Speech")` 会报找不到程序集；必须先在 `C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Speech\*\System.Speech.dll` 找到完整路径再 `AddReference(路径)`（`_find_speech_dll()` 已处理）。
    - `<audio>` 的自动播放会被浏览器拦：点「朗读」时必须在同一个用户手势里先播一段静音解锁（`TTS_SILENT_WAV`），否则后面异步拿到的音频 `play()` 会失败。
    - 音频是 Blob 地址，播完 / 停止 / 改语速都要 `revokeObjectURL`，否则听一整本会持续吃内存。
    - 后台合成有延迟，必须用 `token` 区分“第几轮朗读”，否则停止后旧请求回来会继续念；下一句要提前合成（prefetch），不然句间会有明显空档。
23. **单章阅读会漏掉“自动补邻章”的入口**：任何会自动加载前后章的地方都必须先判断 `state.singleChapter`。目前有两处：`autoLoadAdjacent()`（滚动补载）和 `advanceTtsChapter()`（整本朗读换章）。漏掉任何一处，单章模式下都会偷偷补下一章，「对照」模式还会顺手把下一章翻译了——这正是用户要求加这个开关的原因。
24. **跳回原文只能标“一个词”，不能标整句 / 整段；而且词典 / 笔记面板不能收掉**（用户明确反馈过两次）：早期实现用 `Range` 选中整句 + 给整段加 `.jump-flash`，用户看到的是一大块蓝色 + 绿色，明确说“我只需要标注一个词”；后来又要求“词典也要在文章旁边对照”。现在是 `revealOriginalTarget()` + `markJumpRange()`，用 CSS Custom Highlight API（`CSS.highlights.set("jump-target", new Highlight(range))` + `::highlight(jump-target)` 样式）只标精确字符区间；跳转时用 `focusStudyPanel(origin)` 把来时的词典 / 笔记面板转成并排浮窗**留在正文旁边**（不要改回 `closeStudyPanels` 把它们收掉）。不支持该 API 时才退回“用选区选中这个词”。左下角仍保留「‹ 返回词典 / ‹ 返回划线」（`#btn-back-panel` + `jumpOrigin`）。
25. **朗读高亮：全文朗读只标当前句；选句朗读要标“整个选中区域” + 当前句加深**（用户先反馈“整段变绿不好看”，又反馈“为什么不是我选中的部分都标绿”）：早期给 `span.seg` 加 `.tts-active`，整段都是绿色。现在 `splitTtsSentences()` 返回 `{text, start, end}`，`highlightTtsSentence()` 用 `CSS.highlights.set("tts-current", ...)` 只标当前句；选句朗读时 `selectionTtsChunks(sel)` 额外返回整段选区的 `ranges`，`markTtsSelection()` 用 `CSS.highlights.set("tts-selection", ...)` 把整个选中区域标淡绿，当前句的 `tts-current` 叠在上面更深。每读下一句先清 `tts-current`，`stopTts()` 同时清 `tts-selection` / `tts-current`，原有划线颜色会露出来。选句开始前要清掉蓝色原生选区，否则会看起来“整段都被标了”。**不要再退回 `.tts-active` / 整段背景**。中文模式下显示的是译文、字符偏移对不上，只滚动不标色。

---

## 8. 改代码检查清单（每次改完对着过一遍）

- [ ] 对过第 2 节（不许破坏的行为）与第 7 节（坑）。
- [ ] 没写死 API 配置；没未经确认花钱；删书测试用假 hash。
- [ ] 自己跑过服务 / 调过接口 / 浏览器实测，确认没报错。
- [ ] 已提醒生效方式：`.py` / `index.html` / `config.ini` → 重启；`static` → 刷新；旧服务要先关。
- [ ] 改端口 / 启动方式 → 同步改 `启动阅读器.bat`（确认纯 ASCII）。
- [ ] 已按需同步更新本文件。

---

## 9. 改动时间线（仅追溯用，细节以上文为准）

- **2026-10-12**：初版（导入 / 阅读 / 点词翻译 / 全文翻译 / 标注 / 主题 / 字号 / 进度记忆）。
- **2026-10-13（第 1-6 轮）**：阅读界面系列改造（删底栏、沉浸顶栏、完整操作栏、对照模式 + 按章翻译、顶栏浮层、去残影、`?v=` 根治缓存）、书架改版 + 删书 + 拖拽、正文先撑满后改回 720px（第 10 轮）。
- **2026-10-14（第 7-9 轮）**：设置面板加翻译模型配置（立即生效）、词典查词、笔记按章、删书签、书架丰富化。
- **2026-10-15（第 10-12 轮）**：笔记页仿微信读书重做（划线专用）、删「想法/笔记」、中文书零翻译 UI、注释气泡（不跳转可拖动）、前端死代码清理（约 19 行）、本文档精简重写。
- **2026-10-15（第 13 轮 · 只精简、不改前端与功能）**：删掉空文件「新建 文本文档.txt」、`__pycache__`、`.codebuddy/`（上个 AI 工具的开发计划稿）；`config.py` 四个重复的 `_get_int/_get_float/_get_bool/_get_str` 合并成一个 `_get()`，删掉没人读的 `Config.base_dir`；`state_manager.py` 删掉没人调用的 `Store.close()`；`app.js` 三个 api 封装合并为 `api()`、抽出 `clampToWindow()`（5 处浮层定位复用）/ `groupByChapter()` / `syncLangSwitch()` / `makeStatChip()`；`style.css` 用一条全局 `[hidden]` 规则取代 10 处重复补丁、删掉一条完全重复的 `.sel-toolbar button:hover`；`requirements.txt` 去掉没用到的 `lxml`；`启动阅读器.bat` 修正乱码注释；界面上几处过时文案改对（"想法"、"个笔记"、"书签"）。**接口、DOM 结构、样式效果、用户可见文字含义均未改变**（仅 3 处措辞纠错）。
- **2026-10-15（第 14 轮）**：词典面板重做成「查词记录」。新表 `dict_history`（`word` 主键 `COLLATE NOCASE` + `looked_at`，重复查用 `INSERT OR REPLACE` 刷新时间，表不会越滚越长）；`POST /api/dictionary` 查成功后自动记录（阅读器气泡的词典走同一接口）；新增 `GET` / `DELETE /api/dictionary/history`，其中 `GET` 会按 `dict|` 前缀去 `phrase_cache` 把**完整词条**拼回来（**不重复存一份**），面板因此能直接显示音标 / 释义 / 例句。**按用户要求删掉了书架页词典弹窗里的查询框和结果区**（`#dict-input` / `#dict-search-btn` / `#dict-result` / `.dict-search` / `.dict-tip` / `lookupFromShelf()` 全部清除），查词入口只剩「阅读器选中文字 → 操作栏词典」；面板的唯一渲染入口是 `renderDictHistory()`，条目正文复用 `renderDictionary()`，「清空」只删记录、不动物典缓存。
- **2026-10-17（第 16 轮）**：品牌与桌面体验修复。
  - 改名「译读 · 英文阅读器」；新图标（深墨绿圆角方块 + 奶油书页 + A/文 + 薄荷星芒），多尺寸 ICO + `static/brand.png`；exe 版本资源写入产品名。
  - 修「深色主题重启变白」：`private_mode=False` + `storage_path=state/webview`（localStorage 不再丢）+ 主题写回 `config.ini`（首屏不闪白）。
  - 修「最上面状态栏不跟背景」：Win11 DWM 标题栏染色 + 前端 JS 桥实时同步 + 接管 pywebview 系统主题回调；深 / 浅色都实测像素一致。
  - 修「正文选不中」：`text_select=True`（pywebview 6.2 默认注入 `user-select:none`）。
  - 修「升级后界面不更新」：静态资源按内容比对覆盖。
  - 修「config.ini 带 BOM 起不来」：统一 `utf-8-sig` 读取。
  - 删书时先取消该书正在跑的全文翻译，避免删完还在后台扣费。
  - 设置面板主题按钮加选中态（浅色 / 深色图标 + 绿色描边）。
  - 2026-10-17 补充：查词记录里 23 条老数据（`book_hash` 为空）手工归到 `TheEconomist.2026.10.17`；笔记页「已给每条划线显示词典释义…」的常驻提示去掉，只在查询中显示进度。
  - **2026-10-17（第 17 轮）**：词典面板整体改成和笔记页一样的两级页面。
    - 总览：每本查过词的书一张 `.nb-card`（大数字 + 书名 + 最近查词 + 封面），底部「导出全部 / 清空全部」。
    - 明细：书籍卡 + `搜索单词 / 复制全部 / 导出` + 按查询日期分组的 `.nd-group-head` + 词条卡片（`Aa` 徽章、音标、词性释义、例句、查询时间）；悬停显示 复制 / 删除。
    - 新增 `DELETE /api/dictionary/history/word` + `Store.delete_dict_history()`；只删 `dict_history`，保留 `phrase_cache`。
    - 阅读器 `⋯ → 词典` 改为直接打开当前书的明细；书架「词典」仍打开总览；浮窗拖动复用 `.notes-head`。
    - 实测：总览 2 本书 / 25 个词；明细 23 个词分 3 个日期组；搜索「squeeze」命中 1 条；插入假词后单条删除，计数 24→23，DB 同步；无 JS 报错。
- **2026-10-16（第 15 轮）**：按用户要求做「边看原文边看笔记 / 词典」。
  - 笔记页 / 词典页改成**可拖动浮窗**（`makePanelDraggable` 按住 `.notes-head` / `.modal-head` 拖，`clampToWindow` 夹在窗口内）。
  - 阅读器里打开 → **并排模式** `.modal.panel-float`：不铺暗遮罩、整层 `pointer-events:none`、窗口 `auto`，正文照常滚动 / 选词；书架页仍是居中弹窗。**正文完全不动**（第一版让正文列左移让位，用户要求改回，已删干净）。
  - 阅读器 `⋯` 菜单新增「词典」入口（中文书隐藏）；气泡查词成功后已打开的词典面板会同步刷新。
  - 笔记明细新增**「释义」开关**（默认开，`localStorage: reader:notesDict`）：每条划线下方显示词条（`renderDictionary(..., {compact:true})`），并发 3 个、双层缓存、批量查询带 `record:false` 不写查词记录。
  - `POST /api/dictionary` 新增 `record` 参数；笔记明细页右上角补 `#notes-detail-close`；`返回书架` 会关掉浮窗（`closeFloatPanels`）。
  - 修掉「点原文 / 对照画面就跳位」：新增 `rerenderKeepingPosition()`（滚动锚定），三处会改高度的重排全部套上（切语言 / 按需译文到位 / 全文翻译完成）。
  - 词典查词记录**按书分格 + 可导出**（用户要求「每本书查过的词典分格开、像划线那样，还要能导出」）：`dict_history` 加 `book_hash` 列（老库自动补列），`POST /api/dictionary` 接 `book_hash`（阅读器查词时带上当前书），`GET /api/dictionary/history` 连表带出 `book_title`；前端 `groupDictByBook()` 分组渲染（`dh-group` 方框 + 组头书名/词数/「导出」），顶部加「导出全部」，`dictGroupToText()` + `downloadText()` 导出纯文本（笔记导出也改用同一个下载函数）。老记录没有书名 → 归到「（未分类）」。**实测**：库层迁移 + 接口 + 分格渲染 + 单组/全部导出全部通过（自测用 `reader.db` 副本，没碰用户真数据）。
  - **实测**（Chrome + 真实鼠标事件）：浮窗开着滚轮仍滚正文、拖动生效、Esc / 返回正常关闭、正文一动不动、25 条划线释义全部渲染；「原文 / 对照 / 中文」来回切 6 次，锚点行漂移均为 0px。
- **2026-10-21（第 18 轮）**：新增「全文朗读」（只给英文书，中文书隐藏入口）。
  - 顶部栏「朗读」按钮 + 右下角控制条（暂停/继续、停止、语速 0.8× / 1.0× / 1.2× / 1.5×）；全文朗读只给当前句加 `::highlight(tts-current)` 淡绿底；选句朗读把**整个选中区域**加 `::highlight(tts-selection)` 淡绿、当前句再叠深一点；读完 / 停止自动恢复原色（早期整段 `.tts-active` 被用户否掉）。
  - **选字操作栏新增「朗读」**：选中哪一段就读哪一段，读完即停（`tts.mode = "selection"`），不会自动接着读下一段；中文书 / 英文书的「中文」显示模式下隐藏该按钮。
  - **新增「单章阅读」开关**（⋯ 菜单第一项）：开启后正文只装当前这一章，章末出现「上一章 / 第 N / M 章 / 下一章」，点按钮才换章；关闭恢复连续滚动。`autoLoadAdjacent()` 在单章模式直接返回，TTS 读完本章也停，因此「对照」不会顺手翻译下一章；模式记忆 `localStorage: reader:singleChapter`（默认关）。
  - **点单词 / 划线跳回原文**：词典明细里点单词、笔记明细里点划线文字 → 自动打开对应章节，**只给那个词 / 那段划线加淡蓝底**（CSS `::highlight(jump-target)`，不选中整句、不闪整段——用户明确要求“只需要标注一个词”）；**词典 / 笔记面板不关闭，转成并排浮窗留在正文旁边**（`focusStudyPanel`，透明遮罩、正文可滚动），可以直接点下一个词继续定位；左下角另有「‹ 返回词典 / ‹ 返回划线」。词汇位置存 `dict_history.chapter_index / seg_index`（查词时由前端 `currentSelectionLocation()` 带上去），老记录走新增的 `POST /api/books/<hash>/locate` 按词现搜（内存缓存）。
  - 逐句切分（缩写保护，每句带字符 offset）、逐章自动衔接、prefetch 下一句；退出阅读器 / 跳章 / 换书自动停止。
  - **声音方案推翻过一次**：最初用浏览器 `speechSynthesis`，桌面版实测只有中文声音 → 改成 `tts_engine.py`（System.Speech）后台合成 WAV + 前端 `<audio>` 播放。
  - 实测（无头 Edge + 真实 `/api/tts`）：开始 10 次合成请求、暂停期间 0 次新请求、停止后控制条消失、改速重新合成、第 2 章自动读到第 3 章、中文书无朗读按钮、无 JS 报错、49 次请求全部 200。
