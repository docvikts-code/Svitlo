package com.docvikts.svitlo;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

/** Launcher configuration picks an exact saved address and group for each widget instance. */
public class WidgetConfigureActivity extends Activity {
    int widgetId;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        setResult(RESULT_CANCELED);
        widgetId = getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        if (!ScheduleWidgets.owned(this, widgetId)) finish();
    }
    @Override public void onResume() {
        super.onResume();
        if (isFinishing()) return;
        ScrollView scroll = new ScrollView(this);
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        list.setPadding(padding, padding, padding, padding);
        list.setBackgroundColor(getColor(R.color.widget_surface));
        TextView title = new TextView(this); title.setText("Віджет Svitlo"); title.setTextSize(26); title.setTextColor(getColor(R.color.widget_ink)); list.addView(title);
        TextView description = new TextView(this); description.setText("Виберіть адресу й підчергу для цього віджета."); description.setTextSize(15); description.setTextColor(getColor(R.color.widget_muted)); description.setPadding(0, padding / 2, 0, padding); list.addView(description);
        JSONObject state;
        synchronized (SyncStore.LOCK) { state = new SyncStore(this).read(); }
        JSONArray addresses = SyncStore.addresses(state);
        int count = 0;
        for (int i = 0; i < addresses.length(); i++) {
            JSONObject address = addresses.optJSONObject(i);
            JSONObject snapshot = SyncStore.snapshots(state).optJSONObject(address.optString("id"));
            JSONObject schedules = snapshot == null ? null : snapshot.optJSONObject("schedules");
            for (String group : ScheduleLogic.keys(schedules)) {
                count++;
                Button option = new Button(this); option.setAllCaps(false); option.setText(address.optString("label") + "\nПідчерга " + group); option.setTextSize(15); option.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL); option.setPadding(padding / 2, padding / 2, padding / 2, padding / 2);
                LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); layout.bottomMargin = padding / 2;
                list.addView(option, layout);
                option.setOnClickListener(view -> {
                    if (ScheduleWidgets.choose(this, widgetId, address.optString("id"), group)) {
                        setResult(RESULT_OK, new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)); finish();
                    } else recreate();
                });
            }
        }
        if (count == 0) {
            TextView empty = new TextView(this); empty.setText("Спочатку додайте адресу й завантажте графік у Svitlo. Потім поверніться сюди."); empty.setTextColor(getColor(R.color.widget_ink)); empty.setTextSize(16); list.addView(empty);
        }
        Button open = new Button(this); open.setAllCaps(false); open.setText("Відкрити Svitlo"); open.setOnClickListener(view -> startActivity(new Intent(this, MainActivity.class))); list.addView(open);
        Button cancel = new Button(this); cancel.setAllCaps(false); cancel.setText("Скасувати"); cancel.setOnClickListener(view -> finish()); list.addView(cancel);
        scroll.addView(list); setContentView(scroll);
    }
}
