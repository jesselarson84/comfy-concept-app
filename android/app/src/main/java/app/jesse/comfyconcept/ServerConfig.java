package app.jesse.comfyconcept;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.util.Locale;

/** The server address (stored in SharedPreferences) and origin checks. */
final class ServerConfig {
    static final String DEFAULT_URL = "https://my-pc.my-tailnet.ts.net";

    private static final String PREFS = "comfy_concept";
    private static final String KEY_URL = "server_url";
    private static final String KEY_CONFIRMED = "address_confirmed";

    private ServerConfig() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Normalised server origin, e.g. "https://pc.tailnet.ts.net" (no trailing slash). */
    static String get(Context c) {
        String stored = normalize(prefs(c).getString(KEY_URL, null));
        return stored != null ? stored : DEFAULT_URL;
    }

    static void set(Context c, String url) {
        prefs(c).edit().putString(KEY_URL, url).apply();
    }

    static boolean isConfirmed(Context c) {
        return prefs(c).getBoolean(KEY_CONFIRMED, false);
    }

    static void setConfirmed(Context c) {
        prefs(c).edit().putBoolean(KEY_CONFIRMED, true).apply();
    }

    /**
     * Validates what the user typed. Accepts "https://host[:port]" with an
     * optional trailing slash (a bare host gets https:// added). Anything else
     * (http://, a path, a query, user info) returns null. The web app uses
     * absolute paths (/share, /comfy/...), so it must live at the origin root.
     */
    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (s.isEmpty()) return null;
        if (!s.contains("://")) s = "https://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme();
        if (scheme == null || !"https".equals(scheme.toLowerCase(Locale.ROOT))) return null;
        String host = u.getHost();
        if (host == null || host.isEmpty() || host.contains(" ")) return null;
        if (u.getUserInfo() != null) return null;
        String path = u.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) return null;
        if (u.getQuery() != null || u.getFragment() != null) return null;
        int port = u.getPort();
        if (port == 0 || port > 65535) return null;
        String origin = "https://" + host.toLowerCase(Locale.ROOT);
        if (port > 0 && port != 443) origin += ":" + port;
        return origin;
    }

    /** "scheme://host[:port]" with default ports left out, or null for non-http(s). */
    static String originOf(String url) {
        if (url == null) return null;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme();
        String host = u.getHost();
        if (scheme == null || host == null || host.isEmpty()) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        int defaultPort;
        if ("https".equals(scheme)) defaultPort = 443;
        else if ("http".equals(scheme)) defaultPort = 80;
        else return null;
        int port = u.getPort();
        String origin = scheme + "://" + host.toLowerCase(Locale.ROOT);
        if (port > 0 && port != defaultPort) origin += ":" + port;
        return origin;
    }

    /** True if url is https and on the same origin as the server. */
    static boolean isServerUrl(String url, String server) {
        String a = originOf(url);
        return a != null && a.startsWith("https://") && a.equals(originOf(server));
    }
}
