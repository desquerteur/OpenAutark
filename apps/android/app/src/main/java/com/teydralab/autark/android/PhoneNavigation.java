// Owns: same-origin browsing, external links, the web profile menu's "Forget this phone" (it opens autark-app:forget,
// which the app takes over) and the app's "can't reach" screen when the PC's UI does not load. Never: bypasses TLS errors.
package com.teydralab.autark.android;

import android.net.http.SslError;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

final class PhoneNavigation extends WebViewClient {
    static final String FORGET = "autark-app:forget";
    private final MainActivity activity;

    PhoneNavigation(MainActivity activity) { this.activity = activity; }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (!request.isForMainFrame()) return false;
        String url = request.getUrl().toString();
        if (FORGET.equals(url)) { activity.confirmForget(); return true; }
        if (activity.sameOrigin(url)) return false;
        activity.openExternal(request.getUrl());
        return true;
    }

    @Override public void onPageFinished(WebView view, String url) {
        if (!activity.sameOrigin(url)) return;
        android.webkit.CookieManager.getInstance().flush();
        activity.pageReady();
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (!request.isForMainFrame() || !activity.sameOrigin(request.getUrl().toString())) return;
        activity.offline("Autark must be running on one of your PCs, and this phone needs internet.");
    }

    @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
        if (!request.isForMainFrame() || !activity.sameOrigin(request.getUrl().toString())) return;
        activity.offline(response.getStatusCode() == 503 ? "None of your PCs is reachable right now. Autark must be running on one of them." : "The PC answered HTTP " + response.getStatusCode() + ".");
    }

    @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
        activity.offline("A certificate is not valid. The page was not loaded.");
    }
}
