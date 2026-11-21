package com.docvikts.svitlo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import org.json.JSONObject;

public class SyncRestartReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        try {
            synchronized (SyncStore.LOCK) {
                SyncStore store = new SyncStore(context);
                JSONObject state = store.read();
                if (!state.has("addresses")) return;
                ScheduleNotifications.reconcile(context, state);
                store.write(state);
                BackgroundWork.configure(context, state);
                if (state.optBoolean("enabled", true) && SyncStore.addresses(state).length() > 0) BackgroundWork.once(context, false);
            }
        } catch (Exception ignored) { /* WorkManager retries once its constraints allow it. */ }
    }
}
