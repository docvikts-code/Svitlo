package com.docvikts.svitlo;

import android.os.Bundle;
import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(state);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge != null) bridge.triggerWindowJSEvent("svitloWidgetOpen");
    }
}
