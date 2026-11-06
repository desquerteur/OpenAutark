// Owns: document selection and per-origin foreground media consent. Never: grants arbitrary web resources.
package com.teydralab.autark.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.function.Supplier;

final class PhoneChrome extends WebChromeClient {
    private static final int FILE_REQUEST = 41;
    private static final int MEDIA_REQUEST = 42;
    private final Activity activity;
    private final Supplier<String> origin;
    private final WebView web;
    private PermissionRequest media;
    private String[] resources = new String[0];
    private ValueCallback<Uri[]> files;

    PhoneChrome(Activity activity, WebView web, Supplier<String> origin) {
        this.activity = activity;
        this.web = web;
        this.origin = origin;
    }

    @Override public void onPermissionRequest(PermissionRequest request) {
        if (!trusted(request)) { request.deny(); return; }
        if (media != null) media.deny();
        ArrayList<String> accepted = new ArrayList<>();
        ArrayList<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO
                    : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : null;
            if (permission == null) continue;
            accepted.add(resource);
            if (activity.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
        }
        if (accepted.isEmpty()) { request.deny(); return; }
        media = request;
        resources = accepted.toArray(new String[0]);
        if (missing.isEmpty()) grantMedia();
        else activity.requestPermissions(missing.toArray(new String[0]), MEDIA_REQUEST);
    }

    private boolean trusted(PermissionRequest request) {
        return origin.get() != null && web.getUrl() != null &&
                ConnectionAddress.sameOrigin(origin.get(), request.getOrigin().toString()) &&
                ConnectionAddress.sameOrigin(origin.get(), web.getUrl()) && !activity.isFinishing();
    }

    private void grantMedia() {
        PermissionRequest request = media;
        media = null;
        if (request == null) return;
        boolean granted = trusted(request);
        for (String resource : resources) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO : Manifest.permission.CAMERA;
            granted &= activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        }
        if (granted) request.grant(resources); else request.deny();
        resources = new String[0];
    }

    @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        if (media == request) { media = null; resources = new String[0]; }
    }

    void permissionResult(int requestCode) { if (requestCode == MEDIA_REQUEST) grantMedia(); }

    @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (origin.get() == null || !ConnectionAddress.sameOrigin(origin.get(), view.getUrl())) return false;
        cancelFiles();
        files = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        ArrayList<String> types = new ArrayList<>();
        for (String type : params.getAcceptTypes()) if (type.contains("/")) types.add(type);
        if (types.size() == 1) intent.setType(types.get(0));
        else if (!types.isEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
        try { activity.startActivityForResult(intent, FILE_REQUEST); }
        catch (android.content.ActivityNotFoundException error) {
            cancelFiles();
            Toast.makeText(activity, "No file picker is installed.", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    void activityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_REQUEST || files == null) return;
        Uri[] parsed = FileChooserParams.parseResult(resultCode, data);
        ArrayList<Uri> readable = new ArrayList<>();
        if (parsed != null) for (Uri uri : parsed) {
            if (uri != null && "content".equals(uri.getScheme())) readable.add(uri);
        }
        ValueCallback<Uri[]> callback = files;
        files = null;
        callback.onReceiveValue(readable.isEmpty() ? null : readable.toArray(new Uri[0]));
    }

    private void cancelFiles() {
        if (files != null) { files.onReceiveValue(null); files = null; }
    }

    void cancelMedia() {
        if (media != null) { media.deny(); media = null; }
        resources = new String[0];
    }

    void dispose() { cancelMedia(); cancelFiles(); }
}
