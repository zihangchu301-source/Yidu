# 译读 · 项目交接文档

> 最后更新：2026-11-05 · 安卓最新版 **1.0.25**（version_code 25）

## 1. 源码在哪

| 用途 | 路径 |
|---|---|
| **主仓库（本地，唯一带 git / 能触发 CI）** | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu-repo` |
| **远程仓库** | https://github.com/zihangchu301-source/Yidu |
| 桌面版**实际运行目录**（含数据、exe） | `D:\EPUBReader` |
| 桌面版上传快照（纯净源码，无数据） | `D:\EPUBReader_Upload` |
| 桌面版工作副本（2026-11-05 迁移） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_desktop` |
| 手机版源码快照（2026-11-05 迁移，无 .git） | `E:\workbuddyClaw\2026-11-03-18-15-07\Yidu_phone` |
| 安卓签名密钥备份（**勿外泄**） | `E:\workbuddyClaw\2026-11-03-18-15-07\signing\` |
| 本次会话工作日志 | `E:\workbuddyClaw\2026-11-03-18-15-07\.workbuddy\memory\2026-11-05.md` |

主仓库是**唯一构建来源**：只有改 `Yidu-repo` 并 `git push` 才会触发自动打包。
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
3. Java 启动时复制到 `filesDir`；后端 `GET /api/app/update` 比对版本号
4. 前端弹窗 → `window.YiduNative.downloadUpdate(url, version)` → DownloadManager → 系统安装器
5. 防缓存：唯一文件名 + `?v=` 参数 + 本地文件按版本命名

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

## 8. 当前状态与待办

**已完成**：1.0.25 发布，v1+v2 签名、固定密钥、应用内更新链路加固（11 项）、书架/阅读页布局、底栏放大与美化。

**待确认**：用户手机里「当前版本」是否 1.0.25；顶部黑条与内容下方白色空块在 1.0.25 是否消失。此前多次出现下载到缓存旧包，排查任何界面问题前**先让用户点「检查更新」确认版本号**。

**待办**：

1. `D:\EPUBReader\config.ini` 里 DeepSeek API Key 明文存储 → 需轮换密钥并改用环境变量/系统凭据
2. 手机与电脑数据不互通 → 需账号 + 云端数据库，或做导出/导入
3. 安卓版 TTS 朗读不可用（依赖 Windows .NET 语音）
4. 若 1.0.25 仍有黑条，按用户新截图从 WebView 绘制层继续定位，不要归因于系统刘海

## 9. 常用命令

```bash
cd /e/workbuddyClaw/2026-11-03-18-15-07/Yidu-repo
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
- 工作区有 4 个并列目录：`Yidu-repo`（唯一 git 仓库）、`Yidu_desktop`（桌面版副本）、`Yidu_phone`（源码快照）、`signing`（密钥）。**只在 `Yidu-repo` 里改代码和提交**
- 改安卓前端只动 `static/` 下文件和 `app.js` 的 `IS_ANDROID` 分支；桌面行为不能回归
- 改完推 `main`，等 Actions 成功，把**带版本号的唯一链接**给用户；不要给会被缓存的固定链接
- 用户偏好：直接给方案、先说风险与改动范围、文档简洁、参考图只作参考不照搬、不臆测系统原因
- 产出文件不要放 C 盘（用户明确要求 D/E 盘）
