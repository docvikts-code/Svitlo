package com.docvikts.svitlo;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import androidx.work.Configuration;
import androidx.work.ListenableWorker;
import androidx.work.WorkerParameters;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.TestWorkerBuilder;
import androidx.work.testing.WorkManagerTestInitHelper;
import androidx.work.WorkManager;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.json.JSONArray;
import org.json.JSONObject;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class BackgroundSyncTest {
    Context context;
    static PoweronClient fake;
    @Before public void setup() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("svitlo.background.v1", Context.MODE_PRIVATE).edit().clear().commit();
        Shadows.shadowOf(context.getSystemService(AlarmManager.class)).setCanScheduleExactAlarms(true);
        Shadows.shadowOf(context.getSystemService(NotificationManager.class)).setNotificationsEnabled(true);
        Shadows.shadowOf((android.app.Application) context).grantPermissions("android.permission.POST_NOTIFICATIONS");
        WorkManagerTestInitHelper.initializeTestWorkManager(context, new Configuration.Builder().setExecutor(new SynchronousExecutor()).build());
        configure(true, true);
    }
    JSONObject configure(boolean enabled, boolean notify) throws Exception {
        JSONArray addresses = new JSONArray().put(new JSONObject().put("id", "a").put("cityId", "136").put("streetId", "1334")
            .put("house", "1").put("label", "Тестова адреса"));
        return SyncEngine.configure(context, addresses, 30, enabled, notify, null);
    }
    static JSONObject snapshot(int value) throws Exception {
        String today = ScheduleLogic.today(System.currentTimeMillis());
        return new JSONObject().put("date", today).put("fetchedAt", System.currentTimeMillis()).put("stale", false)
            .put("schedules", ScheduleLogicTest.schedules("2.1", today, value));
    }
    public static class TestWorker extends ScheduleSyncWorker {
        public TestWorker(Context context, WorkerParameters parameters) { super(context, parameters); }
        @Override protected PoweronClient client() { return fake; }
    }
    TestWorker worker() { return TestWorkerBuilder.from(context, TestWorker.class, new SynchronousExecutor()).build(); }

    @Test public void workerUpdatesPrivateCacheWithoutWebViewAndNotifiesOnlyRealChanges() throws Exception {
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception { return snapshot(0); } };
        assertEquals(ListenableWorker.Result.success(), worker().doWork());
        assertEquals(0, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().size());
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception { return snapshot(1); } };
        assertEquals(ListenableWorker.Result.success(), worker().doWork());
        assertEquals(1, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().size());
        android.app.Notification firstNotice = Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().get(0);
        JSONObject state = new SyncStore(context).read();
        assertTrue(state.getLong("lastBackgroundSuccess") > 0);
        assertEquals(1, state.getJSONObject("snapshots").getJSONObject("a").getJSONObject("schedules").getJSONObject("2.1")
            .getJSONObject(ScheduleLogic.today(System.currentTimeMillis())).getJSONArray("slots").getInt(0));
        assertEquals(ListenableWorker.Result.success(), worker().doWork());
        assertEquals(1, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().size());
        assertSame(firstNotice, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().get(0));
    }
    @Test public void failedFetchKeepsLastGraphAndDoesNotAnnounceAnUpdate() throws Exception {
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception { return snapshot(0); } };
        worker().doWork();
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) { throw new IllegalStateException("offline"); } };
        assertEquals(ListenableWorker.Result.retry(), worker().doWork());
        JSONObject cached = new SyncStore(context).read().getJSONObject("snapshots").getJSONObject("a");
        assertTrue(cached.getBoolean("stale")); assertTrue(cached.has("schedules"));
        assertEquals(0, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().size());
    }
    @Test public void notificationToggleKeepsSyncButSuppressesUpdateNotice() throws Exception {
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception { return snapshot(0); } };
        worker().doWork(); configure(true, false);
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception { return snapshot(1); } };
        worker().doWork();
        assertEquals(0, Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications().size());
    }
    @Test public void disablingBackgroundStopsNetworkCalls() throws Exception {
        configure(false, true);
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) { throw new AssertionError("must not fetch"); } };
        assertEquals(ListenableWorker.Result.success(), worker().doWork());
    }
    @Test public void deletedAddressCannotBeRestoredByAnInFlightResult() throws Exception {
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception {
            SyncEngine.configure(context, new JSONArray(), 30, true, true, null);
            return snapshot(1);
        } };
        worker().doWork();
        JSONObject state = new SyncStore(context).read();
        assertEquals(0, SyncStore.addresses(state).length()); assertEquals(0, SyncStore.snapshots(state).length());
    }
    @Test public void periodicWorkIsUniqueAndRestoredAfterBoot() throws Exception {
        JSONObject state = new SyncStore(context).read();
        BackgroundWork.configure(context, state); BackgroundWork.configure(context, state);
        assertEquals(1, WorkManager.getInstance(context).getWorkInfosForUniqueWork(BackgroundWork.PERIODIC).get().size());
        new SyncRestartReceiver().onReceive(context, new Intent(Intent.ACTION_BOOT_COMPLETED));
        assertEquals(1, WorkManager.getInstance(context).getWorkInfosForUniqueWork(BackgroundWork.PERIODIC).get().size());
        assertEquals(1, WorkManager.getInstance(context).getWorkInfosForUniqueWork(BackgroundWork.IMMEDIATE).get().size());
    }
    @Test public void changedGraphAndRemovedAddressCancelTheirOldAlarms() throws Exception {
        String tomorrow = ScheduleLogic.addDays(ScheduleLogic.today(System.currentTimeMillis()), 1);
        JSONObject next = snapshot(0);
        JSONObject tomorrowData = ScheduleLogicTest.schedules("2.1", tomorrow, 0).getJSONObject("2.1").getJSONObject(tomorrow);
        tomorrowData.getJSONArray("slots").put(26, 1);
        next.getJSONObject("schedules").getJSONObject("2.1").put(tomorrow, tomorrowData);
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) { return next; } };
        worker().doWork();
        assertEquals(1, Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        tomorrowData.getJSONArray("slots").put(26, 0);
        worker().doWork();
        assertEquals(0, Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
        tomorrowData.getJSONArray("slots").put(26, 1);
        worker().doWork();
        SyncEngine.configure(context, new JSONArray(), 30, true, true, null);
        assertEquals(0, Shadows.shadowOf(context.getSystemService(AlarmManager.class)).getScheduledAlarms().size());
    }
    @Test public void nativeClientUsesAllGroupsAndUtf8AddressHeader() throws Exception {
        JSONObject address = new JSONObject().put("cityId", "136").put("streetId", "1334").put("house", "5/А");
        PoweronClient client = new PoweronClient() {
            int calls = 0;
            @Override public Object get(String path, String key) throws Exception {
                calls++;
                if (calls == 1) return new JSONObject().put("buildingGroups", new JSONArray()
                    .put(new JSONObject().put("chergGpv", "2.1")).put(new JSONObject().put("chergGpv", "3.1")));
                assertTrue(path.contains("group%5B%5D=2.1")); assertTrue(path.contains("group%5B%5D=3.1"));
                assertEquals("136/1334/5/А", new String(android.util.Base64.decode(key, android.util.Base64.DEFAULT), java.nio.charset.StandardCharsets.UTF_8));
                return new JSONObject().put("hydra:member", new JSONArray().put(ScheduleLogicTest.record("2.1", new JSONObject().put("13:30", "1"), "2026-11-20")));
            }
        };
        JSONObject result = client.load(address, "2026-11-20", System.currentTimeMillis());
        assertEquals(2, result.getJSONObject("schedules").length());
        assertEquals(0, result.getJSONObject("schedules").getJSONObject("3.1").length());
    }
}
