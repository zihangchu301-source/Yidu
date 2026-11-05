# 译读 · EPUB 英文阅读器

AI 全文翻译、划线笔记、查词记录、朗读，支持 Windows 桌面端与安卓手机端。

## 下载

| 平台 | 地址 |
|---|---|
| Windows | [EPUBReader.exe（Releases）](https://github.com/zihangchu301-source/Yidu/releases/tag/v1.0) |
| 安卓 | [yidu-1.0-debug.apk（手机直接打开安装）](https://github.com/zihangchu301-source/Yidu/releases/download/android-latest/yidu-1.0-debug.apk) |

安卓版把 Python 运行时和代码一起打进 APK，书、进度、划线都存在手机本地，断网可读；AI 翻译需联网。首次打开到「设置」里填 API Key。

## 从源码运行

```bash
cd source
pip install -r requirements.txt
cp ../config.example.ini ../config.ini   # 填入 api_key
python app.py                            # 或 python server.py 用浏览器打开
```

配置文件 `config.ini` 支持任意 OpenAI 兼容 API（DeepSeek / Kimi / 通义 / OpenAI）。该文件含密钥，不要上传。

## 说明

- 改代码后推到 main，GitHub Actions 会自动重新打包并更新上面的安卓下载链接。
- 手机端书架底栏常驻；阅读页默认只有正文，点一下屏幕才浮出工具栏。
- App 内「检查更新」可直接覆盖安装，数据不丢。
- `config.ini`、阅读记录、书籍缓存不入库；API 调用费用由使用者承担。
- 安卓版暂不支持朗读（依赖 Windows 语音），APK 为自签名调试版，仅供自用。

MIT
