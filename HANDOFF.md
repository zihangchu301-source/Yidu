# 译读 · 项目交接文档

> 最后更新：2026-11-06 · 安卓最新版 **1.0.30**（version_code 30）· 新增账号 + 云端同步

## 1. 源码在哪

| 用途 | 路径 |
|---|---|
| **唯一开发目录（桌面版 + 手机版，含完整 .git）** | `D:\EPUBReader` |
| **远程仓库** | https://github.com/zihangchu301-source/Yidu |
| 主仓库原始副本（同样含 .git） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu-repo` |
| 桌面版工作副本（2026-11-05 迁移，已过时） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_desktop` |
| 手机版源码快照（无 .git，别改） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_phone` |
| 安卓签名密钥备份（**勿外泄**） | `E:\workbuddyClaw\2026-11-03-18-15-07\signing\` |
| 本次会话工作日志 | `E:\workbuddyClaw\2026-11-05-22-51-55\.workbuddy\memory\` |

**2026-11-06 起，`D:\yidu` 已并入 `D:\EPUBReader` 并删除。** 现在只有一个目录：

```
D:\EPUBReader\
├── EPUBReader.exe        旧版打包产物（无云端同步，可当回退）
├── 启动阅读器.bat         ← 以后双击这个（跑 .venv\Scripts\pythonw.exe source\app.py）
├── config.ini            唯一配置（含 API Key 与 [cloud]）
├── state\                唯一数据目录（reader.db / cloud.json / webview）
├── static\               唯一静态目录（app.js / style.css / books\ 书在这里）
├── source\               唯一源码（桌面版和安卓版共用）
├── .venv\                运行环境（约 200MB，别提交）
├── android\ .github\ docs\ tests\ python_shims\
└── .git\                 完整仓库，git push 即触发 APK 打包
```

关键规则（改代码前必读）：
- `config.py` / `app.py` 的基准目录：**脚本模式的运行目录 = `source\` 的上一级**，和 exe 模式完全一致。
  所以源码跑和 exe 跑用的是**同一份 config.ini / state / static**，不会出现两套书库。
- `create_app()` 的 static 目录由 `cfg.books_dir` 反推（`<运行目录>\static`），
  源码模式也读这里，不再读 `source\static`（那份是历史残留，已废弃）。
- `source\启动阅读器.bat` 保留只为兼容老快捷方式，内容改成转发到上一级启动器。

## 2. 仓库结构

```
D:\EPUBReader/                       # 仓库根 = 桌面版运行目录
├── .github/workflows/build-apk.yml   # CI：推 main 自动打包并发布
├── android/                          # Chaquopy + WebView 壳
│   ├── app/build.gradle              # 版本、签名、资源同步、version.json 生成
│   └── app/src/main/java/.../MainActivity.java
├── source/                           # Python 后端（Flask）
│   ├── server.py / config.py / translator.py / state_manager.py
│   ├── cloud.py                      # 账号 + 云端同步（Supabase）
│   └── templates/index.html
├── static/                           # 前端（桌面和安卓共用，也是书库 books/ 所在）
│   ├── app.js  style.css
│   └── mobile.css  mobile.js         # 仅安卓生效
├── docs/                             # cloud-sync.md（接入步骤）、supabase_schema.sql
├── tests/                            # test_sync_local.py（假 Supabase 跑双设备同步）
├── python_shims/                     # 安卓启动入口 + openai 兼容层
├── config.example.ini                # 配置模板
└── README.md                         # 对外说明（保持简洁）
```

注意：`source/static/` 是桌面版旧副本，**已废弃**（源码模式现在也读根目录 `static/`）。改前端只改根目录 `static/`，一处生效、桌面和安卓都吃到。

关于 `_ensure_static_in_base()`：只在 exe（frozen）模式下运行，作用是拿打包内的 css/js 覆盖 exe 旁的 `static\`。
2026-11-06 起源码模式也直接读 `D:\EPUBReader\static\`，所以**改完样式刷新页面就能看到，不用再同步 `source/static/`**。
如果哪天用新 exe 覆盖了样式、想保住手工改动，把目标文件设只读即可（覆盖会抛 `PermissionError` 被忽略）。

## 3. 架构一句话

- **桌面**：Python Flask + pywebview，书/进度/划线存在电脑本地
- **安卓**：Chaquopy 17.2 把 Python 3.10 运行时和 `source/*.py` 打进 APK，App 启动在手机本地起 Flask，WebView 打开 `127.0.0.1`；数据存在手机私有目录，**与桌面版不互通**
- 两边共用同一套前端，`/?android=1` → 服务端给 `<html class="is-android">` → 加载 `mobile.css` / `mobile.js`

## 4. 构建与发布

推送到 `main` 且改动命中 `android/**` `source/**` `static/**` `python_shims/**` 或 workflow 本身 → GitHub Actions 自动构建（约 1~2 分钟）→ 覆盖 `android-latest` Release。

- 也能手动触发：Actions → Build Android APK → Run workflow
- `versionCode` / `versionName` 取 `GITHUB_RUN_NUMBER`，每次自动递增
- 固定下载地址：`https://github.com/zihangchu301-source/Yidu/releases/download/android-latest/yidu-1.0-debug.apk`
- **每版唯一地址**（应用内更新用）：`.../yidu-1.0.<构建号>.apk`，CI 只保留最近 3 版
- Release 页面（手动下载选这里）：https://github.com/zihangchu301-source/Yidu/releases/tag/android-latest

## 5. 签名与 Secrets

固定签名保证可直接覆盖安装、不丢数据。GitHub 仓库 Secrets：

```
YIDU_KEYSTORE_BASE64 / YIDU_KEYSTORE_PASSWORD / YIDU_KEY_ALIAS / YIDU_KEY_PASSWORD
```

本地备份：`signing/yidu-release.jks` + `signing/keystore.pass`（**不要提交、不要外传**）。
APK 同时开启 v1 + v2 签名，否则部分国产手机报「安装包没有签名文件」。

## 6. 应用内检查更新链路

1. Gradle 配置阶段生成 `assets/version.json`（`built_at` / `version_name` / `version_code` / `apk` 唯一链接）
2. 同一份文件既打进 APK，也由 CI **最后**上传到 Release
3. Java 启动时把 assets 的 version.json 复制到 `filesDir`，**再用 PackageManager 读到的真实 versionCode/versionName 覆盖写入**（1.0.28 起）——这是权威值，避免本地版本变成 0 导致"永远提示有新版本 → 反复下载同一个包 → 安装器说已安装相同版本"
4. Java 启动时复制 assets 失败**不删**旧 version.json（删了就等于本地 0 版）
5. 后端 `GET /api/app/update` 比对版本号；本地版本信息缺失时直接返回 `has_update=false`，不误报
6. 前端弹窗 → `window.YiduNative.downloadUpdate(url, version)` → DownloadManager → 系统安装器
7. 安装器拉起后 60 秒 `DownloadManager.remove(id)` 删安装包，并清理历史遗留的 `yidu-update-*.apk`
8. 防缓存：唯一文件名 + `?v=` 参数 + 本地文件按版本命名

CI 有发布自检（三个 asset 必须齐全）和并发排队，别随意删。

## 7. 安卓适配层（改动前必读）

| 文件 | 作用 |
|---|---|
| `static/mobile.css` | 所有规则以 `html.is-android` 开头，桌面零影响 |
| `static/mobile.js` | 触摸交互、底栏显隐、长按删除、检查更新、主题同步 |
| `app.js` 顶部 `IS_ANDROID` | 关掉桌面鼠标专属逻辑（hover / 拖动 / 顶栏自动收起） |
| `MainActivity.java` | 全屏铺满、状态栏隐藏、文件选择、下载安装、主题底色 |

当前交互约定：

- **书架**：底部 5 个入口常驻；长按书封面 600ms 删除（垃圾桶图标已隐藏）
- **阅读页**：默认只有正文、无任何 UI，点一下正文浮出底部工具栏，再点收起
- 顶部系统状态栏隐藏，页面自己画满整屏；窗口/WebView/网页三层底色跟随深/浅主题
- 安卓不显示书名、左下角浮层返回、TTS 朗读

之前踩过的坑（**别改回去**）：`python.srcDirs` 相对路径按模块目录解析、Chaquopy 任务需显式 `dependsOn`、代码包叫 `app.imy` 不是 `app.zip`、固定链接会被 CDN 缓存成旧包。
**顶部黑条 + 沉浸式（1.0.26 → 1.0.29，别再改回深色主题）**：
- 黑条第一层原因是主题 `Theme.Material.NoActionBar`（深色）—— 隐藏状态栏后那块区域由窗口背景填充，白色页面就露纯黑条。1.0.26 已换成浅色 `AppTheme`。
- **第二层原因（1.0.29 才修掉，决定性）**：没有设 `layoutInDisplayCutoutMode`。有挖孔的屏幕在默认 DEFAULT 模式下，系统把「状态栏 + 挖孔安全区」整条留黑。微信读书只有一个摄像头黑点，就是因为它设了 `SHORT_EDGES`。
- 现在的完整实现见 `MainActivity.hideSystemBars()`：`setDecorFitsSystemWindows(false)` + `WindowInsetsController.hide(statusBars())` + `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES`（API 28+）+ legacy 标志 `LAYOUT_FULLSCREEN|FULLSCREEN|IMMERSIVE_STICKY`，并在 `onPageFinished` / 600ms / `onWindowFocusChanged` 里重设。
- WebView 外包一层同色 `FrameLayout`，两者都 `setFitsSystemWindows(false)`，保证任何缝隙只露页面色。
- **不要**把主题改回 `Theme.Material`，也**不要**删掉 cutout 设置 —— 这两个任一缺失，黑条就回来。

## 8. 当前状态与待办

**已完成**：1.0.29 发布（挖孔屏黑带根治：`layoutInDisplayCutoutMode=SHORT_EDGES`；更新流程改为只点一次 + 同版本不再拉起安装器），1.0.28 同色容器/安装包清理/版本号以系统为准，1.0.27 沉浸式，1.0.26 主题换浅色 + 黑条第一层根因。

**待确认**：1.0.29 装好后顶部是否只剩挖孔那一个小黑点（和微信读书一致），并确认「检查更新」显示当前版本 1.0.29。

**待办**：

1. `D:\EPUBReader\config.ini` 里 DeepSeek API Key 明文存储 → 需轮换密钥并改用环境变量/系统凭据
2. ~~手机与电脑数据不互通~~ → **已做**：Supabase 账号 + 云端同步，见第 9 节与 `docs/cloud-sync.md`（等用户建好云端项目后真机验证）
3. 安卓版 TTS 朗读不可用（依赖 Windows .NET 语音）
4. 若 1.0.29 仍有黑带：检查系统「隐藏屏幕刘海/挖孔」是否开启；再不行回退 1.0.26 方案（保留状态栏 + 染色，用户已确认无黑框）
5. 前端还有一批未提交的样式改动已被 1.0.29 打包（划线底色改柔和米黄 `--highlight`、对照译文左侧竖线 `--quote-line`），如需回退单独处理

## 9. 云端账号与同步（2026-11-06 新增）

目标：一个账号，手机和电脑的书库 / 进度 / 笔记 / 查词自动对齐。完整操作步骤见 `docs/cloud-sync.md`，建表 SQL 见 `docs/supabase_schema.sql`。

| 文件 | 作用 |
|---|---|
| `source/cloud.py` | Supabase Auth + Data API 客户端（纯 `urllib`）、会话持久化、`SyncEngine` |
| `source/config.py` | `[cloud]` 段（`supabase_url` / `supabase_anon_key` / `sync_enabled`）；`ensure_cloud_section()` 给老配置自动补段；`save_cloud_settings()` 界面回写 |
| `source/state_manager.py` | 新增 `reading_progress` / `app_kv` / `sync_meta` / `sync_tombstone` 四张表；`annotations.uid`；`sync_source()` / `apply_remote()` / `_upsert()` |
| `source/server.py` | `/api/cloud/{status,config,login,register,logout,sync}`、`/api/books/<h>/progress`、`/api/progress`、`/api/prefs` |
| `static/app.js` | 设置面板「账号与同步」；进度落库（防抖 1.5s）；偏好同步 |
| `tests/test_sync_local.py` | 本地假 Supabase，双设备双向同步回归（`python tests/test_sync_local.py`） |

**几条硬约束，改之前先看**：

- **前端不直连 Supabase**。WebView 的 origin 是 `http://127.0.0.1:<端口>`，端口漂移会让 localStorage 全丢；令牌放后端才与 origin 无关。
- **不引入 `supabase-py`**。它依赖 pydantic v2（Rust 扩展），Chaquopy 打不进 APK。`cloud.py` 只用标准库，`build.gradle` 的 pip 列表不用动。
- **不能用 `ON CONFLICT ... DO UPDATE`**。minSdk 24 = Android 7 = SQLite 3.9（3.24 才有 upsert），一律走 `Store._upsert()`。
- **同步水位只和云端时间比**，本地时间是本机时区的裸字符串，混着比会差 8 小时。
- **`config.ini` 的 `[cloud]` 只能用 anon key**，`service_role` 绝不能进客户端。
- 主题**故意不同步**（存 config.ini，设备各管各的）；翻译缓存与阅读时长也不同步，原因写在 `docs/cloud-sync.md`。

## 10. 常用命令

```bash
cd /d/EPUBReader
git status && git log --oneline -3
git add -A && git commit -m "..." && git push origin main   # 自动触发打包

# 查最新版本
curl -sL https://github.com/zihangchu301-source/Yidu/releases/download/android-latest/version.json

# 看构建结果
# https://github.com/zihangchu301-source/Yidu/actions

# 验 APK 内容
unzip -l yidu.apk | grep -E "META-INF/CERT|assets/version.json|mobile.css|mobile.js"
unzip -p yidu.apk assets/version.json
```

本机代理不稳定，`git push` 报 `CONNECT tunnel failed 502` 时切换代理节点重试即可。

## 11. 给接力的 AI

- 先读 `.workbuddy/memory/` 里最近的日志，再动手
- `.workbuddy/` 是项目数据，**不要删**
- **源码统一在 `D:\EPUBReader`**（完整 git 仓库），桌面版和手机版是同一套代码，改完 `git push` 即自动发布；E 盘 `Yidu-repo` 是原位置备份，别两边同时改
- 改完跑一下 `启动阅读器.bat` 自测，再 `git push`
- 工作区另有 `Yidu_desktop`（桌面版副本）、`Yidu_phone`（无 .git 的源码快照）、`signing`（密钥），都不要在里面改手机版代码
- 改安卓前端只动 `static/` 下文件和 `app.js` 的 `IS_ANDROID` 分支；桌面行为不能回归
- 改完推 `main`，等 Actions 成功，把**带版本号的唯一链接**给用户；不要给会被缓存的固定链接
- 用户偏好：直接给方案、先说风险与改动范围、文档简洁、参考图只作参考不照搬、不臆测系统原因
- 产出文件不要放 C 盘（用户明确要求 D/E 盘）
