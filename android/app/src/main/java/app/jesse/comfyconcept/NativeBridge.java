package app.jesse.comfyconcept;

import android.webkit.JavascriptInterface;

/**
 * window.AndroidBridge, as used by app/js/native.js.
 *
 * Methods are called by the WebView on a background "JavaBridge" thread, so each
 * one hops to the UI thread. Every call is refused unless the page currently
 * shown is on the configured server origin: MainActivity sets {@link #allowed}
 * in onPageStarted, and it never lets the top-level page navigate to another
 * origin (other links open in the browser). URLs passed in are checked again
 * against the server origin before anything is downloaded.
 */
public final class NativeBridge {
    static final String NAME = "AndroidBridge";
    private static final int MAX_DATA_URL_CHARS = 60 * 1024 * 1024;

    private final MainActivity activity;
    volatile boolean allowed;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean isNativeApp() {
        return allowed;
    }

    @JavascriptInterface
    public void saveImage(final String url, final String filename) {
        if (!allowed || url == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.requestSave(url, filename);
            }
        });
    }

    @JavascriptInterface
    public void shareImage(final String url, final String filename) {
        if (!allowed || url == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.shareOut(url, filename);
            }
        });
    }

    /** History multi-select: share several results at once ([{url, name}] as JSON). */
    @JavascriptInterface
    public void shareImages(final String json) {
        if (!allowed || json == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.shareOutMany(json);
            }
        });
    }

    @JavascriptInterface
    public void keepAwake(final boolean on) {
        if (!allowed) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.setKeepAwake(on);
            }
        });
    }

    /**
     * Run progress (batch 3): while running, a foreground service shows
     * "Running current of total"; when it ends the phone vibrates once.
     */
    @JavascriptInterface
    public void runStatus(final int current, final int total, final boolean running, final int done) {
        if (!allowed) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.setRunStatus(current, total, running, done);
            }
        });
    }

    /** Used internally for blob: downloads (the page reads the blob and hands it over as a data: URL). */
    @JavascriptInterface
    public void saveDataUrl(final String dataUrl, final String filename) {
        if (!allowed || dataUrl == null || !dataUrl.startsWith("data:") || dataUrl.length() > MAX_DATA_URL_CHARS) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.requestSaveData(dataUrl, filename);
            }
        });
    }

    /** Used internally when a blob: download could not be read. */
    @JavascriptInterface
    public void reportError(final String message) {
        if (!allowed) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                activity.toast(activity.getString(R.string.save_failed, message == null ? "" : message));
            }
        });
    }
}
