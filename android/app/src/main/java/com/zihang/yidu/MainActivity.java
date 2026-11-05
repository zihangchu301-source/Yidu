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

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private int port = 8720;
    private DownloadManager downloadManager;
    private BroadcastReceiver downloadReceiver;
    private long updateDownloadId = -1L;
    private boolean chromeDark = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 顶部黑条根因（1.0.25 仍在，已定位）：
        //   以前用 FLAG_FULLSCREEN 把状态栏隐藏掉，指望网页铺到状态栏区域。
        //   但网页并没有真的铺进去 —— 那块地方交给"窗口背景"填，而主题是
        //   Theme.Material（深色），于是白色页面正上方出现一条纯黑条；
        //   深色页面时同样有，只是和深色底混在一起不明显。
        // 现在的做法改成「保留状态栏、把它染成页面底色」（微信读书就是这么做的）：
        //   状态栏始终由系统绘制，颜色由 applyChromeColor() 指定，
        //   再也没有任何区域会露出系统深色底。
        Window w = getWindow();
        w.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 内容从状态栏下方开始，状态栏区域完全由系统按我们给的颜色画
            w.setDecorFitsSystemWindows(true);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
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
        // 版本文件由 Gradle 构建时生成。新包若缺这个文件，删掉上次的旧文件，
        // 否则"检查更新"会拿着旧版本号一直提示有新版本。
        File versionTarget = new File(home, "version.json");
        try {
            copyAssetFile("version.json", versionTarget);
        } catch (IOException ignored) {
            try { versionTarget.delete(); } catch (Exception ignored2) { }
        }
        resumePendingUpdate();

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

        webView.setWebViewClient(new android.webkit.WebViewClient());
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

        setContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        // ?android=1 让服务端给 <html> 加 is-android，前端启用触摸适配层
        webView.loadUrl("http://127.0.0.1:" + port + "/?android=1");
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
     * 窗口、状态栏、导航栏、WebView 底色统一跟着页面主题走。
     *
     * 关键改动（消灭顶部黑条）：状态栏不再隐藏，而是**直接染成页面底色**。
     * 系统始终自己画状态栏，只是用我们给的颜色，所以不可能再露出深色窗口底；
     * 图标明暗也一起适配，浅色底用深色图标（否则白底上白图标看不见）。
     */
    private void applyChromeColor(boolean dark) {
        chromeDark = dark;
        int color = dark ? 0xFF16181C : 0xFFF7F7F5;
        Window w = getWindow();
        // 1) 窗口 + WebView 底色：内容不满一屏时不会露出深色窗口底（白色空块也是这个原因）
        w.setBackgroundDrawable(new ColorDrawable(color));
        w.getDecorView().setBackgroundColor(color);
        if (webView != null) webView.setBackgroundColor(color);
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
        if (!canInstallUnknown()) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivity(intent);
            } catch (Exception ignored) { }
            Toast.makeText(this, "请允许「安装未知应用」后再点一次下载", Toast.LENGTH_LONG).show();
            return;
        }
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
            // 记下 id：用户下载途中退出 App，下次启动仍会补弹安装
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putLong(KEY_DOWNLOAD_ID, updateDownloadId).apply();
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
    private void resumePendingUpdate() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        long id = prefs.getLong(KEY_DOWNLOAD_ID, -1L);
        if (id < 0) return;
        prefs.edit().remove(KEY_DOWNLOAD_ID).apply();
        if (isDownloadSuccessful(id)) installDownloaded(id);
    }

    private void installDownloaded(long id) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_DOWNLOAD_ID).apply();
        try {
            if (downloadManager == null) {
                downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            }
            // 失败/未完成的下载不要弹出安装器，否则会出现"装了还是旧版"
            if (!isDownloadSuccessful(id)) {
                Toast.makeText(this, "下载未完成，请检查网络后重试", Toast.LENGTH_LONG).show();
                return;
            }
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
        } catch (Exception e) {
            Log.e(TAG, "唤起安装失败", e);
            Toast.makeText(this, "无法打开安装界面，请到「下载」目录手动安装", Toast.LENGTH_LONG).show();
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
