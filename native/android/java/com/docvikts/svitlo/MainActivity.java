package com.docvikts.svitlo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(BackgroundSyncPlugin.class);
        super.onCreate(state);
    }
}
