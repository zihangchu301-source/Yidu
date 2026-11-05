package com.zihang.yidu;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.TextView;
import android.widget.Toast;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {

    private static final String TAG = "Yidu";
    private static final int REQ_FILE = 1001;

    private WebView webView;
    private ValueCallback<Uri[]> pendingFileCallback;
    private int port = 8720;
    private DownloadManager downloadManager;
    private BroadcastReceiver downloadReceiver;
    private long updateDownloadId = -1L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        File home = getFilesDir();
        try {
            copyAssetDir("static", new File(home, "static"));
            copyAssetDir("templates", new File(home, "templates"));
        } catch (IOException e) {
            showFatal("解压界面资源失败", e);
            return;
        }
        // 版本文件由 Gradle 构建时生成（缺失时只影响"检查更新"，不阻断启动）
        try {
            copyAssetFile("version.json", new File(home, "version.json"));
        } catch (IOException ignored) {
        }

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
        // 给前端一个原生下载入口：window.YiduNative.downloadUpdate(url)
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void downloadUpdate(String url) {
                runOnUiThread(() -> startUpdateDownload(url));
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

    /* ---- 应用内更新：下载 APK 并唤起系统安装器 -------------------------
       用系统 DownloadManager 下到公共 Downloads（无需存储权限），
       下载完成广播里拿 content:// URI 交给安装器。
       签名由 CI 固定，所以可以直接覆盖安装，数据不会丢。 */
    private boolean canInstallUnknown() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getPackageManager().canRequestPackageInstalls();
    }

    private void startUpdateDownload(String url) {
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
            downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("译读 更新");
            req.setDescription("正在下载新版本…");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "yidu-update.apk");
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);
            updateDownloadId = downloadManager.enqueue(req);
            registerDownloadReceiver();
            Toast.makeText(this, "开始下载更新，完成后自动弹出安装", Toast.LENGTH_SHORT).show();
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

    private void installDownloaded(long id) {
        try {
            Uri uri = downloadManager.getUriForDownloadedFile(id);
            if (uri == null) {
                Toast.makeText(this, "下载未完成，请检查网络", Toast.LENGTH_LONG).show();
                return;
            }
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(install);
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
