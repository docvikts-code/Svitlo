package com.docvikts.svitlo;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class ScheduleComparisonTest {
    static final String DAY = "2026-11-25";
    static JSONArray fixtures() throws Exception {
        try (java.io.InputStream input = ScheduleComparisonTest.class.getResourceAsStream("/comparison-cases.json")) {
            assertNotNull(input); return new JSONArray(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }
    static JSONObject snapshot(JSONArray slots, String group, String date) throws Exception {
        return new JSONObject().put("fetchedAt", 1000).put("schedules", new JSONObject().put(group,
            slots == null ? new JSONObject() : new JSONObject().put(date, new JSONObject().put("slots", new JSONArray(slots.toString())).put("updatedAt", "source"))));
    }
    static JSONObject change(JSONObject snapshot, String date) { return snapshot.optJSONObject("schedules").optJSONObject("2.1").optJSONObject(date).optJSONObject("comparison"); }
    @Test public void sharedFixturesMatchWebSemantics() throws Exception {
        JSONArray cases = fixtures();
        for (int i = 0; i < cases.length(); i++) {
            JSONObject fixture = cases.getJSONObject(i);
            JSONObject before = snapshot(fixture.optJSONArray("before"), "2.1", DAY), next = snapshot(fixture.getJSONArray("after"), "2.1", DAY);
            String untouched = before.toString();
            ScheduleComparison.attach(before, next, 2000);
            JSONObject change = change(next, DAY), expected = fixture.optJSONObject("expected");
            assertEquals(fixture.getString("name"), untouched, before.toString());
            if (expected == null) assertNull(fixture.getString("name"), change);
            else {
                assertNotNull(fixture.getString("name"), change);
                for (String key : new String[] { "on", "off", "maybe" }) assertEquals(fixture.getString("name") + key,
                    expected.getInt(key), change.getJSONObject("after").getInt(key) - change.getJSONObject("before").getInt(key));
                assertEquals(2000, change.getLong("changedAt"));
            }
        }
    }
    @Test public void unchangedPollAndJsonReloadKeepHistoryNextRevisionUsesImmediatePredecessor() throws Exception {
        JSONObject f = fixtures().getJSONObject(0);
        JSONObject before = snapshot(f.getJSONArray("before"), "2.1", DAY);
        JSONObject one = ScheduleComparison.attach(before, snapshot(f.getJSONArray("after"), "2.1", DAY), 2000);
        JSONObject same = ScheduleComparison.attach(new JSONObject(one.toString()), snapshot(f.getJSONArray("after"), "2.1", DAY), 3000);
        assertEquals(change(one, DAY).toString(), change(same, DAY).toString());
        JSONObject last = change(ScheduleComparison.attach(same, snapshot(f.getJSONArray("before"), "2.1", DAY), 4000), DAY);
        assertEquals(-90, last.getJSONObject("after").getInt("on") - last.getJSONObject("before").getInt("on"));
        assertEquals(2000, last.getLong("previousFetchedAt"));
    }
    @Test public void midnightAndOtherGroupsDoNotInventChangesOrRepeatNotification() throws Exception {
        JSONObject f = fixtures().getJSONObject(0);
        JSONObject before = snapshot(f.getJSONArray("before"), "2.1", "2026-11-26");
        JSONObject one = ScheduleComparison.attach(before, snapshot(f.getJSONArray("after"), "2.1", "2026-11-26"), 2000);
        JSONObject same = ScheduleComparison.attach(one, snapshot(f.getJSONArray("after"), "2.1", "2026-11-26"), 2000);
        assertEquals(2000, change(same, "2026-11-26").getLong("changedAt"));
        assertEquals("", ScheduleComparison.notification(one, same, "2026-11-26"));
        JSONObject other = ScheduleComparison.attach(before, snapshot(f.getJSONArray("after"), "3.1", "2026-11-26"), 2000);
        assertFalse(other.getJSONObject("schedules").getJSONObject("3.1").getJSONObject("2026-11-26").has("comparison"));
        assertNull(change(ScheduleComparison.attach(before, snapshot(f.getJSONArray("after"), "2.1", DAY), 2000), DAY));
    }
    @Test public void notificationNamesCorrectDayAndGroupAndDoesNotAggregateDifferentDays() throws Exception {
        JSONObject f = fixtures().getJSONObject(0), before = snapshot(f.getJSONArray("before"), "2.1", DAY);
        JSONObject next = ScheduleComparison.attach(before, snapshot(f.getJSONArray("after"), "2.1", DAY), 2000);
        String text = ScheduleComparison.notification(before, next, DAY);
        assertEquals("Сьогодні, підчерга 2.1: Світла за графіком більше на 1 год 30 хв.", text);
        assertEquals("+1 год 30 хв світла", ScheduleComparison.shortText(change(next, DAY)));
    }
    @Test public void dayComparisonMatchesSharedFixturesAndDoesNotCountPossibleOutagesAsPower() throws Exception {
        JSONArray cases = fixtures();
        int[] deltas = { 90, -90, 0, 0, 30 };
        for (int i = 0; i < deltas.length; i++) {
            JSONObject f = cases.getJSONObject(i);
            JSONObject result = ScheduleComparison.compareDays(new JSONObject().put("slots", f.getJSONArray("before")),
                new JSONObject().put("slots", f.getJSONArray("after")));
            assertEquals(deltas[i], result.getJSONObject("after").getInt("on") - result.getJSONObject("before").getInt("on"));
            for (String side : new String[] { "before", "after" }) {
                JSONObject totals = result.getJSONObject(side);
                assertEquals(1440, totals.getInt("on") + totals.getInt("off") + totals.getInt("maybe"));
            }
            if (deltas[i] == 0) assertEquals("Завтра стільки ж світла за графіком", ScheduleComparison.daySummary(result));
        }
    }
    @Test public void dayComparisonRejectsMissingPartialAndUnknownDays() throws Exception {
        JSONObject full = snapshot(fixtures().getJSONObject(0).getJSONArray("before"), "2.1", DAY)
            .getJSONObject("schedules").getJSONObject("2.1").getJSONObject(DAY);
        JSONObject unknown = new JSONObject(full.toString()); unknown.getJSONArray("slots").put(0, JSONObject.NULL);
        JSONObject shortDay = new JSONObject(full.toString()); shortDay.getJSONArray("slots").remove(47);
        for (JSONObject missing : new JSONObject[] { null, new JSONObject(), unknown, shortDay }) {
            assertNull(ScheduleComparison.compareDays(missing, full));
            assertNull(ScheduleComparison.compareDays(full, missing));
        }
    }
    @Test public void firstTomorrowPublicationAddsDaySummaryWithoutRepeatingOnUnchangedPollOrRollover() throws Exception {
        JSONObject f = fixtures().getJSONObject(0), before = snapshot(f.getJSONArray("before"), "2.1", DAY);
        JSONObject next = new JSONObject(before.toString());
        String tomorrow = ScheduleLogic.addDays(DAY, 1);
        next.getJSONObject("schedules").getJSONObject("2.1").put(tomorrow, new JSONObject().put("slots", f.getJSONArray("after")));
        String text = ScheduleComparison.notification(before, next, DAY);
        assertTrue(text.contains("Опубліковано графік на завтра, підчерга 2.1"));
        assertTrue(text.contains("Завтра світла за графіком більше на 1 год 30 хв"));
        assertTrue(text.contains("Можливі відключення: сьогодні 1 год, завтра 1 год"));
        assertEquals("", ScheduleComparison.notification(next, new JSONObject(next.toString()), DAY));
        assertEquals("", ScheduleComparison.notification(next, new JSONObject(next.toString()), tomorrow));
        assertEquals("", ScheduleComparison.notification(null, next, DAY));
        JSONObject missingToday = new JSONObject(next.toString());
        missingToday.getJSONObject("schedules").getJSONObject("2.1").remove(DAY);
        assertEquals("", ScheduleComparison.notification(before, missingToday, DAY));
        JSONObject wrongGroup = snapshot(f.getJSONArray("after"), "3.1", tomorrow);
        assertEquals("", ScheduleComparison.notification(before, wrongGroup, DAY));
    }
}
