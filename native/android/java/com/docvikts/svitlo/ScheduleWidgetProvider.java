package com.docvikts.svitlo;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

public class ScheduleWidgetProvider extends AppWidgetProvider {
    @Override public void onUpdate(Context c, AppWidgetManager manager, int[] ids) { ScheduleWidgets.updateAll(c); }
    @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager manager, int id, Bundle options) { ScheduleWidgets.updateAll(c); }
    @Override public void onEnabled(Context c) { ScheduleWidgets.updateAll(c); }
    @Override public void onDisabled(Context c) { ScheduleWidgets.updateAll(c); }
    @Override public void onDeleted(Context c, int[] ids) {
        for (int id : ids) ScheduleWidgets.preferences(c).edit().remove(id + ":address").remove(id + ":group").apply();
        ScheduleWidgets.updateAll(c);
    }
    @Override public void onRestored(Context c, int[] oldIds, int[] newIds) {
        for (int i = 0; i < Math.min(oldIds.length, newIds.length); i++) {
            String address = ScheduleWidgets.preferences(c).getString(oldIds[i] + ":address", null);
            String group = ScheduleWidgets.preferences(c).getString(oldIds[i] + ":group", null);
            if (address != null && group != null) ScheduleWidgets.choose(c, newIds[i], address, group);
        }
        ScheduleWidgets.updateAll(c);
    }
    @Override public void onReceive(Context c, Intent intent) {
        if (ScheduleWidgets.TICK.equals(intent.getAction())) { ScheduleWidgets.updateAll(c); return; }
        if (ScheduleWidgets.REFRESH.equals(intent.getAction())) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (ScheduleWidgets.owned(c, id)) {
                String address = ScheduleWidgets.preferences(c).getString(id + ":address", null);
                if (address != null) { WidgetRefreshWorker.enqueue(c, address); ScheduleWidgets.update(c, id, true); }
            }
            return;
        }
        super.onReceive(c, intent);
    }
}
