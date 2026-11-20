import test from 'node:test';
import assert from 'node:assert/strict';
import { kyivClock, addDays, kyivMs, scheduleRequest, parseSchedules, statusInfo,
  intervals, members, groupsOf, alertEvents } from '../src/core.js';

const date = '2026-11-20';
const record = (dataJson, dateGraph = `${date}T00:00:00Z`, dateCreate = `${date}T08:00:00Z`) => ({ dataJson, dateGraph, dateCreate });
const payload = (...rows) => ({ 'hydra:member': rows });

test('official schedule request encodes all groups, slash and Cyrillic house, with required key', () => {
  const request = scheduleRequest({ cityId: 136, streetId: 1334, house: '5/А' }, ['2.1', '3.1#2'], date);
  const url = new URL(request.path, 'https://example.test');
  assert.deepEqual(url.searchParams.getAll('group[]'), ['2.1', '3.1#2']);
  assert.equal(url.searchParams.get('time'), '13613345А');
  assert.equal(Buffer.from(request.headers['X-debug-key'], 'base64').toString(), '136/1334/5/А');
  assert.equal(url.searchParams.get('after'), '2026-11-20T00:00:00+00:00');
  assert.equal(url.searchParams.get('before'), '2026-11-21T00:00:00+00:00');
});

test('only exact requested groups are used, without a first-group fallback', () => {
  const data = parseSchedules(payload(record({ '2.1': { times: { '00:00': '1' } } })), ['1.1', '2.1'], date);
  assert.deepEqual(data['1.1'], {});
  assert.equal(data['2.1'][date].slots[0], 1);
});

test('missing and invalid values remain unknown, including null and empty string', () => {
  const times = { '00:00': '0', '00:30': '10', '01:00': 1, '01:30': null,
    '02:00': '', '02:30': false, '03:00': 2, '03:15': '1', '24:00': '1' };
  const data = parseSchedules(payload(record(JSON.stringify({ '2.1': { times } }))), ['2.1'], date);
  assert.deepEqual(data['2.1'][date].slots.slice(0, 8), [0, 10, 1, null, null, null, null, null]);
  assert.equal(data['2.1'][date].slots.length, 48);
});

test('multiple groups and tomorrow stay separate; stale days excluded; latest revision wins', () => {
  const data = parseSchedules(payload(
    record({ '2.1': { times: { '00:00': 1 } }, '3.1': { times: { '00:00': 10 } } }),
    record({ '2.1': { times: { '00:00': 0 } } }, `${date}T00:00:00Z`, `${date}T09:00:00Z`),
    record({ '2.1': { times: { '00:00': 1 } } }, `${date}T00:00:00Z`, `${date}T07:00:00Z`),
    record({ '2.1': { times: { '00:00': 10 } } }, '2026-11-21T00:00:00Z'),
    record({ '2.1': { times: { '00:00': 1 } } }, '2026-11-19T00:00:00Z'),
  ), ['2.1', '3.1'], date);
  assert.equal(data['2.1'][date].slots[0], 0);
  assert.equal(data['3.1'][date].slots[0], 10);
  assert.equal(data['2.1']['2026-11-21'].slots[0], 10);
  assert.equal(data['2.1']['2026-11-19'], undefined);
});

test('malformed responses produce errors rather than a no-outages result', () => {
  assert.throws(() => members({ message: 'unavailable' }));
  assert.throws(() => parseSchedules(payload(record('{broken')), ['2.1'], date));
  assert.deepEqual(parseSchedules(payload(), ['2.1'], date), { '2.1': {} });
  assert.deepEqual(groupsOf([{ chergGpv: ' 2.1 ' }, { chergGpv: '2.1' }, { chergGpv: '3.1#2' }, { chergGpv: 'Не входить' }]), ['2.1', '3.1#2']);
});

test('status does not claim power is restored when data ends during an outage', () => {
  const slots = Array(48).fill(1);
  const info = statusInfo({ [date]: { slots } }, date, 23 * 60 + 40);
  assert.equal(info.state, 1);
  assert.match(info.text, /Далі немає даних/);
  assert.doesNotMatch(info.text, /з’явиться/);
  assert.equal(statusInfo({}, date, 300).state, null);
});

test('status never searches beyond unknown slots for an assured next outage', () => {
  const slots = Array(48).fill(0);
  slots[4] = null; slots[5] = 1;
  const info = statusInfo({ [date]: { slots } }, date, 100);
  assert.equal(info.until, undefined);
  assert.match(info.text, /Далі дані можуть бути відсутні/);
});

test('intervals include unknown periods and midnight is represented as 24:00', () => {
  const slots = Array(48).fill(0); slots[46] = 10; slots[47] = null;
  assert.deepEqual(intervals(slots).slice(-2), [
    { value: 10, start: 1380, end: 1410 }, { value: null, start: 1410, end: 1440 },
  ]);
});

test('Kyiv date and alert timestamps respect midnight and seasonal UTC offsets', () => {
  assert.deepEqual(kyivClock(new Date('2026-11-20T22:10:00Z')), { date: '2026-11-21', min: 10 });
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(new Date(kyivMs(date, 13 * 60)).toISOString(), '2026-11-20T11:00:00.000Z');
  assert.equal(new Date(kyivMs('2026-07-20', 13 * 60)).toISOString(), '2026-07-20T10:00:00.000Z');
  assert.equal(new Date(kyivMs('2026-03-29', 60)).toISOString(), '2026-03-28T23:00:00.000Z');
});

test('alerts merge possible/definite intervals and skip stale or wrong-date snapshots', () => {
  const now = Date.parse(`${date}T08:00:00Z`);
  const slots = Array(48).fill(0); slots[26] = 10; slots[27] = 1; slots[28] = 1;
  const address = { id: 'a', label: 'Тестова адреса' };
  const snapshot = { date, fetchedAt: now, schedules: { '2.1': { [date]: { slots } } } };
  const snapshots = new Map([['a', snapshot]]);
  const events = alertEvents([address], snapshots, 30, now);
  assert.equal(events.length, 1);
  assert.equal(new Date(events[0].at).toISOString(), `${date}T10:30:00.000Z`);
  assert.match(events[0].body, /можливе відключення о 13:00/);
  snapshot.stale = true;
  assert.equal(alertEvents([address], snapshots, 30, now).length, 0);
  snapshot.stale = false; snapshot.date = '2026-11-19';
  assert.equal(alertEvents([address], snapshots, 30, now).length, 0);
});

test('an outage continuing past midnight produces a single notification', () => {
  const now = Date.parse(`${date}T18:00:00Z`), today = Array(48).fill(0), tomorrow = Array(48).fill(0);
  today[47] = 1; tomorrow[0] = 1; tomorrow[1] = 10;
  const snapshots = new Map([['a', { date, fetchedAt: now, schedules: { '2.1': {
    [date]: { slots: today }, [addDays(date, 1)]: { slots: tomorrow },
  } } }]]);
  assert.equal(alertEvents([{ id: 'a', label: 'Адреса' }], snapshots, 30, now).length, 1);
});
