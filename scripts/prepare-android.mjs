import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
if (!existsSync('android')) execFileSync(npx, ['cap', 'add', 'android'], { stdio: 'inherit' });
execFileSync(npx, ['cap', 'sync', 'android'], { stdio: 'inherit' });
const path = 'android/app/src/main/AndroidManifest.xml';
let xml = await readFile(path, 'utf8');
for (const permission of ['POST_NOTIFICATIONS', 'SCHEDULE_EXACT_ALARM']) {
  if (!xml.includes(`android.permission.${permission}`)) {
    xml = xml.replace('<application', `<uses-permission android:name="android.permission.${permission}" />\n    <application`);
  }
}
await writeFile(path, xml);
