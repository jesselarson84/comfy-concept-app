package app.jesse.comfyconcept;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

/**
 * "Share -> Comfy Concept": sends the image to the server exactly like the
 * PWA's share_target does (see server/share.js):
 *   POST <server>/share, multipart/form-data, file field "image" (+ optional "text")
 *   -> 303 See Other, Location: /?from=share&ref=<uploaded name>  (or &shareError=...)
 * Redirects are not followed; the caller loads <server><Location> in the WebView.
 * Blocking: call on a background thread.
 */
final class ShareUploader {
    private static final int MAX_BYTES = 45 * 1024 * 1024; // server limit is 50 MB for the whole body

    private ShareUploader() {
    }

    /** Returns the Location header of the server's redirect. */
    static String upload(Context ctx, String server, Uri image, String text) throws IOException {
        if (!"content".equals(image.getScheme()) || CacheFileProvider.AUTHORITY.equals(image.getAuthority())) {
            // file:// URIs (or our own provider) could point at this app's private files.
            throw new IOException("Unsupported image source");
        }
        ContentResolver cr = ctx.getContentResolver();
        String mime = Net.cleanMime(cr.getType(image));
        String name = displayName(cr, image);
        if (mime == null || !mime.startsWith("image/")) {
            String guess = name != null ? CacheFileProvider.mimeForName(name) : null;
            mime = guess != null && guess.startsWith("image/") ? guess : "image/png";
        }
        name = MediaSaver.fileName(name != null ? name : "shared", mime).replace("\"", "_");

        byte[] data;
        InputStream in = cr.openInputStream(image);
        if (in == null) throw new IOException("Could not read the shared image");
        try {
            data = Net.readAll(in, MAX_BYTES);
        } finally {
            in.close();
        }
        if (data.length == 0) throw new IOException("The shared image is empty");

        String boundary = "----ComfyConcept" + Long.toHexString(new SecureRandom().nextLong()) + Long.toHexString(System.nanoTime());
        ByteArrayOutputStream body = new ByteArrayOutputStream(data.length + 1024);
        if (text != null && !text.trim().isEmpty()) {
            write(body, "--" + boundary + "\r\n"
                    + "Content-Disposition: form-data; name=\"text\"\r\n\r\n"
                    + text.trim() + "\r\n");
        }
        write(body, "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"image\"; filename=\"" + name + "\"\r\n"
                + "Content-Type: " + mime + "\r\n\r\n");
        body.write(data, 0, data.length);
        write(body, "\r\n--" + boundary + "--\r\n");
        byte[] bytes = body.toByteArray();

        HttpURLConnection c = Net.open(server + "/share", 90000);
        try {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            c.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = c.getOutputStream();
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            int code = c.getResponseCode();
            String location = c.getHeaderField("Location");
            if (code < 300 || code >= 400 || location == null || location.isEmpty()) {
                throw new IOException("Server answered HTTP " + code);
            }
            return location;
        } finally {
            c.disconnect();
        }
    }

    /** Where to go after the upload: only paths on the server are accepted. */
    static String target(String server, String location) {
        if (location.startsWith("/") && !location.startsWith("//")) return server + location;
        if (ServerConfig.isServerUrl(location, server)) return location;
        return server + "/";
    }

    private static void write(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        out.write(b, 0, b.length);
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        Cursor c = null;
        try {
            c = cr.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) return c.getString(i);
            }
        } catch (RuntimeException ignored) {
            // Some providers refuse queries; the name is optional.
        } finally {
            if (c != null) c.close();
        }
        return null;
    }
}
