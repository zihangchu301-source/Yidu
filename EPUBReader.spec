# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('templates', 'templates'),
        ('static/app.js', 'static'),
        ('static/style.css', 'static'),
        ('static/brand.png', 'static'),
        ('icon.ico', '.'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 本程序用不到这些“碰巧装在环境里”的大包；不打进去可以把 exe 从 66MB
    # 降到 20 多 MB，启动从十几秒回到 3 秒左右（ebooklib 必须用 lxml，不能排除）。
    excludes=[
        'numpy', 'pandas', 'PIL', 'jedi', 'IPython', 'matplotlib', 'scipy',
        'pyarrow', 'traitlets', 'parso', 'prompt_toolkit', 'pygments', 'tzdata',
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='EPUBReader',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['icon.ico'],
    version='version_info.txt',
)
