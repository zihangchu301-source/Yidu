package com.zihang.yidu;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final String TAG = "Yidu";
    private static final int REQ_FILE = 1001;
    private static final String PREFS = "yidu_update";
    private static final String KEY_DOWNLOAD_ID = "download_id";
    private static final String KEY_PENDING_VERSION = "pending_version";

    private WebView webView;
    /** 包住 WebView 的根容器：颜色跟页面主题一致，任何缝隙都只会露出页面色，不会露黑。 */
    private View rootContainer;
    private ValueCallback<Uri[]> pendingFileCallback;
    private int port = 8720;
    private DownloadManager downloadManager;
    private BroadcastReceiver downloadReceiver;
    private long updateDownloadId = -1L;
    private boolean chromeDark = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 顶部黑条根因（1.0.26 已定位并修掉，别再改回深色主题）：
        //   以前主题是 Theme.Material（深色），用 FLAG_FULLSCREEN 隐藏状态栏后，
        //   那块区域交给"窗口背景"填 → 白色页面正上方出现纯黑条。
        // 现在主题换成浅色（AppTheme）+ 三层底色兜底，可以安全地做沉浸式了：
        //   隐藏状态栏 + 让内容真的铺到屏幕最顶上。即便某台 ROM 没铺满，
        //   露出的也是页面同色，不会再是黑条。
        hideSystemBars();
        chromeDark = readDarkTheme();
        applyChromeColor(chromeDark);

        File home = getFilesDir();
        try {
            copyAssetDir("static", new File(home, "static"));
            copyAssetDir("templates", new File(home, "templates"));
        } catch (IOException e) {
            showFatal("解压界面资源失败", e);
            return;
        }
        // 版本文件由 Gradle 构建时生成。新包若缺这个文件，**不要删旧文件** ——
        // 删了会让后端以为"本地是 0 版"，每次都提示有新版本，用户就会反复下载、
        // 反复被安装器告知"已安装相同版本"（用户反馈的"要装两次"就是这个）。
        File versionTarget = new File(home, "version.json");
        try {
            copyAssetFile("version.json", versionTarget);
        } catch (IOException ignored) {
            // 保留上一次的版本文件
        }
        // 再用系统里真实的已安装版本覆盖一次：这是最权威的"当前版本"，
        // 从老版本升级上来（assets 里没有 version.json）也不会再误报有更新。
        syncInstalledVersion(versionTarget);
        // 先把以前攒下的历史安装包清掉（跳过"下载完还没装"的那一份）。
        // 补装（下载完没装完就退出）统一交给 onResume，那里也负责"刚授权回来"的情况。
        purgeOldUpdateApks();

        try {
            if (!Python.isStarted()) {
                Python.start(new AndroidPlatform(this));
            }
            port = Python.getInstance()
                    .getModule("yidu_android")
                    .callAttr("start", home.getAbsolutePath())
                    .toJava(Integer.class);
        } catch (Exception e) {
            showFatal("Python 启动失败", e);
            return;
        }

        webView = new WebView(this);
        applyChromeColor(chromeDark);   // WebView 自己也刷底色，内容再短也不会露白
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 禁止双击缩放 / 系统字号放大：手机端排版必须稳定，否则按钮会被挤没
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new android.webkit.WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 页面首帧出来后再收一次状态栏：WebView 完成布局时，系统偶尔会把状态栏还回来
                hideSystemBars();
            }
        });
        // 给前端一个原生下载入口：window.YiduNative.downloadUpdate(url, version)
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void downloadUpdate(String url, String version) {
                runOnUiThread(() -> startUpdateDownload(url, version));
            }

            // 前端切换深/浅主题时同步状态栏与窗口底色，避免顶部出现异色条
            @JavascriptInterface
            public void setChromeDark(boolean dark) {
                runOnUiThread(() -> applyChromeColor(dark));
            }
        }, "YiduNative");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                try {
                    Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                    if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    }
                    startActivityForResult(Intent.createChooser(intent, "选择 EPUB 文件"), REQ_FILE);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    Toast.makeText(MainActivity.this, "无法打开文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        // 用一层同色容器把 WebView 包起来，并且**两层都不吃系统 insets**：
        // 这是让网页真正铺到状态栏区域的最后一道保险 ——
        // 就算某台 ROM 没有把 WebView 撑满，露出来的也是容器颜色（页面色），不会是黑条。
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(false);
        root.setBackgroundColor(chromeDark ? 0xFF16181C : 0xFFF7F7F5);
        webView.setFitsSystemWindows(false);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        rootContainer = root;
        setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        // ?android=1 让服务端给 <html> 加 is-android，前端启用触摸适配层
        webView.loadUrl("http://127.0.0.1:" + port + "/?android=1");
        // 等 WebView 完成首次布局再收一次状态栏（有的 ROM 会把刚隐藏的状态栏还回来）
        webView.postDelayed(this::hideSystemBars, 600);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFileCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            pendingFileCallback.onReceiveValue(results);
            pendingFileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        if (downloadReceiver != null) {
            try { unregisterReceiver(downloadReceiver); } catch (Exception ignored) { }
            downloadReceiver = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // 安卓返回键先关弹窗 / 气泡，再退回书架，最后才退出 App
        webView.evaluateJavascript(
                "(function(){try{return window.__yiduBack&&window.__yiduBack()?'1':'0';}catch(e){return '0';}})()",
                value -> {
                    if (value != null && value.contains("1")) return;
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        finish();
                    }
                });
    }

    private void copyAssetDir(String assetPath, File target) throws IOException {
        AssetManager assets = getAssets();
        String[] children;
        try {
            children = assets.list(assetPath);
        } catch (IOException e) {
            children = new String[0];
        }
        if (children == null || children.length == 0) {
            copyAssetFile(assetPath, target);
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) {
            throw new IOException("无法创建目录：" + target);
        }
        for (String child : children) {
            copyAssetDir(assetPath + "/" + child, new File(target, child));
        }
    }

    private void copyAssetFile(String assetPath, File target) throws IOException {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("无法创建目录：" + parent);
        }
        try (InputStream in = getAssets().open(assetPath);
             OutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }

    /**
     * 把系统里真实的已安装版本写进 filesDir/version.json。
     *
     * 为什么需要：后端 /api/app/update 靠这个文件判断"本地是第几版"。
     * 以前这个文件只从 assets 复制，一旦复制失败或被删掉，本地版本就成了 0，
     * 于是每次都提示"有新版本" → 用户反复下载同一个包 → 安装器提示
     * "已安装相同版本，可直接打开或重新安装"（就是要装两次的那个现象）。
     * PackageManager 读到的 versionCode / versionName 才是权威值。
     */
    private void syncInstalledVersion(File target) {
        try {
            String name;
            int code;
            try {
                PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                name = pi.versionName == null ? "1.0" : pi.versionName;
                code = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                        ? (int) pi.getLongVersionCode() : pi.versionCode;
            } catch (Exception ignored) {
                return; // 连包信息都读不到就沿用 assets 里那份
            }
            if (code <= 0) return;
            String json = "{\"version_code\":" + code
                    + ",\"version_name\":\"" + name + "\""
                    + ",\"built_at\":\"" + name + "\"}";
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(json.getBytes("UTF-8"));
            }
        } catch (Exception ignored) {
            // 写不进去（磁盘满 / 只读）就沿用 assets 里的版本文件
        }
    }

    /** 当前已安装的版本号（如 1.0.28）；读不到返回空串。 */
    private String currentVersionName() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /** 启动时读一次配置里的主题，避免网页加载前窗口底色和页面不一致。 */
    private boolean readDarkTheme() {
        try (BufferedReader r = new BufferedReader(
                new FileReader(new File(getFilesDir(), "config.ini")))) {
            String line;
            while ((line = r.readLine()) != null) {
                String s = line.trim().toLowerCase();
                if (s.startsWith("default_theme")) return s.contains("dark");
            }
        } catch (Exception ignored) { }
        return false;
    }

    /**
     * 沉浸式：隐藏状态栏，让网页一直画到屏幕最顶端（只留文章内容）。
     *
     * 为什么不会再出现黑条：主题已经是浅色的 AppTheme，且窗口 / decorView / WebView
     * 三层底色都由 applyChromeColor() 刷成页面同色。状态栏区域要么被网页盖住（正常），
     * 要么露出同样颜色的窗口底（兜底），不可能再是纯黑。
     *
     * 从通知栏下拉、切回前台、弹过键盘之后系统会把状态栏又显示出来，
     * 所以在 onWindowFocusChanged 里再调一次。
     */
    private void hideSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController ctl = w.getDecorView().getWindowInsetsController();
            if (ctl != null) {
                ctl.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ctl.hide(WindowInsets.Type.statusBars());
            }
        }
        // 【关键】允许内容画进挖孔/刘海所在的短边区域。
        //   默认的 DEFAULT 模式下，有挖孔的屏幕即使隐藏了状态栏，系统也会把
        //   「状态栏 + 挖孔安全区」整条留黑（就是用户截图里那条很宽的黑色带），
        //   微信读书之所以只有一个摄像头黑点，就是因为它设了 SHORT_EDGES。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }
        // 部分国产 ROM 不认上面的新接口，只认老的标志位（游戏全屏就是这套）。
        // 两套一起下，谁生效都行；重复设置没有副作用。
        w.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        w.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        // 状态栏隐藏会触发一次重排：把 WebView 重新撑满，避免顶部留出空档
        if (webView != null) {
            webView.requestLayout();
            if (rootContainer != null) rootContainer.requestLayout();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars(); // 从通知栏 / 其他应用回来时，重新进入沉浸式
    }

    /**
     * 窗口、状态栏、导航栏、WebView 底色统一跟着页面主题走。
     *
     * 状态栏虽然被隐藏了，颜色仍然要设：部分 ROM 在切换瞬间会短暂露出状态栏底色，
     * 设成页面同色就不会闪一下黑条。图标明暗也一起适配（浅色底用深色图标）。
     */
    private void applyChromeColor(boolean dark) {
        chromeDark = dark;
        int color = dark ? 0xFF16181C : 0xFFF7F7F5;
        Window w = getWindow();
        // 1) 窗口 + WebView 底色：内容不满一屏时不会露出深色窗口底（白色空块也是这个原因）
        w.setBackgroundDrawable(new ColorDrawable(color));
        w.getDecorView().setBackgroundColor(color);
        if (webView != null) webView.setBackgroundColor(color);
        if (rootContainer != null) rootContainer.setBackgroundColor(color);
        // 2) 状态栏 / 导航栏染成页面底色 —— 这是消掉顶部黑条的关键
        w.setStatusBarColor(color);
        w.setNavigationBarColor(color);
        // 3) 状态栏 / 导航栏图标明暗跟随主题
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController ctl = w.getDecorView().getWindowInsetsController();
            if (ctl != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                ctl.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else {
            int flags = w.getDecorView().getSystemUiVisibility();
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
            }
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    /* ---- 应用内更新：下载 APK 并唤起系统安装器 -------------------------
       用系统 DownloadManager 下到公共 Downloads（无需存储权限），
       下载完成广播里拿 content:// URI 交给安装器。
       签名由 CI 固定，所以可以直接覆盖安装，数据不会丢。 */
    private boolean canInstallUnknown() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getPackageManager().canRequestPackageInstalls();
    }

    private void startUpdateDownload(String url, String version) {
        if (url == null || url.isEmpty()) {
            Toast.makeText(this, "更新地址为空，请稍后重试", Toast.LENGTH_LONG).show();
            return;
        }
        // 注意：这里**不再**检查"安装未知应用"权限。
        // 以前在下载前就拦，用户被拉去设置授权、回来还得再点一次下载 —— 就是"要装两次"的来源。
        // 现在照常下载，等下载完真正要装的时候再要权限，授权回来自动继续（见 onResume）。
        try {
            // 版本号既用于 URL 防缓存，也用于本地文件名，避免复用上次下载的旧包
            String ver = (version == null || version.isEmpty())
                    ? String.valueOf(System.currentTimeMillis())
                    : version.replaceAll("[^A-Za-z0-9._-]", "_");
            final String dlUrl = url.contains("?") ? url : url + "?v=" + ver;
            final String fileName = "yidu-update-" + ver + ".apk";

            downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(dlUrl));
            req.setTitle("译读 " + ver + " 更新");
            req.setDescription("正在下载新版本…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);
            updateDownloadId = downloadManager.enqueue(req);
            // 记下 id + 这一版版本号：用户下载途中退出 App，下次启动仍会补弹安装；
            // 版本号用来在安装前判断"下到的和已装的是不是同一版"（避免装两次）。
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putLong(KEY_DOWNLOAD_ID, updateDownloadId)
                    .putString(KEY_PENDING_VERSION, ver)
                    .apply();
            registerDownloadReceiver();
            Toast.makeText(this, "开始下载 " + ver + "，完成后自动弹出安装", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.e(TAG, "下载更新失败", e);
            Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void registerDownloadReceiver() {
        if (downloadReceiver != null) return;
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id == updateDownloadId) installDownloaded(id);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }
    }

    private boolean isDownloadSuccessful(long id) {
        try {
            if (downloadManager == null) {
                downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            }
            if (downloadManager == null) return false;
            Cursor c = downloadManager.query(new DownloadManager.Query().setFilterById(id));
            if (c == null) return false;
            try {
                return c.moveToFirst()
                        && c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                        == DownloadManager.STATUS_SUCCESSFUL;
            } finally {
                c.close();
            }
        } catch (Exception e) {
            Log.w(TAG, "查询下载状态失败", e);
            return false;
        }
    }

    /** 下载途中退出了 App：下次启动补弹安装界面，不让用户以为更新没生效。 */
    /**
     * 每次回到前台都检查一次：上次下载完却没装成（退出 App / 刚去系统设置
     * 授权了「安装未知应用」），回来就自动接着装，用户不用再点第二次。
     * 记录只在对的地方清（installDownloaded 里），避免同一个包被拉起两次安装器。
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (!canInstallUnknown()) return;
        long id = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_DOWNLOAD_ID, -1L);
        if (id >= 0 && isDownloadSuccessful(id)) installDownloaded(id);
    }

    private void installDownloaded(long id) {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String pending = prefs.getString(KEY_PENDING_VERSION, "");

        // ① 还没给「安装未知应用」权限：拉用户去授权，**保留**记录，
        //    授权返回后 onResume 自动接着装 —— 全程只点一次「下载」。
        if (!canInstallUnknown()) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            } catch (Exception ignored) {
            }
            Toast.makeText(this, "请允许「安装未知应用」，返回后会自动继续安装",
                    Toast.LENGTH_LONG).show();
            return;
        }

        if (downloadManager == null) {
            downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        }
        // ② 下载还没完成（例如刚授权回来）：保留记录，等下载完成广播再装
        if (downloadManager == null || !isDownloadSuccessful(id)) {
            Toast.makeText(this, "下载未完成，请稍后…", Toast.LENGTH_SHORT).show();
            return;
        }

        // ③ 下到的版本和当前已装版本相同：不要再拉起安装器。
        //    否则安装器会弹「已安装相同版本 → 可直接打开 / 重新安装」，
        //    用户只能点「重新安装」才装得进去，体验上就是"每次都要装两次"。
        if (!pending.isEmpty() && pending.equals(currentVersionName())) {
            try {
                downloadManager.remove(id);
            } catch (Exception ignored) {
            }
            prefs.edit().remove(KEY_DOWNLOAD_ID).remove(KEY_PENDING_VERSION).apply();
            Toast.makeText(this, "已是最新版本，无需重复安装", Toast.LENGTH_SHORT).show();
            purgeOldUpdateApks();
            return;
        }

        prefs.edit().remove(KEY_DOWNLOAD_ID).remove(KEY_PENDING_VERSION).apply();
        try {
            Uri uri = downloadManager.getUriForDownloadedFile(id);
            if (uri == null) {
                Toast.makeText(this, "下载文件不可用，请检查网络后重试", Toast.LENGTH_LONG).show();
                return;
            }
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(install);
            } catch (Exception e1) {
                // 部分国产 ROM 只认这个 action
                Intent fallback = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                fallback.setDataAndType(uri, "application/vnd.android.package-archive");
                fallback.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(fallback);
            }
            // 安装器已经拉起：60 秒后删掉安装包，并顺手清理以前攒下的历史更新包
            scheduleCleanupAfterInstall(id);
        } catch (Exception e) {
            Log.e(TAG, "唤起安装失败", e);
            Toast.makeText(this, "无法打开安装界面，请到「下载」目录手动安装", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 安装器拉起后清理安装包。
     *
     * 用户反馈：每装一次就在「下载」里留一个 yidu-update-x.x.x.apk，越攒越多，
     * 一不留神点到旧包，安装器就提示「已安装相同版本」，还以为要装两遍。
     *
     * 这里用 DownloadManager.remove()：不需要存储权限，Android 11+ 也能删掉
     * 由本 App 创建的那条下载（连同文件）。延迟 60 秒是为了留时间给安装器读完。
     */
    private void scheduleCleanupAfterInstall(long id) {
        new android.os.Handler(getMainLooper()).postDelayed(() -> {
            try {
                if (downloadManager == null) {
                    downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                }
                if (downloadManager != null) downloadManager.remove(id);
            } catch (Exception ignored) {
            }
            purgeOldUpdateApks();
        }, 60_000L);
    }

    /** 清掉以前所有已下载完成的「译读」更新包（只动本 App 自己创建的下载记录）。 */
    private void purgeOldUpdateApks() {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return;
            // 待安装的那一份不能删（用户下载完还没点安装 / 刚重启 App 等补弹）
            long pendingId = getSharedPreferences(PREFS, MODE_PRIVATE)
                    .getLong(KEY_DOWNLOAD_ID, -1L);
            Cursor c = dm.query(new DownloadManager.Query());
            if (c == null) return;
            try {
                int idCol = c.getColumnIndex(DownloadManager.COLUMN_ID);
                int titleCol = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
                int uriCol = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
                int statusCol = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                if (idCol < 0) return;
                while (c.moveToNext()) {
                    long id = c.getLong(idCol);
                    if (id == pendingId) continue;
                    String title = titleCol >= 0 ? c.getString(titleCol) : null;
                    String localUri = uriCol >= 0 ? c.getString(uriCol) : null;
                    int status = statusCol >= 0 ? c.getInt(statusCol) : 0;
                    boolean mine = (title != null && title.startsWith("译读"))
                            || (localUri != null && localUri.contains("yidu-update-"));
                    // 只清已完成 / 失败的历史包，正在下载的不动
                    boolean settled = status == DownloadManager.STATUS_SUCCESSFUL
                            || status == DownloadManager.STATUS_FAILED;
                    if (mine && settled) dm.remove(id);
                }
            } finally {
                c.close();
            }
        } catch (Exception ignored) {
        }
    }

    private void showFatal(String title, Exception e) {
        Log.e(TAG, title, e);
        StringBuilder sb = new StringBuilder(title).append("\n\n");
        sb.append(e.toString()).append("\n");
        StackTraceElement[] trace = e.getStackTrace();
        for (int i = 0; i < Math.min(trace.length, 8); i++) {
            sb.append("  at ").append(trace[i].toString()).append("\n");
        }
        TextView tv = new TextView(this);
        tv.setText(sb.toString());
        tv.setTextSize(12f);
        tv.setPadding(32, 96, 32, 32);
        setContentView(tv);
    }
}
