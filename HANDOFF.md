# 译读 · 项目交接文档

> 最后更新：2026-11-05 · 安卓最新版 **1.0.28**（version_code 28）

## 1. 源码在哪

| 用途 | 路径 |
|---|---|
| **手机版主开发目录（推荐，含完整 .git）** | `D:\yidu` |
| **远程仓库** | https://github.com/zihangchu301-source/Yidu |
| 主仓库原始副本（同样含 .git） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu-repo` |
| 桌面版**实际运行目录**（含数据、exe） | `D:\EPUBReader` |
| 桌面版工作副本（2026-11-05 迁移） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_desktop` |
| 手机版源码快照（无 .git，别改） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_phone` |
| 安卓签名密钥备份（**勿外泄**） | `E:\workbuddyClaw\2026-11-03-18-15-07\signing\` |
| 本次会话工作日志 | `E:\workbuddyClaw\2026-11-03-18-15-07\.workbuddy\memory\2026-11-05.md` |

`D:\yidu` 和 `E:\...\Yidu-repo` 都是**完整 git 仓库**、内容一致、指向同一远程。**以后只在 `D:\yidu` 改代码并 `git push`**；E 盘那份是原位置备份，别两边同时改以免冲突。只有 git push 才会触发自动打包。
`Yidu_phone` 是纯源码快照（**不含 .git**），仅供查看/交接，改它不会发布。
`Yidu_desktop` 是 `D:\EPUBReader` 的完整副本（含 `config.ini` 明文密钥、`state/reader.db` 阅读记录、`static/books` 书籍缓存），**不要提交到任何仓库**。原 `D:\EPUBReader` 保留未动。
桌面版目录是另一份可直接运行的副本，改它不会更新 APK。

## 2. 仓库结构

```
Yidu-repo/
├── .github/workflows/build-apk.yml   # CI：推 main 自动打包并发布
├── android/                          # Chaquopy + WebView 壳
│   ├── app/build.gradle              # 版本、签名、资源同步、version.json 生成
│   └── app/src/main/java/.../MainActivity.java
├── source/                           # Python 后端（Flask）
│   ├── server.py / config.py / translator.py / state_manager.py
│   └── templates/index.html
├── static/                           # 前端（安卓构建读这里）
│   ├── app.js  style.css             # 桌面/安卓共用
│   └── mobile.css  mobile.js         # 仅安卓生效
├── python_shims/                     # 安卓启动入口 + openai 兼容层
├── config.example.ini                # 配置模板
└── README.md                         # 对外说明（保持简洁）
```

注意：`source/static/` 是桌面版旧副本，**安卓构建不读它**。改前端改根目录 `static/`。

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
**顶部黑条 + 沉浸式（1.0.26 → 1.0.27，别再改回深色主题）**：黑条的真正原因是主题 `Theme.Material.NoActionBar`（深色）—— 隐藏状态栏后那块区域由窗口背景填充，白色页面上就露出纯黑条。1.0.26 先改成"保留状态栏 + 染色"，1.0.27 又改回沉浸式（隐藏状态栏、内容铺满），**前提是主题已换成浅色 `AppTheme` 且三层底色兜底**。实现见 `MainActivity.hideSystemBars()`（API 30+ 用 `setDecorFitsSystemWindows(false)` + `WindowInsetsController.hide(statusBars())`，旧系统 `LAYOUT_FULLSCREEN|FULLSCREEN`，并在 `onWindowFocusChanged` 里重设）。**不要**把主题改回 `Theme.Material` 再套 FLAG_FULLSCREEN —— 那正是黑条的成因。

## 8. 当前状态与待办

**已完成**：1.0.28 发布（沉浸式第三次加固：同色容器 + 新旧两套全屏标志 + 布局后重收；安装包自动清理；版本号以 PackageManager 为准），1.0.27 沉浸式，1.0.26 状态栏染色 + 黑条根因定位（主题深色）。

**待确认**：1.0.28 装上后顶部是否既无状态栏、也无黑条（务必先点「检查更新」确认当前版本 ≥ 1.0.28）。

**待办**：

1. `D:\EPUBReader\config.ini` 里 DeepSeek API Key 明文存储 → 需轮换密钥并改用环境变量/系统凭据
2. 手机与电脑数据不互通 → 需账号 + 云端数据库，或做导出/导入
3. 安卓版 TTS 朗读不可用（依赖 Windows .NET 语音）
4. **保底方案**：若 1.0.28 的沉浸式在用户机型上仍然露黑条，回退到 1.0.26 的方案（保留状态栏 + 染色，用户已确认无黑框），代价是顶部有一条同色状态栏。二选一，不要再反复试「又藏状态栏又想无黑条」的第三条路。
5. 若顶部内容被挖孔/刘海遮挡：`hideSystemBars()` 里加 `layoutInDisplayCutoutMode=SHORT_EDGES`，并把 `getDisplayCutout().getSafeInsetTop()` 通过 JS 接口传给前端做 `padding-top`

## 9. 常用命令

```bash
cd /d/yidu
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

## 10. 给接力的 AI

- 先读 `.workbuddy/memory/` 里最近的日志，再动手
- `.workbuddy/` 是项目数据，**不要删**
- **手机版源码统一在 `D:\yidu`**（完整 git 仓库），改完 `git push` 即自动发布；E 盘 `Yidu-repo` 是原位置备份，别两边同时改
- 工作区另有 `Yidu_desktop`（桌面版副本）、`Yidu_phone`（无 .git 的源码快照）、`signing`（密钥），都不要在里面改手机版代码
- 改安卓前端只动 `static/` 下文件和 `app.js` 的 `IS_ANDROID` 分支；桌面行为不能回归
- 改完推 `main`，等 Actions 成功，把**带版本号的唯一链接**给用户；不要给会被缓存的固定链接
- 用户偏好：直接给方案、先说风险与改动范围、文档简洁、参考图只作参考不照搬、不臆测系统原因
- 产出文件不要放 C 盘（用户明确要求 D/E 盘）
