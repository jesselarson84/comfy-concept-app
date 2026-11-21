package app.jesse.comfyconcept;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/** Small HttpURLConnection helpers (HTTPS only, no redirects followed). */
final class Net {
    private Net() {
    }

    static HttpURLConnection open(String url, int readTimeoutMs) throws IOException {
        URL u = new URL(url);
        if (!"https".equalsIgnoreCase(u.getProtocol())) throw new IOException("Only https:// addresses are allowed");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(readTimeoutMs);
        c.setInstanceFollowRedirects(false);
        c.setUseCaches(false);
        return c;
    }

    /** "image/png; charset=x" -> "image/png"; null if empty. */
    static String cleanMime(String contentType) {
        if (contentType == null) return null;
        int semi = contentType.indexOf(';');
        String m = (semi >= 0 ? contentType.substring(0, semi) : contentType).trim().toLowerCase(Locale.ROOT);
        return m.isEmpty() ? null : m;
    }

    static long copy(InputStream in, OutputStream out, long max) throws IOException {
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > max) throw new IOException("File is too large");
            out.write(buf, 0, n);
        }
        out.flush();
        return total;
    }

    static byte[] readAll(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copy(in, out, max);
        return out.toByteArray();
    }

    /** Short, user-readable message for an exception. */
    static String describe(Throwable e) {
        String m = e.getMessage();
        if (m == null || m.isEmpty()) m = e.getClass().getSimpleName();
        return m;
    }
}
