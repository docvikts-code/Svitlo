package com.docvikts.svitlo;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class WidgetDataTest {
    static final String DAY = "2026-11-21";
    static long now() throws Exception { return ScheduleLogic.atKyiv(DAY, 728); }
    static JSONObject state(long now) throws Exception {
        JSONArray slots = new JSONArray();
        for (int i = 0; i < 48; i++) slots.put(i == 26 ? 10 : i >= 27 && i < 35 ? 1 : 0);
        JSONObject schedules = new JSONObject().put("2.1", new JSONObject().put(DAY, new JSONObject().put("slots", slots)))
            .put("3.1", new JSONObject().put(DAY, new JSONObject().put("slots", new JSONArray().put(1))));
        JSONObject snapshot = new JSONObject().put("date", DAY).put("fetchedAt", now).put("stale", false).put("schedules", schedules);
        return new JSONObject().put("addresses", new JSONArray().put(new JSONObject().put("id", "a").put("label", "Тестова адреса А"))
            .put(new JSONObject().put("id", "b").put("label", "Тестова адреса Б")))
            .put("snapshots", new JSONObject().put("a", snapshot));
    }
    @Test public void currentStateAndNextTransitionUseKyivTime() throws Exception {
        WidgetData m = WidgetData.from(state(now()), "a", "2.1", now());
        assertTrue(m.configured); assertFalse(m.stale); assertEquals(Integer.valueOf(0), m.value);
        assertEquals("13:00", m.time); assertEquals("через 52 хв", m.remaining); assertTrue(m.note.endsWith("12:08"));
    }
    @Test public void staleAndFailedSnapshotsCannotClaimCurrentPower() throws Exception {
        JSONObject state = state(now());
        WidgetData old = WidgetData.from(state, "a", "2.1", now() + 16 * 60000);
        assertTrue(old.stale); assertNull(old.value); assertEquals("Дані застаріли", old.title);
        state.getJSONObject("snapshots").getJSONObject("a").put("stale", true);
        assertTrue(WidgetData.from(state, "a", "2.1", now()).stale);
    }
    @Test public void wrongAddressAndChangedGroupNeverFallBackToAnotherGroup() throws Exception {
        JSONObject state = state(now());
        assertFalse(WidgetData.from(state, "b", "2.1", now()).configured);
        assertFalse(WidgetData.from(state, "deleted", "2.1", now()).configured);
        assertEquals("Підчерга змінилася", WidgetData.from(state, "a", "9.9", now()).title);
        assertEquals("Немає даних", WidgetData.from(state, "a", "3.1", now()).title);
    }
    @Test public void unknownNextSlotIsNotSkippedToAnAssuredOutage() throws Exception {
        JSONObject state = state(now());
        state.getJSONObject("snapshots").getJSONObject("a").getJSONObject("schedules").getJSONObject("2.1").getJSONObject(DAY).getJSONArray("slots").put(26, JSONObject.NULL);
        WidgetData m = WidgetData.from(state, "a", "2.1", now());
        assertEquals("Далі немає даних", m.next); assertEquals("—", m.time);
    }
    @Test public void midnightTransitionUsesTomorrowAndDoesNotInventAContinuation() throws Exception {
        long now = ScheduleLogic.atKyiv(DAY, 1430);
        JSONObject state = state(now), days = state.getJSONObject("snapshots").getJSONObject("a").getJSONObject("schedules").getJSONObject("2.1");
        days.put("2026-11-22", new JSONObject().put("slots", new JSONArray().put(1)));
        WidgetData m = WidgetData.from(state, "a", "2.1", now);
        assertEquals("00:00", m.time); assertTrue(m.next.startsWith("Завтра:")); assertEquals("через 10 хв", m.remaining);
        days.remove("2026-11-22");
        assertEquals("Далі немає даних", WidgetData.from(state, "a", "2.1", now).next);
    }
    @Test public void widgetUsesOwnTodayComparisonAndSuppressesItForStaleCache() throws Exception {
        JSONObject state = state(now());
        JSONObject previous = state.getJSONObject("snapshots").getJSONObject("a");
        JSONObject next = new JSONObject(previous.toString());
        next.getJSONObject("schedules").getJSONObject("2.1").getJSONObject(DAY).getJSONArray("slots").put(30, 0).put(31, 0);
        ScheduleComparison.attach(previous, next, now());
        state.getJSONObject("snapshots").put("a", next);
        assertEquals("+1 год світла", WidgetData.from(state, "a", "2.1", now()).change);
        assertEquals("", WidgetData.from(state, "b", "2.1", now()).change);
        next.put("stale", true);
        assertEquals("", WidgetData.from(state, "a", "2.1", now()).change);
    }

}
