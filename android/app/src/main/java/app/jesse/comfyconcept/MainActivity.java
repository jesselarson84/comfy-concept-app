package app.jesse.comfyconcept;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.ServiceWorkerController;
import android.webkit.ServiceWorkerWebSettings;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.RenderProcessGoneDetail;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The whole app: a full-screen WebView on the Comfy Concept server, plus the
 * native pieces the web app cannot do by itself (share in, gallery save, share
 * out, keep-awake, file chooser with camera, offline screen).
 */
public class MainActivity extends Activity {
    static final String ACTION_CHANGE_ADDRESS = "app.jesse.comfyconcept.action.CHANGE_ADDRESS";

    private static final String TAILSCALE_PKG = "com.tailscale.ipn";
    private static final int REQ_FILE_CHOOSER = 1;
    private static final int REQ_STORAGE = 2;
    private static final int BG_COLOR = 0xFF11131A; // = @color/app_bg = --bg in app/styles.css

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(2);

    private WebView web;
    private View errorView;
    private TextView errorDetail;
    private TextView errorAddress;
    private NativeBridge bridge;
    private String server;

    private ValueCallback<Uri[]> fileCallback;
    private File cameraFile;
    private Uri cameraUri;

    private Runnable pendingStorageAction;
    private Intent pendingIntent;          // an intent waiting for the first-run address dialog
    private AlertDialog addressDialog;
    private String lastFailedUrl;
    private boolean clearHistoryOnFinish;
    private int probeGeneration;

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        setupSystemBars(findViewById(R.id.root));

        web = (WebView) findViewById(R.id.web);
        errorView = findViewById(R.id.error);
        errorDetail = (TextView) findViewById(R.id.error_detail);
        errorAddress = (TextView) findViewById(R.id.error_address);
        findViewById(R.id.btn_retry).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                retry();
            }
        });
        findViewById(R.id.btn_tailscale).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                openTailscale();
            }
        });
        findViewById(R.id.btn_address).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showAddressDialog(false);
            }
        });

        server = ServerConfig.get(this);
        setupWebView();

        boolean restored = savedInstanceState != null && web.restoreState(savedInstanceState) != null;
        // After a restore (e.g. the process was killed in the background), the
        // original intent was already handled: never re-send a share.
        Intent intent = savedInstanceState != null ? null : getIntent();
        if ((getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) intent = null;

        if (!ServerConfig.isConfirmed(this)) {
            pendingIntent = intent;
            showAddressDialog(true);
            return;
        }
        if (restored) {
            probe();
            return;
        }
        handleIntent(intent, true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!ServerConfig.isConfirmed(this)) {
            pendingIntent = intent;
            return;
        }
        handleIntent(intent, false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (addressDialog != null && addressDialog.isShowing()) addressDialog.dismiss();
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        destroyWebView();
        io.shutdown();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // The web viewer pushes a history entry, so Back closes it first.
        if (web != null && web.canGoBack()) {
            hideError();
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    // ---------------------------------------------------------------- intents

    private void handleIntent(Intent intent, boolean fresh) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            receiveShare(intent);
            return;
        }
        if (ACTION_CHANGE_ADDRESS.equals(action)) {
            if (fresh) loadHome();
            showAddressDialog(false);
            return;
        }
        // Plain launch. When the app is already open (onNewIntent), keep the page as it is.
        if (fresh) loadHome();
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> sharedUris(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) {
                for (Uri u : list) if (u != null) out.add(u);
            }
        } else {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) out.add(u);
        }
        if (out.isEmpty()) {
            ClipData clip = intent.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) out.add(u);
                }
            }
        }
        return out;
    }

    private void receiveShare(Intent intent) {
        List<Uri> uris = sharedUris(intent);
        if (uris.isEmpty()) {
            toast(getString(R.string.share_no_image));
            loadHome();
            return;
        }
        if (uris.size() > 1) toast(getString(R.string.share_multiple));
        else toast(getString(R.string.share_uploading));
        final Uri first = uris.get(0);
        final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        final String srv = server;
        final Context app = getApplicationContext();
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final String location = ShareUploader.upload(app, srv, first, text);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            loadServerUrl(ShareUploader.target(srv, location));
                        }
                    });
                } catch (final Exception e) {
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            toast(getString(R.string.share_failed, Net.describe(e)));
                            loadHome();
                        }
                    });
                }
            }
        });
    }

    // ---------------------------------------------------------------- web view

    private void setupWebView() {
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable); // off in release builds

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSafeBrowsingEnabled(false); // tailnet-only app; no URL lookups at Google
        s.setUserAgentString(s.getUserAgentString() + " ComfyConceptAndroid/1.0");

        // Service workers (the PWA's shell cache) get the same restrictions.
        ServiceWorkerWebSettings sw = ServiceWorkerController.getInstance().getServiceWorkerWebSettings();
        sw.setAllowContentAccess(false);
        sw.setAllowFileAccess(false);
        sw.setBlockNetworkLoads(false);

        web.setBackgroundColor(BG_COLOR);
        bridge = new NativeBridge(this);
        web.addJavascriptInterface(bridge, NativeBridge.NAME);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                onDownload(url, contentDisposition, mimetype);
            }
        });
    }

    private void destroyWebView() {
        if (web == null) return;
        ViewGroup parent = (ViewGroup) web.getParent();
        if (parent != null) parent.removeView(web);
        web.destroy();
        web = null;
    }

    private void loadHome() {
        loadServerUrl(server + "/");
    }

    private void loadServerUrl(String url) {
        if (web == null) return;
        hideError();
        web.loadUrl(url);
        probe();
    }

    private void retry() {
        String url = lastFailedUrl;
        if (url == null && web != null) url = web.getUrl();
        if (url == null || !ServerConfig.isServerUrl(url, server)) url = server + "/";
        loadServerUrl(url);
    }

    /**
     * The PWA's service worker can serve the cached app shell while the server is
     * unreachable (then the WebView reports no error at all), so check the server
     * directly as well and show the native error screen if it does not answer.
     */
    private void probe() {
        final int gen = ++probeGeneration;
        final String srv = server;
        io.execute(new Runnable() {
            @Override
            public void run() {
                String problem = null;
                try {
                    HttpURLConnection c = Net.open(srv + "/api/config", 10000);
                    try {
                        int code = c.getResponseCode();
                        if (code >= 500) problem = getString(R.string.err_server, code);
                    } finally {
                        c.disconnect();
                    }
                } catch (IOException e) {
                    problem = Net.describe(e);
                }
                if (problem == null) return;
                final String msg = problem;
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        if (gen == probeGeneration && srv.equals(server)) showError(msg);
                    }
                });
            }
        });
    }

    private final class Client extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            // The bridge only works while the top-level page is on the server.
            bridge.allowed = ServerConfig.isServerUrl(url, server);
            // A new page decides again whether the screen must stay on.
            setKeepAwake(false);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (clearHistoryOnFinish) {
                clearHistoryOnFinish = false;
                view.clearHistory();
            }
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (ServerConfig.isServerUrl(u.toString(), server)) return false;
            // Never show another origin inside the app: main-frame links open in
            // the browser, other-origin frames are blocked.
            if (request.isForMainFrame()) openExternal(u);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            lastFailedUrl = request.getUrl().toString();
            CharSequence d = error.getDescription();
            showError(d != null ? d.toString() : "");
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                lastFailedUrl = request.getUrl().toString();
                showError(getString(R.string.err_server, response.getStatusCode()));
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel(); // never proceed past a certificate error
            showError(getString(R.string.err_ssl));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The renderer crashed or was killed: drop this WebView and start over.
            if (view == web) {
                destroyWebView();
                recreate();
            }
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                launchFileChooser(params);
                return true;
            } catch (RuntimeException e) {
                fileCallback = null;
                cameraFile = null;
                cameraUri = null;
                toast(getString(R.string.file_chooser_failed));
                return false;
            }
        }
    }

    // ---------------------------------------------------------------- error screen

    private void showError(String detail) {
        String hint = getString(R.string.err_hint);
        errorDetail.setText(detail == null || detail.isEmpty() ? hint : detail + "\n\n" + hint);
        errorAddress.setText(server);
        errorView.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        lastFailedUrl = null;
        errorView.setVisibility(View.GONE);
    }

    private void openTailscale() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(TAILSCALE_PKG);
        if (launch != null) {
            try {
                startActivity(launch);
                return;
            } catch (ActivityNotFoundException ignored) {
                // fall through to the store
            }
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + TAILSCALE_PKG)));
        } catch (ActivityNotFoundException e) {
            openExternal(Uri.parse("https://play.google.com/store/apps/details?id=" + TAILSCALE_PKG));
        }
    }

    private void openExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("mailto") && !scheme.equals("tel")) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.no_app));
        }
    }

    // ---------------------------------------------------------------- address dialog

    private void showAddressDialog(final boolean firstRun) {
        if (addressDialog != null && addressDialog.isShowing()) return;
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(ServerConfig.DEFAULT_URL);
        input.setText(server);
        input.setSelection(input.getText().length());
        FrameLayout wrap = new FrameLayout(this);
        wrap.setPadding(dp(20), dp(8), dp(20), 0);
        wrap.addView(input);

        AlertDialog.Builder b = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle(firstRun ? R.string.address_title_first : R.string.address_title)
                .setMessage(R.string.address_message)
                .setView(wrap)
                .setPositiveButton(firstRun ? R.string.address_connect : R.string.address_save, null)
                .setNeutralButton(R.string.address_default, null)
                .setCancelable(!firstRun);
        if (!firstRun) b.setNegativeButton(android.R.string.cancel, null);
        final AlertDialog d = b.create();
        d.setOnShowListener(new DialogInterface.OnShowListener() {
            @Override
            public void onShow(DialogInterface di) {
                // Set the listeners here so an invalid address keeps the dialog open.
                d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        String url = ServerConfig.normalize(input.getText().toString());
                        if (url == null) {
                            input.setError(getString(R.string.address_invalid));
                            return;
                        }
                        d.dismiss();
                        applyAddress(url, firstRun);
                    }
                });
                d.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(new View.OnClickListener() {
                    @Override
                    public void onClick(View v) {
                        input.setText(ServerConfig.DEFAULT_URL);
                        input.setSelection(input.getText().length());
                    }
                });
            }
        });
        addressDialog = d;
        d.show();
    }

    private void applyAddress(String url, boolean firstRun) {
        boolean changed = !url.equals(server);
        ServerConfig.set(this, url);
        ServerConfig.setConfirmed(this);
        server = url;
        if (firstRun) {
            Intent p = pendingIntent;
            pendingIntent = null;
            handleIntent(p, true);
            return;
        }
        if (changed) {
            toast(getString(R.string.address_saved));
            clearHistoryOnFinish = true;
            loadHome();
        } else if (errorView.getVisibility() == View.VISIBLE) {
            retry();
        }
    }

    // ---------------------------------------------------------------- file chooser

    private void launchFileChooser(WebChromeClient.FileChooserParams params) {
        String[] accept = params.getAcceptTypes();
        boolean imagesOnly = acceptsOnlyImages(accept);
        boolean multiple = params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        Intent camera = imagesOnly || accept == null || accept.length == 0 || allEmpty(accept) ? cameraIntent() : null;

        // <input capture>: straight to the camera (the web app's "Camera" button).
        if (params.isCaptureEnabled() && camera != null) {
            startActivityForResult(camera, REQ_FILE_CHOOSER);
            return;
        }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        // Non-image types (the .json workflow import) use */*: many providers
        // report .json files as octet-stream, which a strict filter would hide.
        pick.setType(imagesOnly ? "image/*" : "*/*");
        if (multiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        Intent chooser = Intent.createChooser(pick, getString(R.string.file_chooser_title));
        if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {camera});
        startActivityForResult(chooser, REQ_FILE_CHOOSER);
    }

    private static boolean allEmpty(String[] accept) {
        for (String a : accept) if (a != null && !a.trim().isEmpty()) return false;
        return true;
    }

    private static boolean acceptsOnlyImages(String[] accept) {
        if (accept == null) return false;
        boolean any = false;
        for (String raw : accept) {
            if (raw == null) continue;
            for (String part : raw.split(",")) {
                String a = part.trim().toLowerCase(Locale.ROOT);
                if (a.isEmpty()) continue;
                any = true;
                boolean image = a.startsWith("image/") || a.equals(".png") || a.equals(".jpg") || a.equals(".jpeg")
                        || a.equals(".webp") || a.equals(".gif") || a.equals(".bmp") || a.equals(".heic");
                if (!image) return false;
            }
        }
        return any;
    }

    /** ACTION_IMAGE_CAPTURE writing into cache/camera/ through CacheFileProvider, or null if no camera app. */
    private Intent cameraIntent() {
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        List<ResolveInfo> handlers = getPackageManager().queryIntentActivities(i, PackageManager.MATCH_DEFAULT_ONLY);
        if (handlers == null || handlers.isEmpty()) return null;
        File dir = CacheFileProvider.dir(this, CacheFileProvider.DIR_CAMERA);
        File[] old = dir.listFiles();
        if (old != null) {
            long cutoff = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
            for (File f : old) if (f.lastModified() < cutoff) f.delete();
        }
        cameraFile = new File(dir, "capture_" + System.currentTimeMillis() + ".jpg");
        cameraUri = CacheFileProvider.uriFor(CacheFileProvider.DIR_CAMERA, cameraFile.getName());
        int flags = Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION;
        i.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
        i.setClipData(ClipData.newRawUri("", cameraUri));
        i.addFlags(flags);
        // Grant explicitly too: when launched from the chooser's extra intents the
        // intent's own grant flags are not always applied.
        for (ResolveInfo r : handlers) {
            if (r.activityInfo != null) grantUriPermission(r.activityInfo.packageName, cameraUri, flags);
        }
        return i;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQ_FILE_CHOOSER) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> cb = fileCallback;
        fileCallback = null;
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            result = urisFrom(data);
            boolean usable = false;
            if (result != null) {
                for (Uri u : result) {
                    if (!u.equals(cameraUri)) usable = true;
                }
            }
            // Camera apps usually return no data: the photo is in our file.
            if (!usable) result = cameraFile != null && cameraFile.length() > 0 ? new Uri[] {cameraUri} : null;
        }
        if (cameraUri != null) {
            revokeUriPermission(cameraUri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        }
        cameraFile = null;
        cameraUri = null;
        if (cb != null) cb.onReceiveValue(result);
    }

    private static Uri[] urisFrom(Intent data) {
        if (data == null) return null;
        List<Uri> out = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) out.add(u);
            }
        }
        if (out.isEmpty() && data.getData() != null) out.add(data.getData());
        return out.isEmpty() ? null : out.toArray(new Uri[0]);
    }

    // ---------------------------------------------------------------- save / share / downloads

    /** Called from the bridge (UI thread). */
    void requestSave(final String url, final String filename) {
        if (!ServerConfig.isServerUrl(url, server)) {
            toast(getString(R.string.save_blocked));
            return;
        }
        final Context app = getApplicationContext();
        withStoragePermission(new Runnable() {
            @Override
            public void run() {
                toast(getString(R.string.saving));
                io.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            String where = MediaSaver.saveFromUrl(app, url, filename);
                            toastFromBackground(app.getString(R.string.saved_to, where));
                        } catch (Exception e) {
                            toastFromBackground(app.getString(R.string.save_failed, Net.describe(e)));
                        }
                    }
                });
            }
        });
    }

    /** Called from the bridge for blob: downloads (UI thread). */
    void requestSaveData(final String dataUrl, final String filename) {
        final Context app = getApplicationContext();
        withStoragePermission(new Runnable() {
            @Override
            public void run() {
                io.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            String where = MediaSaver.saveDataUrl(app, dataUrl, filename);
                            toastFromBackground(app.getString(R.string.saved_to, where));
                        } catch (Exception e) {
                            toastFromBackground(app.getString(R.string.save_failed, Net.describe(e)));
                        }
                    }
                });
            }
        });
    }

    /** Called from the bridge (UI thread). */
    void shareOut(final String url, final String filename) {
        if (!ServerConfig.isServerUrl(url, server)) {
            toast(getString(R.string.save_blocked));
            return;
        }
        final Context app = getApplicationContext();
        io.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final File f = MediaSaver.downloadForShare(app, url, filename);
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            startShareIntent(f);
                        }
                    });
                } catch (Exception e) {
                    toastFromBackground(app.getString(R.string.share_out_failed, Net.describe(e)));
                }
            }
        });
    }

    private void startShareIntent(File f) {
        if (isFinishing()) return;
        Uri uri = CacheFileProvider.uriFor(CacheFileProvider.DIR_SHARED, f.getName());
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(CacheFileProvider.mimeForName(f.getName()));
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.setClipData(ClipData.newRawUri(f.getName(), uri));
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, getString(R.string.share_title));
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(chooser);
        } catch (ActivityNotFoundException e) {
            toast(getString(R.string.no_app));
        }
    }

    /** Called from the bridge (UI thread). */
    void setKeepAwake(boolean on) {
        Window w = getWindow();
        if (on) w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /** Every WebView download goes to the same gallery/Downloads save path. */
    private void onDownload(String url, String contentDisposition, String mimetype) {
        if (url == null) return;
        String mime = Net.cleanMime(mimetype);
        if (url.startsWith("data:")) {
            requestSaveData(url, URLUtil.guessFileName(url, contentDisposition, mime));
            return;
        }
        if (url.startsWith("blob:")) {
            // A blob only exists inside the page: let the page read it and hand it over.
            String name = URLUtil.guessFileName(url, contentDisposition, mime);
            String js = "(function(u,n){fetch(u).then(function(r){return r.blob();}).then(function(b){"
                    + "var fr=new FileReader();fr.onload=function(){window." + NativeBridge.NAME + ".saveDataUrl(fr.result,n);};"
                    + "fr.onerror=function(){window." + NativeBridge.NAME + ".reportError('could not read the file');};"
                    + "fr.readAsDataURL(b);}).catch(function(e){window." + NativeBridge.NAME + ".reportError(String(e&&e.message||e));});})("
                    + JSONObject.quote(url) + "," + JSONObject.quote(name) + ");";
            if (web != null) web.evaluateJavascript(js, null);
            return;
        }
        if (ServerConfig.isServerUrl(url, server)) {
            requestSave(url, downloadName(url, contentDisposition, mime));
            return;
        }
        openExternal(Uri.parse(url));
    }

    /** /comfy/view?filename=x.png -> x.png; otherwise the usual guess. */
    private static String downloadName(String url, String contentDisposition, String mime) {
        try {
            String f = Uri.parse(url).getQueryParameter("filename");
            if (f != null && !f.isEmpty()) return f;
        } catch (RuntimeException ignored) {
            // not a hierarchical URI
        }
        return URLUtil.guessFileName(url, contentDisposition, mime);
    }

    /** Android 8-9 need WRITE_EXTERNAL_STORAGE to write into Pictures/; 10+ do not. */
    private void withStoragePermission(Runnable action) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED) {
            action.run();
            return;
        }
        pendingStorageAction = action;
        requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_STORAGE) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }
        Runnable action = pendingStorageAction;
        pendingStorageAction = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (action != null) action.run();
        } else {
            toast(getString(R.string.save_permission_denied));
        }
    }

    // ---------------------------------------------------------------- system bars

    /**
     * Edge-to-edge on every version (Android 15 forces it anyway): the content
     * draws behind the status and navigation bars, and the root view takes the
     * bar (and keyboard) insets as padding, so its background (#11131A, same as
     * the web UI) shows behind the bars and nothing is covered.
     */
    @SuppressWarnings("deprecation")
    private void setupSystemBars(View root) {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            w.setDecorFitsSystemWindows(false);
        } else {
            root.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT < 35) {
            // Ignored on Android 15+, where the bars are always transparent.
            w.setStatusBarColor(BG_COLOR);
            w.setNavigationBarColor(BG_COLOR);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                            | WindowInsets.Type.displayCutout()
                            | WindowInsets.Type.ime());
                    v.setPadding(i.left, i.top, i.right, i.bottom);
                    return WindowInsets.CONSUMED;
                }
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });
        root.requestApplyInsets();
    }

    // ---------------------------------------------------------------- helpers

    void toast(String msg) {
        Toast.makeText(getApplicationContext(), msg, Toast.LENGTH_LONG).show();
    }

    private void toastFromBackground(final String msg) {
        main.post(new Runnable() {
            @Override
            public void run() {
                toast(msg);
            }
        });
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }
}
