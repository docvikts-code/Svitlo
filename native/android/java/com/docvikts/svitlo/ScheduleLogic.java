package com.docvikts.svitlo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** Pure schedule logic shared by the worker, bridge and JVM regression tests. */
public final class ScheduleLogic {
    private ScheduleLogic() {}
    // The legacy IANA alias is also present in older Android timezone databases.
    public static final TimeZone KYIV = TimeZone.getTimeZone("Europe/Kiev");

    public static String today(long now) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        format.setTimeZone(KYIV);
        return format.format(new Date(now));
    }

    public static String addDays(String day, int amount) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        format.setLenient(false);
        Calendar calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        calendar.setTime(format.parse(day));
        calendar.add(Calendar.DATE, amount);
        return format.format(calendar.getTime());
    }

    public static long atKyiv(String day, int minute) throws Exception {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ROOT);
        format.setTimeZone(KYIV);
        format.setLenient(false);
        return format.parse(day + " " + time(minute)).getTime();
    }

    public static String time(int minute) {
        return String.format(Locale.ROOT, "%02d:%02d", minute / 60, minute % 60);
    }

    public static List<String> groups(JSONObject response) throws JSONException {
        JSONArray rows = response.getJSONArray("buildingGroups");
        List<String> result = new ArrayList<>();
        for (int i = 0; i < rows.length(); i++) {
            String group = rows.getJSONObject(i).optString("chergGpv", "").trim();
            if (group.matches("\\d+(?:\\.\\d+)?(?:#[^\\s]+)?") && !result.contains(group)) result.add(group);
        }
        return result;
    }

    public static JSONObject parse(Object response, List<String> groups, String day) throws Exception {
        JSONArray rows;
        if (response instanceof JSONArray) rows = (JSONArray) response;
        else {
            JSONObject object = (JSONObject) response;
            rows = object.optJSONArray("hydra:member");
            if (rows == null) rows = object.getJSONArray("member");
        }
        JSONObject schedules = new JSONObject();
        for (String group : groups) schedules.put(group, new JSONObject());
        String tomorrow = addDays(day, 1);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject record = rows.getJSONObject(i);
            String date = record.optString("dateGraph", "");
            if (date.length() < 10) continue;
            date = date.substring(0, 10);
            if (!date.equals(day) && !date.equals(tomorrow)) continue;
            Object raw = record.opt("dataJson");
            JSONObject data = raw instanceof String ? new JSONObject((String) raw) : raw instanceof JSONObject ? (JSONObject) raw : null;
            if (data == null) continue;
            for (String group : groups) {
                JSONObject queue = data.optJSONObject(group);
                JSONObject times = queue == null ? null : queue.optJSONObject("times");
                if (times == null) continue;
                JSONArray slots = new JSONArray();
                for (int slot = 0; slot < 48; slot++) {
                    Object value = times.opt(time(slot * 30));
                    Integer state = state(value);
                    slots.put(state == null ? JSONObject.NULL : state);
                }
                JSONObject days = schedules.getJSONObject(group);
                JSONObject previous = days.optJSONObject(date);
                String stamp = record.optString("dateCreate", "");
                // API dateCreate uses ISO timestamps in one consistent source clock.
                if (previous != null && previous.optString("updatedAt", "").compareTo(stamp) > 0) continue;
                days.put(date, new JSONObject().put("slots", slots).put("updatedAt", stamp));
            }
        }
        return schedules;
    }

    static Integer state(Object value) {
        if (value == null || value == JSONObject.NULL || value instanceof Boolean) return null;
        String text = value.toString();
        return text.equals("0") ? 0 : text.equals("1") ? 1 : text.equals("10") ? 10 : null;
    }

    static List<String> keys(JSONObject object) {
        List<String> keys = new ArrayList<>();
        if (object != null) { Iterator<String> iterator = object.keys(); while (iterator.hasNext()) keys.add(iterator.next()); }
        Collections.sort(keys);
        return keys;
    }

    /** Ignore revision timestamps, JSON ordering and the removal of yesterday at midnight. */
    public static boolean changed(JSONObject previous, JSONObject next, String today) throws Exception {
        if (previous == null || !previous.has("schedules")) return false; // First fetch establishes a baseline.
        JSONObject before = previous.getJSONObject("schedules"), after = next.getJSONObject("schedules");
        if (!keys(before).equals(keys(after))) return true;
        for (String group : keys(after)) {
            for (String day : new String[] { today, addDays(today, 1) }) {
                JSONArray a = slots(before, group, day), b = slots(after, group, day);
                for (int i = 0; i < 48; i++) {
                    Integer x = state(a == null ? null : a.opt(i)), y = state(b == null ? null : b.opt(i));
                    if (x == null ? y != null : !x.equals(y)) return true;
                }
            }
        }
        return false;
    }

    static JSONArray slots(JSONObject schedules, String group, String day) {
        JSONObject days = schedules.optJSONObject(group), data = days == null ? null : days.optJSONObject(day);
        return data == null ? null : data.optJSONArray("slots");
    }

    public static JSONArray alerts(JSONArray addresses, JSONObject snapshots, int lead, long now) throws Exception {
        List<JSONObject> events = new ArrayList<>();
        String today = today(now);
        for (int n = 0; n < addresses.length(); n++) {
            JSONObject address = addresses.getJSONObject(n), snapshot = snapshots.optJSONObject(address.getString("id"));
            JSONObject schedules = snapshot == null ? null : snapshot.optJSONObject("schedules");
            if (schedules == null) continue;
            for (String group : keys(schedules)) {
                for (String date : new String[] { today, addDays(today, 1) }) {
                    JSONArray values = slots(schedules, group, date);
                    if (values == null) continue;
                    for (int slot = 0; slot < 48; slot++) {
                        Integer value = state(values.opt(slot));
                        if (value == null || value == 0) continue;
                        JSONArray prevDay = slot == 0 ? slots(schedules, group, addDays(date, -1)) : values;
                        Integer previous = state(prevDay == null ? null : prevDay.opt(slot == 0 ? 47 : slot - 1));
                        if (previous != null && previous != 0) continue; // possible → definite is one event.
                        long outage;
                        try { outage = atKyiv(date, slot * 30); } catch (Exception gap) { continue; }
                        long at = outage - lead * 60000L;
                        if (at <= now + 5000) continue;
                        String key = address.getString("id") + "|" + group + "|" + date + "|" + slot;
                        events.add(new JSONObject().put("key", key).put("addressId", address.getString("id"))
                            .put("at", at).put("outageAt", outage).put("title", "Світло: скоро відключення")
                            .put("body", address.optString("label") + ", підчерга " + group + ": "
                                + (value == 1 ? "відключення" : "можливе відключення") + " о " + time(slot * 30)
                                + " (за останнім отриманим графіком)."));
                    }
                }
            }
        }
        Collections.sort(events, (a, b) -> Long.compare(a.optLong("at"), b.optLong("at")));
        JSONArray result = new JSONArray();
        for (JSONObject event : events.subList(0, Math.min(60, events.size()))) result.put(event);
        return result;
    }
}
