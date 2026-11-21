package com.docvikts.svitlo;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/** One atomic JSON document, private to the app and shared with the worker process. */
public final class SyncStore {
    static final Object LOCK = new Object();
    private final SharedPreferences preferences;
    private final Context context;
    public SyncStore(Context context) { this.context = context.getApplicationContext(); preferences = context.getSharedPreferences("svitlo.background.v1", Context.MODE_PRIVATE); }
    JSONObject read() {
        try { return new JSONObject(preferences.getString("state", "{}")); }
        catch (Exception ignored) { return new JSONObject(); }
    }
    void write(JSONObject value) {
        if (!preferences.edit().putString("state", value.toString()).commit()) throw new IllegalStateException("Не вдалося зберегти графік");
        ScheduleWidgets.updateAll(context);
    }
    static JSONArray addresses(JSONObject state) { JSONArray result = state.optJSONArray("addresses"); return result == null ? new JSONArray() : result; }
    static JSONObject snapshots(JSONObject state) { JSONObject result = state.optJSONObject("snapshots"); return result == null ? new JSONObject() : result; }
    static JSONObject address(JSONObject state, String id) {
        JSONArray rows = addresses(state);
        for (int i = 0; i < rows.length(); i++) if (id.equals(rows.optJSONObject(i).optString("id"))) return rows.optJSONObject(i);
        return null;
    }
}
