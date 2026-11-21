package app.jesse.comfyconcept;

import android.annotation.TargetApi;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URLDecoder;
import java.util.Locale;

/**
 * Saving into the gallery (MediaStore) and downloading for "Share".
 * All methods block: call them on a background thread.
 *
 * Images go to Pictures/Comfy Concept, anything else to Download/Comfy Concept.
 *   API 29+: MediaStore with RELATIVE_PATH + IS_PENDING (no permission needed).
 *   API 26-28: a file in the public folder + media scan (needs
 *              WRITE_EXTERNAL_STORAGE, which MainActivity requests first).
 */
final class MediaSaver {
    static final String FOLDER = "Comfy Concept";
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    private MediaSaver() {
    }

    /** Downloads url and saves it. Returns where it went (for the Toast). */
    static String saveFromUrl(Context ctx, String url, String requestedName) throws IOException {
        HttpURLConnection c = Net.open(url, 60000);
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("Server answered HTTP " + code);
            String mime = Net.cleanMime(c.getContentType());
            String name = fileName(requestedName, mime);
            if (mime == null || "application/octet-stream".equals(mime)) mime = CacheFileProvider.mimeForName(name);
            InputStream in = c.getInputStream();
            try {
                return saveStream(ctx, in, name, mime);
            } finally {
                in.close();
            }
        } finally {
            c.disconnect();
        }
    }

    /** Saves a data: URL (used for blob: downloads, which JS turns into data: URLs). */
    static String saveDataUrl(Context ctx, String dataUrl, String requestedName) throws IOException {
        if (dataUrl == null || !dataUrl.startsWith("data:")) throw new IOException("Not a data: URL");
        int comma = dataUrl.indexOf(',');
        if (comma < 0) throw new IOException("Malformed data: URL");
        String meta = dataUrl.substring(5, comma);
        String payload = dataUrl.substring(comma + 1);
        boolean base64 = meta.endsWith(";base64");
        String mime = Net.cleanMime(base64 ? meta.substring(0, meta.length() - 7) : meta);
        byte[] bytes;
        try {
            bytes = base64 ? Base64.decode(payload, Base64.DEFAULT) : URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
        } catch (IllegalArgumentException e) {
            throw new IOException("Malformed data: URL");
        }
        String name = fileName(requestedName, mime);
        if (mime == null || "application/octet-stream".equals(mime)) mime = CacheFileProvider.mimeForName(name);
        return saveStream(ctx, new ByteArrayInputStream(bytes), name, mime);
    }

    /** Downloads url into cache/shared/ for a Share intent. */
    static File downloadForShare(Context ctx, String url, String requestedName) throws IOException {
        File dir = CacheFileProvider.dir(ctx, CacheFileProvider.DIR_SHARED);
        // Tidy up older shares (the receiving app has had plenty of time to read them).
        File[] old = dir.listFiles();
        if (old != null) {
            long cutoff = System.currentTimeMillis() - 60L * 60 * 1000;
            for (File f : old) if (f.lastModified() < cutoff) f.delete();
        }
        HttpURLConnection c = Net.open(url, 60000);
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("Server answered HTTP " + code);
            String name = fileName(requestedName, Net.cleanMime(c.getContentType()));
            File out = new File(dir, name);
            InputStream in = c.getInputStream();
            try {
                OutputStream os = new FileOutputStream(out);
                try {
                    Net.copy(in, os, MAX_BYTES);
                } finally {
                    os.close();
                }
            } finally {
                in.close();
            }
            return out;
        } finally {
            c.disconnect();
        }
    }

    static String saveStream(Context ctx, InputStream in, String name, String mime) throws IOException {
        boolean image = mime != null && mime.startsWith("image/");
        if (mime == null) mime = "application/octet-stream";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return saveQ(ctx, in, name, mime, image);
        return saveLegacy(ctx, in, name, mime, image);
    }

    @TargetApi(Build.VERSION_CODES.Q)
    private static String saveQ(Context ctx, InputStream in, String name, String mime, boolean image) throws IOException {
        ContentResolver r = ctx.getContentResolver();
        String relative = (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/" + FOLDER;
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, relative);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri collection = image
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri item = r.insert(collection, v);
        if (item == null) throw new IOException("The gallery refused the file");
        boolean ok = false;
        try {
            OutputStream out = r.openOutputStream(item);
            if (out == null) throw new IOException("Could not open the gallery file");
            try {
                Net.copy(in, out, MAX_BYTES);
            } finally {
                out.close();
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            r.update(item, done, null, null);
            ok = true;
        } finally {
            if (!ok) r.delete(item, null, null);
        }
        return relative;
    }

    @SuppressWarnings("deprecation")
    private static String saveLegacy(Context ctx, InputStream in, String name, String mime, boolean image) throws IOException {
        File root = Environment.getExternalStoragePublicDirectory(image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS);
        File dir = new File(root, FOLDER);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir.getAbsolutePath());
        File f = unique(dir, name);
        boolean ok = false;
        try {
            OutputStream out = new FileOutputStream(f);
            try {
                Net.copy(in, out, MAX_BYTES);
            } finally {
                out.close();
            }
            ok = true;
        } finally {
            if (!ok) f.delete();
        }
        MediaScannerConnection.scanFile(ctx.getApplicationContext(), new String[] {f.getAbsolutePath()}, new String[] {mime}, null);
        return (image ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS) + "/" + FOLDER;
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 10000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "_" + System.currentTimeMillis() + ext);
    }

    /** A safe file name: keeps letters, digits and . _ - ( ) space; adds an extension for the mime type. */
    static String fileName(String requested, String mime) {
        String n = requested == null ? "" : requested.trim();
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n.length() && sb.length() < 120; i++) {
            char ch = n.charAt(i);
            if (Character.isLetterOrDigit(ch) || ch == '.' || ch == '_' || ch == '-' || ch == '(' || ch == ')' || ch == ' ') sb.append(ch);
            else sb.append('_');
        }
        n = sb.toString();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.trim().isEmpty()) n = "comfy-concept-" + System.currentTimeMillis();
        if (n.lastIndexOf('.') <= 0 && mime != null) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (ext != null) n = n + "." + ext.toLowerCase(Locale.ROOT);
        }
        return n;
    }
}
