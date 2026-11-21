import { existsSync } from 'node:fs';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/@capacitor/cli/bin/capacitor', import.meta.url));
if (!existsSync('android')) execFileSync(process.execPath, [cli, 'add', 'android'], { stdio: 'inherit' });
execFileSync(process.execPath, [cli, 'sync', 'android'], { stdio: 'inherit' });
const path = 'android/app/src/main/AndroidManifest.xml';
let xml = await readFile(path, 'utf8');
for (const permission of ['POST_NOTIFICATIONS', 'SCHEDULE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED']) {
  if (!xml.includes(`android.permission.${permission}`)) {
    xml = xml.replace('<application', `<uses-permission android:name="android.permission.${permission}" />\n    <application`);
  }
}
if (!xml.includes('.OutageAlarmReceiver')) xml = xml.replace('</application>', `
        <receiver android:name=".OutageAlarmReceiver" android:exported="false" />
        <receiver android:name=".SyncRestartReceiver" android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.intent.action.TIME_SET" />
                <action android:name="android.intent.action.TIMEZONE_CHANGED" />
            </intent-filter>
        </receiver>
    </application>`);
if (!xml.includes('.ScheduleWidgetProvider')) xml = xml.replace('</application>', `
        <receiver android:name=".ScheduleWidgetProvider" android:exported="false" android:label="Світло · графік">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_wide_info" />
        </receiver>
        <receiver android:name=".CompactWidgetProvider" android:exported="false" android:label="Світло · компактний">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_compact_info" />
        </receiver>
        <activity android:name=".WidgetConfigureActivity" android:exported="true" android:theme="@android:style/Theme.DeviceDefault.DayNight" android:label="Віджет Svitlo">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_CONFIGURE" /></intent-filter>
        </activity>
    </application>`);
await writeFile(path, xml);
await cp('native/android/java', 'android/app/src/main/java', { recursive: true });
await cp('native/android/res', 'android/app/src/main/res', { recursive: true });
await cp('native/android/test', 'android/app/src/test/java', { recursive: true });
const gradlePath = 'android/app/build.gradle';
let gradle = await readFile(gradlePath, 'utf8');
if (!gradle.includes('background.gradle')) gradle += "\napply from: '../../native/android/background.gradle'\n";
await writeFile(gradlePath, gradle);
