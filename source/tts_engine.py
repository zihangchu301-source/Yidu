# -*- coding: utf-8 -*-
"""
tts_engine.py —— 英语朗读引擎（把一句英文变成 WAV 音频）
=========================================================
为什么不用浏览器自带的朗读（Web Speech API）：
    桌面版用的是 WebView2 窗口，它只能拿到中文声音（惠惠 / 康康 / 瑶瑶），
    没有英文声音；直接读英文会变成“中文腔”，或者干脆没声音。
    而 Windows 系统本身装了英文声音（常见的是 Microsoft Zira），
    所以改成后台用系统语音合成 WAV，再由前端用 <audio> 播放：
      - 不联网、不花钱；
      - 声音是地道的英文；
      - 前端可以暂停 / 继续 / 调语速，也能边读边高亮对应的段落。

用到的技术：pythonnet 调用 .NET 的 System.Speech（Windows 自带）。
    打包成 exe 后同样可用（pythonnet 本来就被 pywebview 依赖）。

对外只有一个函数：synthesize_english(text, rate) -> WAV 字节
"""

from __future__ import annotations

import glob
import os
import threading

# System.Speech 不是线程安全的：Flask 是多线程的，这里串行合成，避免偶发爆音 / 报错。
# 一句通常几十毫秒，排队几乎感觉不到。
_TTS_LOCK = threading.Lock()

# 优先选的英文声音（有这些就用，都是比较自然的美音 / 英音）
_PREFERRED_VOICES = ("zira", "aria", "jenny", "guy", "david", "mark", "samantha")

# 加载过的 .NET 类（只加载一次）
_CLASSES = None


def _find_speech_dll() -> str | None:
    """
    找到 Windows 自带的 System.Speech.dll。

    为什么不能直接 AddReference("System.Speech")：
        pythonnet 按名字加载时找不到 GAC 里的这个程序集（实测会报“找不到文件”），
        但按完整路径加载就正常。所以这里在系统的 GAC 目录里找一下。
    """
    win_dir = os.environ.get("WINDIR") or r"C:\Windows"
    roots = [
        os.path.join(win_dir, "Microsoft.NET", "assembly", "GAC_MSIL", "System.Speech"),
        os.path.join(win_dir, "assembly", "GAC_MSIL", "System.Speech"),
        os.path.join(win_dir, "Microsoft.NET", "assembly", "GAC_32", "System.Speech"),
        os.path.join(win_dir, "Microsoft.NET", "assembly", "GAC_64", "System.Speech"),
    ]
    for root in roots:
        for path in glob.glob(os.path.join(root, "*", "System.Speech.dll")):
            return path
    return None


def _load_speech_classes():
    """加载 .NET 的 System.Speech（只加载一次，之后走缓存）。"""
    global _CLASSES
    if _CLASSES is not None:
        return _CLASSES

    import clr

    dll = _find_speech_dll()
    if dll:
        clr.AddReference(dll)
    else:
        clr.AddReference("System.Speech")
    from System.IO import MemoryStream
    from System.Speech.Synthesis import SpeechSynthesizer

    _CLASSES = (SpeechSynthesizer, MemoryStream)
    return _CLASSES


def _pick_english_voice(synth) -> str | None:
    """在系统装好的声音里挑一个英文的（优先 Zira 这类常用声音）。"""
    fallback = None
    for voice in synth.GetInstalledVoices():
        if not voice.Enabled:
            continue
        info = voice.VoiceInfo
        culture = (info.Culture.Name or "").lower()
        if not culture.startswith("en"):
            continue
        name = info.Name or ""
        if fallback is None:
            fallback = name
        if any(key in name.lower() for key in _PREFERRED_VOICES):
            return name
    return fallback


def synthesize_english(text: str, rate: float = 1.0) -> bytes:
    """
    把一段英文合成 WAV 音频。

    :param text: 英文句子（前端已经切成短句，一般不超过 260 个字符）
    :param rate: 语速倍数，1.0 = 正常；支持 0.5 ~ 2.0
    :return: WAV 文件的二进制内容
    :raises RuntimeError: 电脑没有英文声音 / 合成失败（消息可直接给用户看）
    """
    text = (text or "").strip()
    if not text:
        raise RuntimeError("没有要朗读的文字。")

    try:
        rate = float(rate)
    except (TypeError, ValueError):
        rate = 1.0
    rate = max(0.5, min(rate, 2.0))

    with _TTS_LOCK:
        SpeechSynthesizer, MemoryStream = _load_speech_classes()
        synth = SpeechSynthesizer()
        stream = None
        try:
            voice_name = _pick_english_voice(synth)
            if not voice_name:
                raise RuntimeError(
                    "电脑里没有英文朗读声音。请在 Windows 设置 → 时间和语言 → 语言 里添加英语。"
                )
            synth.SelectVoice(voice_name)

            # System.Speech 的 Rate 是 -10 ~ 10 的整数档位（0 = 正常速度）
            synth.Rate = max(-10, min(10, int(round((rate - 1.0) * 6))))

            stream = MemoryStream()
            synth.SetOutputToWaveStream(stream)
            synth.Speak(text)
            return bytes(stream.ToArray())
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"朗读声音生成失败：{exc}") from exc
        finally:
            try:
                if stream is not None:
                    stream.Dispose()
            except Exception:
                pass
            try:
                synth.Dispose()
            except Exception:
                pass
