package app.jesse.comfyconcept;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * Keeps a run going while the app is in the background (batch 3).
 *
 * The web app reports its run through window.AndroidBridge.runStatus(current,
 * total, running, done) (app/js/native.js). While a run is active this is a
 * foreground service (type dataSync: it follows a remote job on the PC) with an
 * ongoing "Running N of M" notification, so Android keeps the process and the
 * WebView's websocket alive. When the run ends the service stops, the phone
 * vibrates once and a "Finished" notification replaces the ongoing one.
 * It never starts anything by itself and holds no data beyond the two numbers.
 */
public final class RunService extends Service {
    static final String ACTION_UPDATE = "app.jesse.comfyconcept.run.UPDATE";
    static final String ACTION_FINISH = "app.jesse.comfyconcept.run.FINISH";
    static final String EXTRA_CURRENT = "current";
    static final String EXTRA_TOTAL = "total";
    static final String EXTRA_DONE = "done";
    private static final String CHANNEL = "runs";
    private static final int ID_RUNNING = 1;
    private static final int ID_FINISHED = 2;

    private boolean foreground;

    /** Called from MainActivity on the UI thread. */
    static void update(Context ctx, int current, int total, boolean running, int done) {
        Intent i = new Intent(ctx, RunService.class)
                .setAction(running ? ACTION_UPDATE : ACTION_FINISH)
                .putExtra(EXTRA_CURRENT, current)
                .putExtra(EXTRA_TOTAL, total)
                .putExtra(EXTRA_DONE, done);
        try {
            if (running) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
                else ctx.startService(i);
            } else {
                ctx.startService(i);
            }
        } catch (RuntimeException e) {
            // e.g. ForegroundServiceStartNotAllowedException: the run still goes on
            // in the app, there is just no notification.
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        int current = intent == null ? 0 : intent.getIntExtra(EXTRA_CURRENT, 0);
        int total = intent == null ? 0 : intent.getIntExtra(EXTRA_TOTAL, 0);
        int done = intent == null ? 0 : intent.getIntExtra(EXTRA_DONE, 0);
        ensureChannel();
        if (ACTION_UPDATE.equals(action)) {
            Notification n = build(getString(R.string.run_running, current, total), true, current, total);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ID_RUNNING, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(ID_RUNNING, n);
            }
            foreground = true;
            return START_NOT_STICKY;
        }
        // FINISH (or a restart with no intent): drop the ongoing notification.
        // MainActivity only sends FINISH after it saw the run going.
        boolean wasRunning = ACTION_FINISH.equals(action);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        foreground = false;
        if (wasRunning && total > 0) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(ID_FINISHED, build(getString(R.string.run_finished, done, total), false, total, total));
            vibrate();
        }
        stopSelf();
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15 limits dataSync services to 6 h a day: stop cleanly.
        stopSelf();
    }

    private Notification build(String text, boolean ongoing, int current, int total) {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_launcher_monochrome)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .setOnlyAlertOnce(true)
                .setShowWhen(!ongoing)
                .setCategory(Notification.CATEGORY_PROGRESS);
        if (ongoing && total > 0) b.setProgress(total, Math.max(0, current - 1), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && ongoing) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        // Low importance: no sound for every update; the finish vibration is done here.
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.run_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    @SuppressWarnings("deprecation")
    private void vibrate() {
        Vibrator v;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = getSystemService(VibratorManager.class);
            v = vm == null ? null : vm.getDefaultVibrator();
        } else {
            v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(new long[] {0, 120, 90, 120}, -1));
        else v.vibrate(new long[] {0, 120, 90, 120}, -1);
    }
}
