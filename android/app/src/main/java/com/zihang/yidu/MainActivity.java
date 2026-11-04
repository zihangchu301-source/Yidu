package com.zihang.yidu;

import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
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
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebViewClient(new android.webkit.WebViewClient());
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
        webView.loadUrl("http://127.0.0.1:" + port + "/");
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
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
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
