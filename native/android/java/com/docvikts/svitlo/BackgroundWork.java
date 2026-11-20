package com.docvikts.svitlo;

import android.content.Context;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

public final class BackgroundWork {
    private BackgroundWork() {}
    static final String PERIODIC = "svitlo.periodic.v1", IMMEDIATE = "svitlo.refresh.v1", TEST = "svitlo.test.v1";
    static Constraints constraints() { return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(); }

    static void configure(Context context, JSONObject state) {
        WorkManager manager = WorkManager.getInstance(context);
        if (state.optBoolean("enabled", true) && SyncStore.addresses(state).length() > 0) {
            PeriodicWorkRequest work = new PeriodicWorkRequest.Builder(ScheduleSyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints()).setInitialDelay(15, TimeUnit.MINUTES)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES).build();
            manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, work);
        } else {
            manager.cancelUniqueWork(PERIODIC);
            manager.cancelUniqueWork(IMMEDIATE);
            manager.cancelUniqueWork(TEST);
        }
    }

    static void once(Context context, boolean test) {
        OneTimeWorkRequest.Builder work = new OneTimeWorkRequest.Builder(ScheduleSyncWorker.class)
            .setConstraints(constraints()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.MINUTES)
            .setInputData(new Data.Builder().putBoolean("test", test).build());
        if (test) work.setInitialDelay(30, TimeUnit.SECONDS);
        WorkManager.getInstance(context).enqueueUniqueWork(test ? TEST : IMMEDIATE,
            test ? ExistingWorkPolicy.REPLACE : ExistingWorkPolicy.KEEP, work.build());
    }
}
