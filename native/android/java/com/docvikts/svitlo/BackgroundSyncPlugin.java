package com.docvikts.svitlo;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "BackgroundSync")
public class BackgroundSyncPlugin extends Plugin {
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    @PluginMethod public void configure(PluginCall call) {
        try {
            JSONObject state = SyncEngine.configure(getContext(), call.getArray("addresses", new JSArray()),
                call.getInt("lead", 30), call.getBoolean("enabled", true), call.getBoolean("notifyChanges", true), call.getObject("seeds"));
            BackgroundWork.configure(getContext(), state);
            call.resolve(new JSObject(state.toString()));
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod public void refresh(PluginCall call) {
        String id = call.getString("addressId");
        IO.execute(() -> {
            try {
                JSONObject state = SyncEngine.refresh(getContext(), new PoweronClient(), id, false, () -> false);
                call.resolve(new JSObject(state.toString()));
            } catch (Exception error) { call.reject(error.getMessage(), error); }
        });
    }

    @PluginMethod public void getState(PluginCall call) {
        try { synchronized (SyncStore.LOCK) { call.resolve(new JSObject(new SyncStore(getContext()).read().toString())); } }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod public void test(PluginCall call) {
        try { BackgroundWork.once(getContext(), true); call.resolve(); }
        catch (Exception error) { call.reject(error.getMessage(), error); }
    }

    @PluginMethod public void openSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception error) { call.reject(error.getMessage(), error); }
    }
}
