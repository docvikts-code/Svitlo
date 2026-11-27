import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createAppServer } from '../server.mjs';

// Fixed public API fixtures keep CI independent of outages at the provider.
// Run with SVITLO_LIVE_TEST=1 to additionally exercise the official API.
const live = process.env.SVITLO_LIVE_TEST === '1';
let offline = false;
let fixtureVersion = 0;
const fixtureFetch = async url => {
  if (offline) throw new TypeError('offline');
  const query = new URL(url).searchParams;
  const path = new URL(url).pathname;
  let data;
  if (path.endsWith('/pw_cities')) data = { 'hydra:member': [{ id: 136, name: 'Бережани', otg: { name: 'Бережанська' } }] };
  else if (path.endsWith('/pw_streets')) data = { 'hydra:member': [{ id: 1334, name: 'вул. Тараса Шевченка' }] };
  else if (path.endsWith('/building-names')) data = { buildingNames: [{ buildingName: '1', chergGpv: '2.1' }] };
  else if (path.endsWith('/building-groups')) data = { buildingGroups: [{ chergGpv: '2.1' }] };
  else if (path.endsWith('/a_gpv_g')) {
    const date = query.get('after').slice(0, 10);
    const times = Object.fromEntries(Array.from({ length: 48 }, (_, i) =>
      [`${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i === (fixtureVersion === 1 || fixtureVersion === 2 ? 29 : 26) ? '10' : i >= (fixtureVersion === 1 || fixtureVersion === 2 ? 30 : 27) && i < 35 ? '1' : '0']));
    data = { 'hydra:member': [{ dateGraph: `${date}T00:00:00Z`, dateCreate: `${date}T10:${fixtureVersion === 2 ? '30' : '00'}:00Z`, dataJson: { '2.1': { times } } }] };
  } else throw new Error(`Unexpected endpoint ${path}`);
  return Response.json(data);
};
const server = createAppServer({ fetchImpl: live ? fetch : fixtureFetch });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const page = await context.newPage();
  if (!live) await page.clock.setFixedTime(new Date('2026-11-21T10:08:00Z'));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.getByLabel('Назва, наприклад Бережани').fill('Бережани');
  await page.getByRole('button', { name: 'Бережани · Бережанська', exact: true }).click({ timeout: 45000 });
  await page.getByLabel('Назва вулиці', { exact: true }).fill('Тараса Шевченка');
  await page.getByRole('button', { name: 'вул. Тараса Шевченка', exact: true }).click({ timeout: 45000 });
  await page.getByLabel('Номер будинку', { exact: true }).fill('1');
  await page.getByRole('button', { name: '1', exact: true }).click({ timeout: 45000 });
  await page.getByRole('heading', { name: 'Підчерга 2.1', exact: true }).waitFor({ timeout: 60000 });
  assert.ok(await page.locator('table.intervals').count() > 0);
  assert.ok(await page.locator('.bar i').count() >= 48);
  if (!live) {
    assert.equal(await page.getByText(/Оновлення на сайті обленерго: .*10:00:00/).count(), 1);
    assert.equal(await page.getByText(/Оновлення джерела: .*\(Київ\)/).count(), 0);
  }
  assert.equal(await page.locator('#settingsDialog').evaluate(node => node.open), false);
  assert.equal(await page.locator('#lead').isVisible(), false);
  assert.equal(await page.locator('#addBtn').isVisible(), false);
  assert.match(await page.locator('.now-label').innerText(), /^\d{2}:\d{2}$/);
  if (!live) assert.equal(await page.locator('.now-label').innerText(), '12:08');
  assert.equal(await page.locator('#selectedAddressLabel').innerText(), 'Бережани, вул. Тараса Шевченка, 1');
  assert.equal(await page.locator('.current-interval').count(), 1);
  console.log(`PASS ${live ? 'live' : 'fixture'} address → queue → schedule; clean home and current-time marker`);

  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.setViewportSize({ width: 320, height: 740 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  for (const time of live ? [] : ['2026-11-21T22:01:00Z', '2026-11-21T21:59:00Z']) {
    await page.clock.setFixedTime(new Date(time));
    await page.getByRole('button', { name: 'Оновити графік', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    const bounds = await page.locator('.now-label').evaluate(node => {
      const label = node.getBoundingClientRect(), track = node.parentElement.getBoundingClientRect();
      return { left: label.left, right: label.right, start: track.left, end: track.right };
    });
    assert.ok(bounds.left >= bounds.start && bounds.right <= bounds.end, JSON.stringify(bounds));
  }
  if (!live) await page.clock.setFixedTime(new Date('2026-11-21T10:08:00Z'));
  await page.getByRole('button', { name: 'Оновити графік', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
  console.log('PASS mobile 390/320px and marker labels at both midnight edges');

  await page.setViewportSize({ width: 390, height: 844 });

  if (!live) {
    assert.equal(await page.locator('.schedule-change').count(), 0);
    fixtureVersion = 1;
    await page.getByRole('button', { name: 'Оновити графік', exact: true }).click();
    await page.getByText('Світла за графіком більше на 1 год 30 хв', { exact: true }).waitFor();
    await page.screenshot({ path: 'test-results/mobile-change.png', fullPage: true });
    await page.locator('.change-details summary').click();
    assert.equal(await page.locator('.change-details').evaluate(node => node.open), true);
    assert.equal(await page.locator('.mini-bar i').count(), 96);
    assert.equal(await page.locator('.comparison-row').count(), 3);
    await page.screenshot({ path: 'test-results/comparison-expanded.png', fullPage: true });
    fixtureVersion = 2;
    await page.getByRole('button', { name: 'Оновити графік', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    assert.equal(await page.locator('.change-details').evaluate(node => node.open), true);
    await page.reload();
    await page.getByText('Світла за графіком більше на 1 год 30 хв', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    fixtureVersion = 3;
    await page.getByRole('button', { name: 'Оновити графік', exact: true }).click();
    await page.getByText('Світла за графіком менше на 1 год 30 хв', { exact: true }).waitFor();
    await page.screenshot({ path: 'test-results/comparison-less.png', fullPage: true });
    console.log('PASS comparison: baseline silent, +90/−90 min, details, metadata poll and reload persistence');
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Налаштування', exact: true }).click();
  assert.equal(await page.locator('#lead').isVisible(), true);
  assert.equal(await page.locator('#addBtn').isVisible(), true);
  await page.locator('#lead').selectOption('60');
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settingsDialog').evaluate(node => node.open), false);
  assert.equal(await page.locator('#settingsBtn').evaluate(node => node === document.activeElement), true);
  console.log('PASS gear opens settings; preferences persist; Escape restores focus');

  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#refreshBtn').disabled, { timeout: 60000 });
  assert.equal(await page.locator('#addressSelect option').count(), 1);
  assert.equal(await page.locator('#lead').inputValue(), '60');
  console.log('PASS saved address survives reload');
  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await page.getByText('Актуальність графіка не підтверджена', { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#view .big').count(), 0);
  if (!live) assert.equal(await page.locator('.schedule-change[data-stale=true]').count(), 1);
  assert.ok(await page.locator('table.intervals').count() > 0);
  console.log('PASS failed refresh: labelled cache, no current-state claim');
  await context.close();

  const mock = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mock.addInitScript(() => {
    localStorage.setItem('addrs', JSON.stringify([
      { id: 'a', cityId: 1, streetId: 1, house: '1', label: 'Адреса А' },
      { id: 'b', cityId: 2, streetId: 2, house: '2', label: 'Адреса Б' },
    ]));
    localStorage.setItem('sel', JSON.stringify('a'));
  });
  const second = await mock.newPage();
  second.on('pageerror', e => errors.push(e.message));
  await second.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname.includes('building-groups')) {
      const first = url.searchParams.get('cityId') === '1';
      if (first) await new Promise(resolve => setTimeout(resolve, 900));
      data = { buildingGroups: first ? [{ chergGpv: '1.1' }] : [{ chergGpv: '2.1' }, { chergGpv: '3.1' }] };
    } else if (url.pathname.endsWith('/a_gpv_g')) {
      const date = url.searchParams.get('after').slice(0, 10);
      const groups = url.searchParams.getAll('group[]');
      const times = Object.fromEntries(Array.from({ length: 48 }, (_, i) =>
        [`${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i === 27 ? '1' : '0']));
      data = { 'hydra:member': [{ dateGraph: `${date}T00:00:00Z`, dateCreate: `${date}T10:00:00Z`,
        dataJson: Object.fromEntries(groups.map(group => [group, { times }])) }] };
    } else data = { 'hydra:member': [] };
    await route.fulfill({ json: data });
  });
  await second.goto(base);
  await second.locator('#addressSelect').selectOption('b');
  await second.getByRole('heading', { name: 'Підчерга 3.1', exact: true }).waitFor({ timeout: 10000 });
  // Wait for the slow, earlier address request to finish after the new selection.
  await second.waitForTimeout(1600);
  assert.equal(await second.locator('#addressSelect').inputValue(), 'b');
  assert.equal(await second.getByRole('heading', { name: 'Підчерга 1.1', exact: true }).count(), 0);
  assert.equal(await second.locator('.bar i').count(), 96);
  assert.equal(await second.locator('.schedule-change').count(), 0);
  assert.equal(await second.getByText('Графік для цієї підчерги ще не опубліковано.', { exact: true }).count(), 2);
  console.log('PASS concurrent address switching; separate groups; unknown tomorrow');
  await mock.close();

  if (!live) {
    const daily = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await daily.addInitScript(() => {
      localStorage.setItem('addrs', JSON.stringify([
        { id: 'a', cityId: 1, streetId: 1, house: '1', label: 'Адреса А' },
        { id: 'b', cityId: 2, streetId: 2, house: '2', label: 'Адреса Б' },
      ]));
      if (!localStorage.getItem('sel')) localStorage.setItem('sel', JSON.stringify('a'));
    });
    const screen = await daily.newPage();
    await screen.clock.setFixedTime(new Date('2026-11-27T10:08:00Z'));
    screen.on('pageerror', e => errors.push(e.message));
    let published = false, tomorrowOn = 27, partialToday = false, failed = false;
    const slots = (on, maybe) => Object.fromEntries(Array.from({ length: 48 }, (_, i) =>
      [`${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i < on ? '0' : i < on + maybe ? '10' : '1']));
    await screen.route('**/api/**', async route => {
      if (failed) { await route.abort(); return; }
      const url = new URL(route.request().url());
      let data;
      if (url.pathname.includes('building-groups')) data = { buildingGroups:
        (url.searchParams.get('cityId') === '1' ? ['2.1', '3.1'] : ['4.1']).map(chergGpv => ({ chergGpv })) };
      else if (url.pathname.endsWith('/a_gpv_g')) {
        const groups = url.searchParams.getAll('group[]');
        data = { 'hydra:member': (published ? ['2026-11-27', '2026-11-28'] : ['2026-11-27']).map(date => {
          const tomorrow = date === '2026-11-28';
          return { dateGraph: `${date}T00:00:00Z`, dateCreate: '2026-11-27T10:00:00Z',
            dataJson: Object.fromEntries(groups.map(group => {
              const times = group === '2.1' ? slots(tomorrow ? tomorrowOn : 24, tomorrow ? 3 : 2)
                : group === '3.1' ? slots(tomorrow ? 24 : 30, 0) : slots(tomorrow ? 44 : 40, 0);
              if (partialToday && !tomorrow && group === '2.1') delete times['00:00'];
              return [group, { times }];
            })) };
        }) };
      } else data = { 'hydra:member': [] };
      await route.fulfill({ json: data });
    });
    const refresh = async () => {
      await screen.getByRole('button', { name: 'Оновити графік', exact: true }).click();
      await screen.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    };
    const firstQueue = screen.getByRole('region', { name: 'Графіки підчерги 2.1', exact: true });
    await screen.goto(base);
    await screen.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    assert.equal(await screen.locator('.day-comparison').count(), 0);
    published = true;
    await refresh();
    await firstQueue.getByText('Завтра світла за графіком більше на 1 год 30 хв', { exact: true }).waitFor();
    assert.equal(await screen.locator('.day-comparison').count(), 2);
    assert.equal(await firstQueue.locator('.day').first().locator('.day-comparison').count(), 0);
    assert.equal(await firstQueue.locator('.day-comparison').getByText('12 год', { exact: true }).count(), 1);
    assert.equal(await firstQueue.locator('.day-comparison').getByText('13 год 30 хв', { exact: true }).count(), 1);
    assert.equal(await screen.getByText('Завтра світла за графіком менше на 3 год', { exact: true }).count(), 1);
    assert.ok((await firstQueue.locator('.day-comparison').innerText()).includes('Можливі відключення: сьогодні 1 год, завтра 1 год 30 хв.'));
    await firstQueue.locator('.day').nth(1).screenshot({ path: 'test-results/tomorrow-more.png' });
    await screen.setViewportSize({ width: 320, height: 740 });
    assert.ok(await screen.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await screen.emulateMedia({ colorScheme: 'dark' });
    await firstQueue.locator('.day').nth(1).screenshot({ path: 'test-results/tomorrow-dark.png' });
    await screen.setViewportSize({ width: 390, height: 844 });
    await screen.emulateMedia({ colorScheme: 'light' });
    await screen.reload();
    await firstQueue.getByText('Завтра світла за графіком більше на 1 год 30 хв', { exact: true }).waitFor();
    await screen.waitForFunction(() => !document.querySelector('#refreshBtn').disabled);
    tomorrowOn = 21;
    await refresh();
    await firstQueue.getByText('Завтра світла за графіком менше на 1 год 30 хв', { exact: true }).waitFor();
    assert.equal(await firstQueue.locator('.schedule-change').count(), 1, 'revision and day comparison coexist');
    tomorrowOn = 24;
    await refresh();
    await firstQueue.getByText('Завтра стільки ж світла за графіком', { exact: true }).waitFor();
    partialToday = true;
    await refresh();
    assert.equal(await firstQueue.locator('.day-comparison').count(), 0);
    partialToday = false;
    await refresh();
    failed = true;
    await screen.reload();
    await screen.getByText('Актуальність графіка не підтверджена', { exact: true }).waitFor();
    assert.equal(await screen.locator('.day-comparison[data-stale=true]').count(), 2);
    assert.equal(await screen.locator('.day-comparison').getByText('За збереженими графіками. Актуальність не підтверджена.', { exact: true }).count(), 2);
    failed = false;
    await screen.locator('#addressSelect').selectOption('b');
    await screen.getByText('Завтра світла за графіком більше на 2 год', { exact: true }).waitFor();
    assert.equal(await screen.locator('.day-comparison').count(), 1);
    await screen.clock.setFixedTime(new Date('2026-11-27T22:01:00Z'));
    await refresh();
    assert.equal(await screen.locator('.day-comparison').count(), 0, 'midnight must compare new calendar dates');
    console.log('PASS tomorrow vs today: publication, more/less/equal, separate groups/addresses, partial data, cache, mobile and midnight');
    await daily.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
