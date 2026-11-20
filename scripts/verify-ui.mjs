import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createAppServer } from '../server.mjs';

// Fixed public API fixtures keep CI independent of outages at the provider.
// Run with SVITLO_LIVE_TEST=1 to additionally exercise the official API.
const live = process.env.SVITLO_LIVE_TEST === '1';
let offline = false;
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
      [`${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, i === 26 ? '10' : i >= 27 && i < 35 ? '1' : '0']));
    data = { 'hydra:member': [{ dateGraph: `${date}T00:00:00Z`, dateCreate: `${date}T10:00:00Z`, dataJson: { '2.1': { times } } }] };
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
  console.log(`PASS ${live ? 'live' : 'fixture'} address → queue → schedule`);

  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log('PASS mobile 390px: no horizontal overflow');

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#view .ghost')?.textContent === 'Оновити', { timeout: 60000 });
  assert.equal(await page.locator('#chips button').count(), 1);
  console.log('PASS saved address survives reload');
  await page.route('**/api/**', route => route.abort());
  await page.reload();
  await page.getByText('Актуальність графіка не підтверджена', { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('#view .big').count(), 0);
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
  await second.getByRole('button', { name: 'Адреса Б', exact: true }).click();
  await second.getByRole('heading', { name: 'Підчерга 3.1', exact: true }).waitFor({ timeout: 10000 });
  // Wait for the slow, earlier address request to finish after the new selection.
  await second.waitForTimeout(1600);
  assert.equal(await second.getByRole('heading', { name: 'Адреса Б', exact: true }).count(), 1);
  assert.equal(await second.getByRole('heading', { name: 'Підчерга 1.1', exact: true }).count(), 0);
  assert.equal(await second.locator('.bar i').count(), 96);
  assert.equal(await second.getByText('Графік для цієї підчерги ще не опубліковано.', { exact: true }).count(), 2);
  console.log('PASS concurrent address switching; separate groups; unknown tomorrow');
  assert.deepEqual(errors, []);
  await mock.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
