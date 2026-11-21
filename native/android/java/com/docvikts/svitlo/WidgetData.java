package com.docvikts.svitlo;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exact address/group selection and display state; never guesses a group's identity. */
public final class WidgetData {
    public String addressId, group, address = "Виберіть адресу", title = "Налаштуйте віджет";
    public String note = "Торкніться, щоб вибрати адресу", time = "—", next = "", remaining = "", checked = "Відкрийте Svitlo";
    public Integer value;
    public JSONArray slots;
    public boolean configured, stale = true;
    public int minute;

    static String clock(long now) {
        SimpleDateFormat f = new SimpleDateFormat("HH:mm", Locale.ROOT); f.setTimeZone(ScheduleLogic.KYIV); return f.format(new Date(now));
    }
    static String stamp(long now) {
        SimpleDateFormat f = new SimpleDateFormat("dd.MM HH:mm", Locale.ROOT); f.setTimeZone(ScheduleLogic.KYIV); return f.format(new Date(now));
    }
    static String label(Integer v) { return v == null ? "немає даних" : v == 0 ? "світло за графіком" : v == 1 ? "відключення" : "можливе відключення"; }

    public static WidgetData from(JSONObject state, String id, String group, long now) {
        WidgetData m = new WidgetData(); m.addressId = id; m.group = group;
        if (id == null || group == null || group.isEmpty()) return m;
        JSONObject address = SyncStore.address(state, id);
        if (address == null) { m.title = "Адресу видалено"; m.note = "Виберіть іншу адресу"; return m; }
        m.address = address.optString("label");
        JSONObject snapshot = SyncStore.snapshots(state).optJSONObject(id);
        JSONObject schedules = snapshot == null ? null : snapshot.optJSONObject("schedules");
        if (schedules == null) { m.title = "Немає графіка"; m.note = "Оновіть дані в Svitlo"; return m; }
        if (!schedules.has(group)) { m.title = "Підчерга змінилася"; m.note = "Виберіть підчергу заново"; return m; }
        m.configured = true;
        long fetched = snapshot.optLong("fetchedAt");
        if (fetched > 0) m.checked = "Перевірено: " + stamp(fetched);
        String today = ScheduleLogic.today(now);
        m.slots = ScheduleLogic.slots(schedules, group, today);
        m.minute = Integer.parseInt(clock(now).substring(0, 2)) * 60 + Integer.parseInt(clock(now).substring(3));
        m.stale = snapshot.optBoolean("stale", true) || fetched <= 0 || now - fetched > 15 * 60000L || !today.equals(snapshot.optString("date"));
        if (m.stale) { m.title = "Дані застаріли"; m.note = "Актуальність не підтверджена"; m.next = "Оновіть графік"; return m; }
        m.value = ScheduleLogic.state(m.slots == null ? null : m.slots.opt(m.minute / 30));
        if (m.value == null) { m.title = "Немає даних"; m.note = "Графік ще не опубліковано"; return m; }
        m.title = m.value == 0 ? "Світло є" : m.value == 1 ? "Відключення" : "Можливе відключення";
        m.note = "За графіком на " + clock(now);
        try {
            JSONArray tomorrow = ScheduleLogic.slots(schedules, group, ScheduleLogic.addDays(today, 1));
            for (int i = m.minute / 30 + 1; i < 96; i++) {
                JSONArray day = i < 48 ? m.slots : tomorrow;
                Integer value = ScheduleLogic.state(day == null ? null : day.opt(i % 48));
                if (m.value.equals(value)) continue;
                if (value == null) { m.next = "Далі немає даних"; return m; }
                m.time = ScheduleLogic.time((i % 48) * 30);
                m.next = (i >= 48 ? "Завтра: " : "") + label(value);
                int minutes = i * 30 - m.minute;
                m.remaining = "через " + (minutes >= 60 ? minutes / 60 + " год " : "") + minutes % 60 + " хв";
                return m;
            }
            m.next = "Наступних змін немає";
        } catch (Exception ignored) { m.next = "Далі немає даних"; }
        return m;
    }
}
