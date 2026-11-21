package app.jesse.comfyconcept;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Minimal stand-in for androidx FileProvider (AndroidX is not used in this app).
 *
 * URIs look like content://app.jesse.comfyconcept.files/<dir>/<name> and map to
 * getCacheDir()/<dir>/<name>. Only two directories exist:
 *   shared/  read-only: images handed to other apps through "Share".
 *   camera/  read-write: the photo the camera app writes for the file chooser.
 * The provider is not exported; other apps only get in through a per-URI grant
 * (FLAG_GRANT_READ/WRITE_URI_PERMISSION) on an intent this app sends.
 */
public class CacheFileProvider extends ContentProvider {
    static final String AUTHORITY = "app.jesse.comfyconcept.files";
    static final String DIR_SHARED = "shared";
    static final String DIR_CAMERA = "camera";

    static Uri uriFor(String dir, String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(dir).appendPath(name).build();
    }

    /** cacheDir/dir, created if needed. */
    static File dir(Context c, String dir) {
        File d = new File(c.getCacheDir(), dir);
        if (!d.isDirectory()) d.mkdirs();
        return d;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File fileFor(Uri uri) throws FileNotFoundException {
        Context c = getContext();
        if (c == null || !AUTHORITY.equals(uri.getAuthority())) throw new FileNotFoundException("Unknown URI");
        List<String> seg = uri.getPathSegments();
        if (seg == null || seg.size() != 2) throw new FileNotFoundException("Unknown URI");
        String dir = seg.get(0);
        String name = seg.get(1);
        if (!DIR_SHARED.equals(dir) && !DIR_CAMERA.equals(dir)) throw new FileNotFoundException("Unknown folder");
        if (name.isEmpty() || name.contains("/") || name.contains("\\") || ".".equals(name) || "..".equals(name)) {
            throw new FileNotFoundException("Bad file name");
        }
        File base = new File(c.getCacheDir(), dir);
        File f = new File(base, name);
        try {
            File parent = f.getCanonicalFile().getParentFile();
            if (parent == null || !parent.equals(base.getCanonicalFile())) throw new FileNotFoundException("Bad path");
        } catch (IOException e) {
            throw new FileNotFoundException("Bad path");
        }
        return f;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        boolean write = mode.indexOf('w') >= 0 || mode.indexOf('a') >= 0 || mode.indexOf('t') >= 0;
        if (write && !DIR_CAMERA.equals(uri.getPathSegments().get(0))) {
            throw new SecurityException("This file is read-only");
        }
        if (!write && !f.isFile()) throw new FileNotFoundException("No such file");
        if (write) {
            File parent = f.getParentFile();
            if (parent != null && !parent.isDirectory()) parent.mkdirs();
        }
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try {
            f = fileFor(uri);
        } catch (FileNotFoundException e) {
            return null;
        }
        String[] wanted = projection != null ? projection : new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        List<String> cols = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (String col : wanted) {
            if (OpenableColumns.DISPLAY_NAME.equals(col)) {
                cols.add(OpenableColumns.DISPLAY_NAME);
                values.add(f.getName());
            } else if (OpenableColumns.SIZE.equals(col)) {
                cols.add(OpenableColumns.SIZE);
                values.add(f.length());
            }
        }
        MatrixCursor cursor = new MatrixCursor(cols.toArray(new String[0]), 1);
        cursor.addRow(values.toArray(new Object[0]));
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        String name = uri.getLastPathSegment();
        if (name == null) return "application/octet-stream";
        return mimeForName(name);
    }

    static String mimeForName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null) return m;
        }
        return "application/octet-stream";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read-only provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
