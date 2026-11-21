package com.docvikts.svitlo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONArray;
import org.json.JSONObject;

public class OutageAlarmReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String key = intent.getStringExtra("key");
        if (key == null) return;
        synchronized (SyncStore.LOCK) {
            SyncStore store = new SyncStore(context);
            JSONObject state = store.read();
            JSONArray events = state.optJSONArray("alarms");
            if (events == null) return;
            for (int i = 0; i < events.length(); i++) {
                JSONObject event = events.optJSONObject(i);
                if (event == null || !key.equals(event.optString("key"))) continue;
                long now = System.currentTimeMillis();
                if (SyncStore.address(state, event.optString("addressId")) == null || now > event.optLong("outageAt") || now + 1000 < event.optLong("at")) return;
                ScheduleNotifications.show(context, ScheduleNotifications.OUTAGES, "outage:" + key, event.optString("title"), event.optString("body"));
                return;
            }
        }
    }
}
