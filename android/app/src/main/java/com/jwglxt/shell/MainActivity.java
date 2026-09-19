package com.jwglxt.shell;

import android.os.Bundle;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

/**
 * 教务系统套壳 App 主 Activity。
 *
 * 核心只做一件事：**让系统返回键先走网页历史，最后才退出 App**。
 *
 * 为什么必须自己处理：Capacitor 默认行为是「不能后退就直接退出」，
 * 而正方教务系统大量使用 iframe（左侧菜单点一下，内容区是 iframe 跳转），
 * 主 WebView 的历史长度几乎不变。结果学生在「课表 → 成绩详情」里按返回，
 * App 直接被关掉，只能重新登录。所以这里改成：
 *
 *   1. 主 WebView 能后退        → 后退
 *   2. 内层 iframe 有历史       → 让最内层 iframe 后退
 *   3. 都已到根页面            → 连按两次返回才退出（防误触）
 *
 * 实现说明：使用 AndroidX 的 OnBackPressedCallback（而非旧的 onBackPressed()）。
 * 后者在 API 33+ 已被标记弃用，且在启用了 predictive back 的系统上
 * 可能不再被回调，导致返回键完全失效。OnBackPressedCallback 是官方推荐做法。
 *
 * 异步注意事项：WebView.evaluateJavascript 是异步的，拿不到同步返回值。
 * 因此分两步：先同步判断主历史 → 异步探测 frame。
 * frame 探测回调里若发现确实有历史，那次返回已被「消费」；
 * 若没有历史，才把这次按键计入双击退出计时。这样按键不会被永久吞掉。
 */
public class MainActivity extends BridgeActivity {

    private long lastBackPressAt = 0L;
    private static final long DOUBLE_BACK_INTERVAL_MS = 2000L;

    /** 标记：正在等待 frame 后退的异步结果，避免连按产生竞态 */
    private boolean waitingFrameProbe = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 注册返回键回调（替代已弃用的 onBackPressed 重写）
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                onBackPressedInternal();
            }
        });
    }

    private void onBackPressedInternal() {
        android.webkit.WebView webView =
                getBridge() != null ? getBridge().getWebView() : null;

        if (webView == null) {
            finish();
            return;
        }

        // ---- 1. 主 WebView 能后退，直接后退 ----
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }

        // ---- 2. 探测内层 iframe 是否有历史 ----
        if (!waitingFrameProbe) {
            waitingFrameProbe = true;
            webView.evaluateJavascript(
                    "(function(){" +
                    "  try {" +
                    "    var f = window.frames;" +
                    "    for (var i = f.length - 1; i >= 0; i--) {" +
                    "      try {" +
                    "        if (f[i].history && f[i].history.length > 1) {" +
                    "          f[i].history.back();" +
                    "          return 'ok';" +
                    "        }" +
                    "      } catch (e) { /* 跨域 frame，忽略 */ }" +
                    "    }" +
                    "  } catch (e) {}" +
                    "  return 'none';" +
                    "})()",
                    value -> {
                        waitingFrameProbe = false;
                        // frame 没有历史 → 确实到根页面了，进入双击退出判定
                        if (value == null || !value.contains("ok")) {
                            handleRootBackPress();
                        }
                    }
            );
            return;
        }

        // 上一次探测还没回来（用户按得很快），直接按根页面处理
        handleRootBackPress();
    }

    /** 已到根页面：连按两次返回才真正退出，避免误触把 App 关掉 */
    private void handleRootBackPress() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressAt < DOUBLE_BACK_INTERVAL_MS) {
            finish();
        } else {
            lastBackPressAt = now;
            Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
        }
    }
}
