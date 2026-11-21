package com.docvikts.svitlo;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONObject;

public class ScheduleSyncWorker extends Worker {
    public ScheduleSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    protected PoweronClient client() { return new PoweronClient(); }

    @NonNull @Override public Result doWork() {
        try {
            synchronized (SyncStore.LOCK) {
                JSONObject settings = new SyncStore(getApplicationContext()).read();
                if (!settings.optBoolean("enabled", true) || SyncStore.addresses(settings).length() == 0) return Result.success();
            }
            JSONObject state = SyncEngine.refresh(getApplicationContext(), client(), null, true, this::isStopped);
            if (isStopped()) return Result.retry();
            if (getInputData().getBoolean("test", false)) {
                boolean failed = state.optInt("backgroundFailures") > 0;
                ScheduleNotifications.show(getApplicationContext(), ScheduleNotifications.UPDATES, "background-test",
                    failed ? "Світло: фонова перевірка не завершена" : "Світло: фонова перевірка працює",
                    failed ? "Не вдалося отримати всі графіки. Перевірте інтернет і повторіть тест."
                        : "Графіки перевірено без відкритого екрана додатка.");
            }
            return state.optInt("backgroundFailures") > 0 ? Result.retry() : Result.success();
        } catch (Exception error) { return Result.retry(); }
    }
}
