package com.docvikts.svitlo;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** User requested refresh also works when automatic background polling is disabled. */
public class WidgetRefreshWorker extends Worker {
    public WidgetRefreshWorker(@NonNull Context c, @NonNull WorkerParameters p) { super(c, p); }
    static void enqueue(Context c, String id) {
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(WidgetRefreshWorker.class)
            .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInputData(new Data.Builder().putString("addressId", id).build()).build();
        WorkManager.getInstance(c).enqueueUniqueWork("svitlo.widget.refresh:" + id, ExistingWorkPolicy.KEEP, work);
    }
    protected PoweronClient client() { return new PoweronClient(); }
    @NonNull @Override public Result doWork() {
        String id = getInputData().getString("addressId");
        if (id == null) return Result.failure();
        try {
            synchronized (SyncStore.LOCK) { if (SyncStore.address(new SyncStore(getApplicationContext()).read(), id) == null) return Result.success(); }
            SyncEngine.refresh(getApplicationContext(), client(), id, false, this::isStopped);
            ScheduleWidgets.updateAll(getApplicationContext());
            return Result.success(); // A later user tap or periodic refresh retries a failed network request.
        } catch (Exception error) { ScheduleWidgets.updateAll(getApplicationContext()); return Result.failure(); }
    }
}
