package com.docvikts.svitlo;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;

public final class ScheduleNotifications {
    private ScheduleNotifications() {}
    static final String UPDATES = "svitlo_updates", OUTAGES = "svitlo_outages";

    static void channels(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel(UPDATES, "Зміни графіків", NotificationManager.IMPORTANCE_DEFAULT));
            manager.createNotificationChannel(new NotificationChannel(OUTAGES, "Попередження про відключення", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    static PendingIntent alarmIntent(Context context, String key) {
        Intent intent = new Intent(context, OutageAlarmReceiver.class).setData(Uri.parse("svitlo://outage/" + Uri.encode(key)));
        intent.putExtra("key", key);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Caller holds SyncStore.LOCK: prevent alarm replacement racing an address removal. */
    static void reconcile(Context context, JSONObject state) throws Exception {
        channels(context);
        AlarmManager manager = context.getSystemService(AlarmManager.class);
        JSONArray old = state.optJSONArray("alarms");
        if (old != null) for (int i = 0; i < old.length(); i++) manager.cancel(alarmIntent(context, old.getJSONObject(i).getString("key")));
        JSONArray events = ScheduleLogic.alerts(SyncStore.addresses(state), SyncStore.snapshots(state), state.optInt("lead", 30), System.currentTimeMillis());
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) events = new JSONArray();
        for (int i = 0; i < events.length(); i++) {
            JSONObject event = events.getJSONObject(i);
            PendingIntent pending = alarmIntent(context, event.getString("key"));
            long at = event.getLong("at");
            try {
                if (Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
                else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } catch (SecurityException changedPermission) { manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending); }
        }
        state.put("alarms", events);
    }

    static void show(Context context, String channel, String tag, String title, String body) {
        channels(context);
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        Intent launch = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_svitlo_notification).setContentTitle(title).setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(open)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPriority(NotificationCompat.PRIORITY_DEFAULT);
        try { NotificationManagerCompat.from(context).notify(tag, 1, notification.build()); }
        catch (SecurityException denied) { /* Permission can change after the check. */ }
    }
}
