# 译读 · EPUB 英文阅读器

一款桌面端 EPUB 英文阅读器：AI 全文翻译、划线笔记、查词记录、TTS 朗读，界面基于网页技术，双击即用。

![Python](https://img.shields.io/badge/Python-3.10+-blue) ![License](https://img.shields.io/badge/License-MIT-green)

## 功能特性

- 📖 **EPUB 解析阅读**：书库管理、封面展示、阅读进度自动保存
- 🌐 **AI 翻译**：整书逐段翻译（DeepSeek / Kimi / 通义 / OpenAI 等任意 OpenAI 兼容 API），支持术语表提取与上下文摘要，翻译更连贯
- ✏️ **划线与笔记**：选中即划线，记录查词历史
- 🔊 **TTS 朗读**：内置语音合成
- 🎨 **主题定制**：深色/浅色主题、字号调节、字体设置
- 🖥️ **双形态运行**：可直接运行打包好的 `EPUBReader.exe`（pywebview 桌面壳），也可用浏览器访问 Flask 服务

## 目录结构

```
EPUBReader/
├── EPUBReader.exe        # 打包好的主程序（双击启动）
├── config.example.ini    # 配置模板（复制为 config.ini 使用）
├── icon.ico
├── static/               # 界面文件（app.js / style.css）
└── source/               # 全部源码
    ├── app.py            # 桌面壳（pywebview）
    ├── server.py         # Flask 后端
    ├── epub_processor.py # EPUB 解析
    ├── translator.py     # AI 翻译引擎
    ├── tts_engine.py     # TTS 朗读
    ├── state_manager.py  # 状态/数据管理
    ├── templates/        # 页面模板
    └── requirements.txt  # 依赖清单
```

## 从源码运行

```bash
cd source
pip install -r requirements.txt

# 回到上级目录，复制配置模板并填入你的 API Key
cp ../config.example.ini ../config.ini   # 编辑 config.ini 填入 api_key
```

**启动桌面 App**：`python app.py`
**仅浏览器模式**：`python server.py`，然后访问 `http://127.0.0.1:5000`

## 配置说明

程序读取同目录下的 `config.ini`（不要上传/泄露该文件）。核心项：

| 配置项 | 说明 |
|---|---|
| `api_key` | 大模型服务商的 API Key |
| `base_url` | API 地址，需以 `/v1` 结尾 |
| `model` | 模型名，如 `deepseek-chat` |
| `max_workers` | 翻译并发数（建议 2~8） |
| `port` | 本地服务端口，默认 5000 |

## 重新打包 exe

```bash
cd source
pyinstaller --noconfirm --clean EPUBReader.spec
```

## 说明

- `config.ini`、`state/`（阅读记录数据库）、`static/books/`（书籍解析缓存）均不入库，仅存在于本地。
- 使用本项目产生的 API 调用费用由使用者自行承担。

## License

MIT
