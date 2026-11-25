package com.docvikts.svitlo;

import org.json.JSONArray;
import org.json.JSONObject;

/** Duration counts published half-hour slots, not measured electricity supply. */
public final class ScheduleComparison {
    private ScheduleComparison() {}
    static JSONArray values(JSONObject day) {
        return day == null ? null : day.optJSONArray("slots");
    }
    static boolean complete(JSONObject day) {
        JSONArray slots = values(day);
        if (slots == null || slots.length() != 48) return false;
        for (int i = 0; i < 48; i++) if (ScheduleLogic.state(slots.opt(i)) == null) return false;
        return true;
    }
    static boolean same(JSONObject a, JSONObject b) {
        JSONArray x = values(a), y = values(b);
        for (int i = 0; i < 48; i++) {
            Integer u = ScheduleLogic.state(x == null ? null : x.opt(i)), v = ScheduleLogic.state(y == null ? null : y.opt(i));
            if (u == null ? v != null : !u.equals(v)) return false;
        }
        return true;
    }
    static JSONObject totals(JSONArray slots) throws Exception {
        int on = 0, off = 0, maybe = 0;
        for (int i = 0; i < 48; i++) {
            Integer value = ScheduleLogic.state(slots.opt(i));
            if (value == null) throw new IllegalArgumentException("Неповний графік");
            if (value == 0) on += 30; else if (value == 1) off += 30; else maybe += 30;
        }
        return new JSONObject().put("on", on).put("off", off).put("maybe", maybe);
    }
    public static JSONObject attach(JSONObject previous, JSONObject next, long now) throws Exception {
        JSONObject old = previous == null ? null : previous.optJSONObject("schedules");
        if (old == null) old = new JSONObject();
        JSONObject current = next.getJSONObject("schedules");
        for (String group : ScheduleLogic.keys(current)) {
            JSONObject days = current.getJSONObject(group), oldDays = old.optJSONObject(group);
            for (String date : ScheduleLogic.keys(days)) {
                JSONObject day = days.getJSONObject(date), before = oldDays == null ? null : oldDays.optJSONObject(date);
                day.remove("comparison");
                boolean equal = before != null && same(before, day);
                day.put("observedAt", equal ? before.optLong("observedAt", previous.optLong("fetchedAt", now)) : now);
                if (!complete(before) || !complete(day)) continue;
                if (equal) {
                    if (before.optJSONObject("comparison") != null) day.put("comparison", new JSONObject(before.getJSONObject("comparison").toString()));
                    continue;
                }
                day.put("comparison", new JSONObject().put("changedAt", now)
                    .put("previousFetchedAt", before.optLong("observedAt", previous.optLong("fetchedAt", now)))
                    .put("previousUpdatedAt", before.opt("updatedAt") == null ? JSONObject.NULL : before.opt("updatedAt"))
                    .put("previousSlots", new JSONArray(values(before).toString()))
                    .put("before", totals(values(before))).put("after", totals(values(day))));
            }
        }
        return next;
    }
    public static String duration(int minutes) {
        if (minutes == 0) return "0 хв";
        return (minutes >= 60 ? minutes / 60 + " год" : "") + (minutes >= 60 && minutes % 60 != 0 ? " " : "") + (minutes % 60 != 0 ? minutes % 60 + " хв" : "");
    }
    public static String summary(JSONObject change) {
        JSONObject a = change.optJSONObject("before"), b = change.optJSONObject("after");
        if (a == null || b == null) return "Графік змінено";
        int delta = b.optInt("on") - a.optInt("on");
        if (delta != 0) return "Світла за графіком " + (delta > 0 ? "більше" : "менше") + " на " + duration(Math.abs(delta));
        return a.optInt("off") == b.optInt("off") && a.optInt("maybe") == b.optInt("maybe")
            ? "Години змінилися, тривалість світла — та сама" : "Тривалість світла за графіком — та сама";
    }
    static String shortText(JSONObject change) throws Exception {
        int delta = change.getJSONObject("after").optInt("on") - change.getJSONObject("before").optInt("on");
        return delta == 0 ? "Графік змінено" : (delta > 0 ? "+" : "−") + duration(Math.abs(delta)) + " світла";
    }
    static String notification(JSONObject previous, JSONObject next, String today) throws Exception {
        JSONObject old = previous == null ? null : previous.optJSONObject("schedules");
        StringBuilder result = new StringBuilder();
        JSONObject schedules = next.getJSONObject("schedules");
        for (String group : ScheduleLogic.keys(schedules)) {
            JSONObject days = schedules.getJSONObject(group);
            for (String day : new String[] { today, ScheduleLogic.addDays(today, 1) }) {
                JSONObject data = days.optJSONObject(day), change = data == null ? null : data.optJSONObject("comparison");
                JSONObject oldDays = old == null ? null : old.optJSONObject(group), before = oldDays == null ? null : oldDays.optJSONObject(day);
                if (change == null || !complete(before) || !complete(data) || same(before, data)) continue;
                if (result.length() > 0) result.append("\n");
                result.append(day.equals(today) ? "Сьогодні" : "Завтра").append(", підчерга ").append(group).append(": ").append(summary(change)).append(".");
            }
        }
        return result.toString();
    }
}
