package com.docvikts.svitlo;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;

public final class ScheduleWidgets {
    private ScheduleWidgets() {}
    static final String REFRESH = "com.docvikts.svitlo.WIDGET_REFRESH", TICK = "com.docvikts.svitlo.WIDGET_TICK";
    static SharedPreferences preferences(Context c) { return c.getSharedPreferences("svitlo.widgets.v1", Context.MODE_PRIVATE); }
    static boolean owned(Context c, int id) {
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(c).getAppWidgetInfo(id);
        return info != null && (new ComponentName(c, ScheduleWidgetProvider.class).equals(info.provider) || new ComponentName(c, CompactWidgetProvider.class).equals(info.provider));
    }
    static boolean choose(Context c, int widgetId, String addressId, String group) {
        synchronized (SyncStore.LOCK) {
            JSONObject state = new SyncStore(c).read();
            WidgetData data = WidgetData.from(state, addressId, group, System.currentTimeMillis());
            if (!owned(c, widgetId) || !data.configured) return false;
            preferences(c).edit().putString(widgetId + ":address", addressId).putString(widgetId + ":group", group).apply();
        }
        updateAll(c);
        return true;
    }
    static List<Integer> ids(Context c) {
        AppWidgetManager manager = AppWidgetManager.getInstance(c);
        List<Integer> ids = new ArrayList<>();
        for (Class<?> type : new Class<?>[] { ScheduleWidgetProvider.class, CompactWidgetProvider.class }) {
            for (int id : manager.getAppWidgetIds(new ComponentName(c, type))) ids.add(id);
        }
        return ids;
    }
    public static void updateAll(Context c) {
        // A launcher problem must not turn a successful schedule download into a network failure.
        try {
            List<Integer> ids = ids(c);
            for (int id : ids) { try { update(c, id, false); } catch (RuntimeException ignored) {} }
            AlarmManager alarm = c.getSystemService(AlarmManager.class);
            PendingIntent tick = PendingIntent.getBroadcast(c, 0, new Intent(c, ScheduleWidgetProvider.class).setAction(TICK), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            if (ids.isEmpty()) { alarm.cancel(tick); return; }
            long now = System.currentTimeMillis(), at = (now / 900000 + 1) * 900000;
            synchronized (SyncStore.LOCK) {
                JSONObject snapshots = SyncStore.snapshots(new SyncStore(c).read());
                for (int id : ids) {
                    JSONObject snapshot = snapshots.optJSONObject(preferences(c).getString(id + ":address", ""));
                    long staleAt = snapshot == null ? 0 : snapshot.optLong("fetchedAt") + 15 * 60000L + 1000;
                    if (staleAt > now) at = Math.min(at, staleAt);
                }
            }
            // Local redraw only: do not wake a sleeping device or perform network I/O.
            try {
                if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) alarm.setExact(AlarmManager.RTC, at, tick);
                else alarm.set(AlarmManager.RTC, at, tick);
            } catch (SecurityException denied) { alarm.set(AlarmManager.RTC, at, tick); }
        } catch (RuntimeException ignored) { /* System periodic widget updates remain available. */ }
    }
    static PendingIntent open(Context c, int id, WidgetData data) {
        Intent intent;
        if (!data.configured) intent = new Intent(c, WidgetConfigureActivity.class).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        else intent = new Intent(c, MainActivity.class).putExtra("svitlo.widget.address", data.addressId);
        intent.setData(Uri.parse("svitlo://widget/" + id)).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, id, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    static RemoteViews views(Context c, int id, boolean compact, JSONObject state, long now, boolean refreshing) {
        SharedPreferences prefs = preferences(c);
        WidgetData data = WidgetData.from(state, prefs.getString(id + ":address", null), prefs.getString(id + ":group", null), now);
        RemoteViews view = new RemoteViews(c.getPackageName(), compact ? R.layout.widget_compact : R.layout.widget_wide);
        String label = data.address;
        if (compact && label.contains(",")) label = label.substring(label.indexOf(',') + 1).trim().replaceFirst("^вул\\.\\s*", "");
        view.setTextViewText(R.id.widget_address, label + (data.group == null ? "" : " · " + data.group));
        view.setContentDescription(R.id.widget_address, data.address + (data.group == null ? "" : ", підчерга " + data.group));
        view.setTextViewText(R.id.widget_status, data.title);
        view.setTextViewText(R.id.widget_note, compact && data.value != null && !data.stale ? "ГПВ · " + WidgetData.clock(now) : data.note);
        view.setTextViewText(R.id.widget_time, data.time);
        view.setTextViewText(R.id.widget_next, data.next);
        view.setTextViewText(R.id.widget_remaining, data.remaining);
        view.setViewVisibility(R.id.widget_time, data.time.equals("—") ? View.GONE : View.VISIBLE);
        view.setViewVisibility(R.id.widget_next, data.next.isEmpty() ? View.GONE : View.VISIBLE);
        Bundle options = AppWidgetManager.getInstance(c).getAppWidgetOptions(id);
        boolean roomy = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 190) >= 215;
        view.setViewVisibility(R.id.widget_remaining, compact || !roomy || data.remaining.isEmpty() ? View.GONE : View.VISIBLE);
        view.setTextViewText(R.id.widget_checked, refreshing ? "Запит на оновлення…" : data.checked);
        int color = data.stale || data.value == null ? R.color.widget_muted : data.value == 0 ? R.color.widget_on : data.value == 1 ? R.color.widget_off : R.color.widget_maybe;
        view.setTextColor(R.id.widget_status, c.getColor(color));
        view.setOnClickPendingIntent(R.id.widget_root, open(c, id, data));
        Intent refresh = new Intent(c, ScheduleWidgetProvider.class).setAction(REFRESH).setData(Uri.parse("svitlo://widget/refresh/" + id)).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        view.setOnClickPendingIntent(R.id.widget_refresh, data.configured
            ? PendingIntent.getBroadcast(c, id, refresh, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE) : open(c, id, data));
        if (!compact) {
            Bundle size = AppWidgetManager.getInstance(c).getAppWidgetOptions(id);
            int width = Math.max(180, Math.min(680, size.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 320) - 24));
            view.setImageViewBitmap(R.id.widget_timeline, timeline(c, data, width));
            view.setViewVisibility(R.id.widget_timeline, data.slots == null ? View.GONE : View.VISIBLE);
        }
        return view;
    }
    static void update(Context c, int id, boolean refreshing) {
        AppWidgetManager manager = AppWidgetManager.getInstance(c);
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(id);
        if (info == null) return;
        JSONObject state;
        synchronized (SyncStore.LOCK) { state = new SyncStore(c).read(); }
        boolean compact = new ComponentName(c, CompactWidgetProvider.class).equals(info.provider);
        manager.updateAppWidget(id, views(c, id, compact, state, System.currentTimeMillis(), refreshing));
    }
    static Bitmap timeline(Context c, WidgetData data, int width) {
        Bitmap bitmap = Bitmap.createBitmap(width * 2, 120, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap); canvas.scale(2, 2);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float x0 = 3, length = width - 6;
        int[] colors = { c.getColor(R.color.widget_on), c.getColor(R.color.widget_off), c.getColor(R.color.widget_maybe) };
        canvas.save(); Path clip = new Path(); clip.addRoundRect(new RectF(x0, 24, width - 3, 43), 6, 6, Path.Direction.CW); canvas.clipPath(clip);
        for (int i = 0; i < 48; i++) {
            Integer value = data.stale ? null : ScheduleLogic.state(data.slots == null ? null : data.slots.opt(i));
            p.setColor(value == null ? c.getColor(R.color.widget_unknown) : colors[value == 0 ? 0 : value == 1 ? 1 : 2]);
            canvas.drawRect(x0 + length * i / 48, 24, x0 + length * (i + 1) / 48 - .6f, 43, p);
        }
        canvas.restore();
        int ink = c.getColor(R.color.widget_ink); p.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL)); p.setTextSize(10);
        p.setColor(c.getColor(R.color.widget_muted));
        for (int h : new int[] { 0, 6, 12, 18, 24 }) {
            String t = String.format(java.util.Locale.ROOT, "%02d", h);
            p.setTextAlign(h == 0 ? Paint.Align.LEFT : h == 24 ? Paint.Align.RIGHT : Paint.Align.CENTER);
            canvas.drawText(t, x0 + length * h / 24, 57, p);
        }
        if (!data.stale && data.value != null) {
            float x = x0 + length * data.minute / 1440;
            p.setColor(ink); p.setStrokeWidth(1.4f); canvas.drawLine(x, 21, x, 46, p); canvas.drawCircle(x, 23, 3, p);
            float label = Math.max(23, Math.min(width - 23, x));
            canvas.drawRoundRect(new RectF(label - 20, 1, label + 20, 17), 4, 4, p);
            p.setColor(c.getColor(R.color.widget_surface)); p.setTextSize(10); p.setTextAlign(Paint.Align.CENTER); p.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
            canvas.drawText(ScheduleLogic.time(data.minute), label, 12.5f, p);
        }
        return bitmap;
    }
}
