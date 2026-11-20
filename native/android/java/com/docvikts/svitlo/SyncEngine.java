package com.docvikts.svitlo;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.function.BooleanSupplier;

/** One engine for visible and background refreshes, without depending on a WebView. */
public final class SyncEngine {
    private SyncEngine() {}
    private static final Object RUN_LOCK = new Object();

    public static JSONObject configure(Context context, JSONArray input, int lead, boolean enabled, boolean notifyChanges, JSONObject seeds) throws Exception {
        synchronized (SyncStore.LOCK) {
            SyncStore store = new SyncStore(context);
            JSONObject state = store.read();
            JSONArray addresses = new JSONArray();
            for (int i = 0; i < input.length(); i++) {
                JSONObject raw = input.getJSONObject(i), row = new JSONObject();
                for (String key : new String[] { "id", "cityId", "streetId", "house", "label" }) {
                    Object value = raw.opt(key);
                    if (value == null || value == JSONObject.NULL) throw new IllegalArgumentException("Неповна адреса");
                    row.put(key, String.valueOf(value));
                }
                addresses.put(row);
            }
            if (lead != 15 && lead != 30 && lead != 60 && lead != 120) throw new IllegalArgumentException("Некоректний час попередження");
            boolean changed = !addresses.toString().equals(SyncStore.addresses(state).toString())
                || lead != state.optInt("lead", 30) || enabled != state.optBoolean("enabled", true)
                || notifyChanges != state.optBoolean("notifyChanges", true);
            if (changed) state.put("revision", state.optLong("revision") + 1);
            state.put("addresses", addresses).put("lead", lead).put("enabled", enabled).put("notifyChanges", notifyChanges);
            JSONObject old = SyncStore.snapshots(state), snapshots = new JSONObject();
            for (int i = 0; i < addresses.length(); i++) {
                String id = addresses.getJSONObject(i).getString("id");
                JSONObject data = old.optJSONObject(id);
                if (data == null && seeds != null) data = seeds.optJSONObject(id);
                if (data != null && data.has("schedules")) snapshots.put(id, data);
            }
            state.put("snapshots", snapshots);
            ScheduleNotifications.reconcile(context, state);
            store.write(state);
            return state;
        }
    }

    public static JSONObject refresh(Context context, PoweronClient client, String onlyId, boolean background, BooleanSupplier stopped) throws Exception {
        synchronized (RUN_LOCK) {
            SyncStore store = new SyncStore(context);
            JSONObject initial;
            synchronized (SyncStore.LOCK) { initial = store.read(); }
            if (background && !initial.optBoolean("enabled", true)) return initial;
            long revision = initial.optLong("revision"), deadline = System.currentTimeMillis() + 8 * 60000;
            JSONArray addresses = SyncStore.addresses(initial);
            int failures = 0, completed = 0;
            for (int i = 0; i < addresses.length(); i++) {
                if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted() || System.currentTimeMillis() > deadline) break;
                JSONObject address = addresses.getJSONObject(i);
                String id = address.getString("id");
                if (onlyId != null && !onlyId.equals(id)) continue;
                try {
                    String day = ScheduleLogic.today(System.currentTimeMillis());
                    JSONObject next = client.load(address, day, System.currentTimeMillis());
                    if (!day.equals(ScheduleLogic.today(System.currentTimeMillis()))) throw new IllegalStateException("Змінилася дата — потрібна повторна перевірка");
                    synchronized (SyncStore.LOCK) {
                        JSONObject current = store.read();
                        if (current.optLong("revision") != revision || stopped.getAsBoolean()) return current;
                        JSONObject snapshots = SyncStore.snapshots(current), previous = snapshots.optJSONObject(id);
                        boolean changed = ScheduleLogic.changed(previous, next, day);
                        snapshots.put(id, next);
                        current.put("snapshots", snapshots);
                        ScheduleNotifications.reconcile(context, current);
                        store.write(current);
                        if (changed && current.optBoolean("notifyChanges", true)) {
                            ScheduleNotifications.show(context, ScheduleNotifications.UPDATES, "updates:" + id,
                                "Світло: графік оновлено", address.optString("label") + ". Змінилися дані графіка на сьогодні або завтра. Відкрийте Svitlo, щоб переглянути.");
                        }
                    }
                    completed++;
                } catch (Exception error) {
                    failures++;
                    synchronized (SyncStore.LOCK) {
                        JSONObject current = store.read();
                        if (current.optLong("revision") != revision || stopped.getAsBoolean()) return current;
                        JSONObject snapshots = SyncStore.snapshots(current), previous = snapshots.optJSONObject(id);
                        if (previous == null) previous = new JSONObject();
                        previous.put("stale", true).put("error", error.getMessage() == null ? "Немає зв’язку з обленерго" : error.getMessage());
                        snapshots.put(id, previous);
                        current.put("snapshots", snapshots);
                        store.write(current); // Keep the last valid alarms when the network is unavailable.
                    }
                }
            }
            synchronized (SyncStore.LOCK) {
                JSONObject current = store.read();
                if (current.optLong("revision") != revision) return current;
                if (background) {
                    current.put("lastBackgroundCheck", System.currentTimeMillis()).put("backgroundFailures", failures);
                    if (completed > 0) current.put("lastBackgroundSuccess", System.currentTimeMillis());
                }
                store.write(current);
                return current;
            }
        }
    }
}
