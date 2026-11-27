package com.docvikts.svitlo;

import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import static org.junit.Assert.*;

public class ScheduleLogicTest {
    static final String DAY = "2026-11-20";
    static JSONObject record(String group, JSONObject times, String date) throws Exception {
        return new JSONObject().put("dateGraph", date + "T00:00:00Z").put("dateCreate", DAY + "T10:33:18Z")
            .put("dataJson", new JSONObject().put(group, new JSONObject().put("times", times)));
    }
    static JSONObject snapshot(JSONObject schedules) throws Exception { return new JSONObject().put("schedules", schedules); }
    static JSONObject schedules(String group, String date, int value) throws Exception {
        JSONArray slots = new JSONArray(); for (int i = 0; i < 48; i++) slots.put(value);
        return new JSONObject().put(group, new JSONObject().put(date, new JSONObject().put("slots", slots).put("updatedAt", "stamp")));
    }
    @Test public void exactGroupAndUnknownValues() throws Exception {
        JSONObject times = new JSONObject().put("00:00", "1").put("00:30", "10").put("01:00", JSONObject.NULL)
            .put("01:30", "").put("02:00", false).put("02:30", "0").put("03:15", "1");
        JSONObject payload = new JSONObject().put("hydra:member", new JSONArray().put(record("2.1", times, DAY)));
        JSONObject result = ScheduleLogic.parse(payload, Arrays.asList("1.1", "2.1"), DAY);
        assertEquals(0, result.getJSONObject("1.1").length());
        JSONArray slots = result.getJSONObject("2.1").getJSONObject(DAY).getJSONArray("slots");
        assertEquals(48, slots.length()); assertEquals(1, slots.getInt(0)); assertEquals(10, slots.getInt(1));
        assertTrue(slots.isNull(2)); assertTrue(slots.isNull(3)); assertTrue(slots.isNull(4)); assertEquals(0, slots.getInt(5));
    }
    @Test public void exactGroupsAndDuplicates() throws Exception {
        JSONObject response = new JSONObject().put("buildingGroups", new JSONArray()
            .put(new JSONObject().put("chergGpv", " 2.1 ")).put(new JSONObject().put("chergGpv", "2.1"))
            .put(new JSONObject().put("chergGpv", "3.1#2")).put(new JSONObject().put("chergGpv", "Не входить")));
        assertEquals(Arrays.asList("2.1", "3.1#2"), ScheduleLogic.groups(response));
    }
    @Test(expected = Exception.class) public void malformedPayloadIsNotAnEmptySchedule() throws Exception {
        ScheduleLogic.parse(new JSONObject().put("error", "unavailable"), Arrays.asList("2.1"), DAY);
    }
    @Test public void firstFetchIsSilentAndRevisionOnlyIsSilent() throws Exception {
        JSONObject next = snapshot(schedules("2.1", DAY, 0));
        assertFalse(ScheduleLogic.changed(null, next, DAY));
        JSONObject old = new JSONObject(next.toString());
        next.getJSONObject("schedules").getJSONObject("2.1").getJSONObject(DAY).put("updatedAt", "a new timestamp");
        assertFalse(ScheduleLogic.changed(old, next, DAY));
    }
    @Test public void actualChangeNewTomorrowAndWithdrawalAreDetected() throws Exception {
        JSONObject old = snapshot(schedules("2.1", DAY, 0)), next = snapshot(schedules("2.1", DAY, 0));
        next.getJSONObject("schedules").getJSONObject("2.1").getJSONObject(DAY).getJSONArray("slots").put(27, 1);
        assertTrue(ScheduleLogic.changed(old, next, DAY));
        next = snapshot(schedules("2.1", DAY, 0));
        next.getJSONObject("schedules").getJSONObject("2.1").put("2026-11-21", schedules("2.1", "2026-11-21", 0).getJSONObject("2.1").getJSONObject("2026-11-21"));
        assertTrue(ScheduleLogic.changed(old, next, DAY));
        assertTrue(ScheduleLogic.changed(old, snapshot(new JSONObject().put("2.1", new JSONObject())), DAY));
    }
    @Test public void midnightAndJsonOrderDoNotProduceFalseUpdates() throws Exception {
        JSONObject before = schedules("2.1", DAY, 1);
        before.getJSONObject("2.1").put("2026-11-21", schedules("2.1", "2026-11-21", 0).getJSONObject("2.1").getJSONObject("2026-11-21"));
        JSONObject after = schedules("2.1", "2026-11-21", 0);
        assertFalse(ScheduleLogic.changed(snapshot(before), snapshot(after), "2026-11-21"));
    }
    @Test public void kyivClockAndSeasonalOffsets() throws Exception {
        assertEquals(2 * 3600000L, new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.ROOT) {{ setTimeZone(java.util.TimeZone.getTimeZone("UTC")); }}
            .parse("2026-11-20 13:00").getTime() - ScheduleLogic.atKyiv(DAY, 780));
        assertEquals(3 * 3600000L, new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.ROOT) {{ setTimeZone(java.util.TimeZone.getTimeZone("UTC")); }}
            .parse("2026-07-20 13:00").getTime() - ScheduleLogic.atKyiv("2026-07-20", 780));
        assertEquals("2027-01-01", ScheduleLogic.addDays("2026-12-31", 1));
    }
    @Test public void alertsAreReplannedAndPossibleToDefiniteIsOneEvent() throws Exception {
        long now = ScheduleLogic.atKyiv(DAY, 600);
        JSONObject schedule = schedules("2.1", DAY, 0);
        JSONArray slots = schedule.getJSONObject("2.1").getJSONObject(DAY).getJSONArray("slots");
        slots.put(26, 10).put(27, 1).put(28, 1);
        JSONObject address = new JSONObject().put("id", "a").put("label", "Тест");
        JSONObject cache = new JSONObject().put("a", snapshot(schedule));
        JSONArray alerts = ScheduleLogic.alerts(new JSONArray().put(address), cache, 30, now);
        assertEquals(1, alerts.length()); assertEquals(ScheduleLogic.atKyiv(DAY, 750), alerts.getJSONObject(0).getLong("at"));
        slots.put(26, 0).put(27, 0).put(28, 0);
        assertEquals(0, ScheduleLogic.alerts(new JSONArray().put(address), cache, 30, now).length());
        assertEquals(0, ScheduleLogic.alerts(new JSONArray(), cache, 30, now).length());
    }
}
