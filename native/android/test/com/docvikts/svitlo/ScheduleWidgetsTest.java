package com.docvikts.svitlo;

import android.app.Application;
import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ApplicationProvider;
import androidx.work.Data;
import androidx.work.ListenableWorker;
import androidx.work.WorkerParameters;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.TestWorkerBuilder;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAppWidgetManager;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class ScheduleWidgetsTest {
    Context context; AppWidgetManager manager; ShadowAppWidgetManager shadow; static PoweronClient fake;
    @Before public void setup() throws Exception {
        context = ApplicationProvider.getApplicationContext(); manager = AppWidgetManager.getInstance(context); shadow = Shadows.shadowOf(manager);
        context.getSharedPreferences("svitlo.widgets.v1", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("svitlo.background.v1", Context.MODE_PRIVATE).edit().clear().commit();
        JSONObject state = WidgetDataTest.state(System.currentTimeMillis());
        String today = ScheduleLogic.today(System.currentTimeMillis());
        JSONObject schedules = state.getJSONObject("snapshots").getJSONObject("a").getJSONObject("schedules");
        for (String group : ScheduleLogic.keys(schedules)) {
            JSONArray slots = new JSONArray(); for (int i = 0; i < 48; i++) slots.put(group.equals("2.1") ? 0 : 1);
            schedules.put(group, new JSONObject().put(today, new JSONObject().put("slots", slots)));
        }
        state.getJSONObject("snapshots").getJSONObject("a").put("date", today);
        state.getJSONObject("snapshots").put("b", new JSONObject().put("date", today).put("fetchedAt", System.currentTimeMillis()).put("stale", false)
            .put("schedules", new JSONObject().put("4.1", schedules.getJSONObject("2.1"))));
        new SyncStore(context).write(state);
    }
    void bind(int id, boolean compact) {
        AppWidgetProviderInfo info = new AppWidgetProviderInfo();
        info.provider = new ComponentName(context, compact ? CompactWidgetProvider.class : ScheduleWidgetProvider.class);
        info.initialLayout = compact ? R.layout.widget_compact : R.layout.widget_wide;
        shadow.addBoundWidget(id, info);
    }
    String text(int id, int view) { return ((TextView) shadow.getViewFor(id).findViewById(view)).getText().toString(); }
    @Test public void twoWidgetsKeepIndependentExactSelectionsAndRenderRealRemoteViews() {
        bind(11, false); bind(12, true);
        assertTrue(ScheduleWidgets.choose(context, 11, "a", "3.1")); assertTrue(ScheduleWidgets.choose(context, 12, "b", "4.1"));
        assertEquals("Відключення", text(11, R.id.widget_status)); assertEquals("Світло є", text(12, R.id.widget_status));
        assertTrue(text(11, R.id.widget_address).contains("3.1")); assertTrue(text(12, R.id.widget_address).contains("4.1"));
        assertNotNull(shadow.getViewFor(11).findViewById(R.id.widget_timeline));
        assertNull(shadow.getViewFor(12).findViewById(R.id.widget_timeline));
        assertFalse(ScheduleWidgets.choose(context, 11, "a", "9.9"));
        assertEquals("3.1", ScheduleWidgets.preferences(context).getString("11:group", ""));
    }
    @Test public void sharedCacheUpdatesRenderOfflineAndRemovedAddressStates() throws Exception {
        bind(11, false); bind(12, true); ScheduleWidgets.choose(context, 11, "a", "2.1"); ScheduleWidgets.choose(context, 12, "b", "4.1");
        JSONObject state = new SyncStore(context).read(); state.getJSONObject("snapshots").getJSONObject("a").put("stale", true); new SyncStore(context).write(state);
        assertEquals("Дані застаріли", text(11, R.id.widget_status)); assertEquals("Світло є", text(12, R.id.widget_status));
        state.put("addresses", new JSONArray().put(state.getJSONArray("addresses").getJSONObject(1))); new SyncStore(context).write(state);
        assertEquals("Адресу видалено", text(11, R.id.widget_status)); assertEquals("Світло є", text(12, R.id.widget_status));
    }
    @Test public void missingSelectionCannotDisplayFirstAddressAndDeleteCleansOnlyThatWidget() {
        bind(11, false); bind(12, true); ScheduleWidgets.choose(context, 12, "b", "4.1"); ScheduleWidgets.updateAll(context);
        assertEquals("Налаштуйте віджет", text(11, R.id.widget_status));
        new ScheduleWidgetProvider().onDeleted(context, new int[] { 11 });
        assertEquals("b", ScheduleWidgets.preferences(context).getString("12:address", null));
    }
    @Test public void widgetTapTargetsItsOwnAddressOrItsConfiguration() {
        bind(11, false);
        JSONObject state = new SyncStore(context).read();
        WidgetData data = WidgetData.from(state, "b", "4.1", System.currentTimeMillis());
        Intent open = Shadows.shadowOf(ScheduleWidgets.open(context, 11, data)).getSavedIntent();
        assertEquals(MainActivity.class.getName(), open.getComponent().getClassName());
        assertEquals("b", open.getStringExtra("svitlo.widget.address"));
        WidgetData empty = WidgetData.from(state, null, null, System.currentTimeMillis());
        Intent configure = Shadows.shadowOf(ScheduleWidgets.open(context, 11, empty)).getSavedIntent();
        assertEquals(WidgetConfigureActivity.class.getName(), configure.getComponent().getClassName());
        assertEquals(11, configure.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
    }
    @Test @Config(qualifiers = "night") public void darkThemeRendersNativeWidgetWithNightResources() {
        bind(12, true); assertTrue(ScheduleWidgets.choose(context, 12, "a", "2.1"));
        assertEquals(android.graphics.Color.parseColor("#15232C"), context.getColor(R.color.widget_surface));
        assertEquals("Світло є", text(12, R.id.widget_status));
        assertEquals(context.getColor(R.color.widget_on), ((TextView) shadow.getViewFor(12).findViewById(R.id.widget_status)).getCurrentTextColor());
    }
    public static class TestRefreshWorker extends WidgetRefreshWorker {
        public TestRefreshWorker(Context c, WorkerParameters p) { super(c, p); }
        @Override protected PoweronClient client() { return fake; }
    }
    @Test public void manualWidgetRefreshWorksWithAutomaticPollingDisabled() throws Exception {
        JSONObject state = new SyncStore(context).read(); state.put("enabled", false); new SyncStore(context).write(state);
        fake = new PoweronClient() { @Override public JSONObject load(JSONObject a, String d, long n) throws Exception {
            assertEquals("a", a.getString("id")); return new SyncStore(context).read().getJSONObject("snapshots").getJSONObject("a").put("fetchedAt", n).put("stale", false);
        }};
        TestRefreshWorker worker = TestWorkerBuilder.from(context, TestRefreshWorker.class, new SynchronousExecutor()).setInputData(new Data.Builder().putString("addressId", "a").build()).build();
        assertEquals(ListenableWorker.Result.success(), worker.doWork()); assertFalse(new SyncStore(context).read().getBoolean("enabled"));
    }
    @Test public void launcherConfigurationCommitsExactGroupAndReturnsWidgetId() {
        bind(11, false);
        WidgetConfigureActivity activity = Robolectric.buildActivity(WidgetConfigureActivity.class,
            new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 11)).create().resume().get();
        java.util.ArrayList<View> buttons = new java.util.ArrayList<>(); activity.getWindow().getDecorView().findViewsWithText(buttons, "Підчерга 3.1", View.FIND_VIEWS_WITH_TEXT);
        assertEquals(1, buttons.size()); assertTrue(buttons.get(0) instanceof Button); buttons.get(0).performClick();
        assertEquals(Activity.RESULT_OK, Shadows.shadowOf(activity).getResultCode());
        assertEquals(11, Shadows.shadowOf(activity).getResultIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1));
        assertEquals("3.1", ScheduleWidgets.preferences(context).getString("11:group", null));
    }
}
