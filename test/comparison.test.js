import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachComparisons, changeSummary, possibleSummary, changedIntervals } from '../src/comparison.js';
const day = '2026-11-25';
const cases = JSON.parse(readFileSync(new URL('./fixtures/comparison-cases.json', import.meta.url), 'utf8'));
const snapshot = (slots, group = '2.1', date = day) => ({ fetchedAt: 1000,
  schedules: { [group]: slots ? { [date]: { slots: structuredClone(slots), updatedAt: 'source' } } : {} } });
for (const fixture of cases) test(`shared comparison fixture: ${fixture.name}`, () => {
  const before = snapshot(fixture.before), original = structuredClone(before);
  const next = attachComparisons(before, snapshot(fixture.after), 2000);
  const change = next.schedules['2.1'][day].comparison;
  assert.deepEqual(before, original, 'previous snapshot must not be mutated');
  if (!fixture.expected) assert.equal(change, undefined);
  else {
    for (const key of ['on', 'off', 'maybe']) assert.equal(change.after[key] - change.before[key], fixture.expected[key]);
    assert.equal(change.changedAt, 2000);
    assert.equal(change.previousFetchedAt, 1000);
    assert.equal(changeSummary(change).includes('більше'), fixture.expected.on > 0);
    assert.equal(changeSummary(change).includes('менше'), fixture.expected.on < 0);
  }
});
test('an unchanged poll/reload retains last change, while next change compares to immediate predecessor', () => {
  const before = snapshot(cases[0].before);
  const one = attachComparisons(before, snapshot(cases[0].after), 2000);
  const unchanged = attachComparisons(JSON.parse(JSON.stringify(one)), snapshot(cases[0].after), 3000);
  assert.deepEqual(unchanged.schedules['2.1'][day].comparison, one.schedules['2.1'][day].comparison);
  assert.equal(unchanged.schedules['2.1'][day].observedAt, 2000);
  const last = attachComparisons(unchanged, snapshot(cases[0].before), 4000).schedules['2.1'][day].comparison;
  assert.equal(last.after.on - last.before.on, -90);
  assert.equal(last.previousFetchedAt, 2000);
});
test('calendar rollover preserves tomorrow comparison; other groups and dates do not match', () => {
  const before = snapshot(cases[0].before, '2.1', '2026-11-26');
  const changed = attachComparisons(before, snapshot(cases[0].after, '2.1', '2026-11-26'), 2000);
  const rolled = attachComparisons(changed, snapshot(cases[0].after, '2.1', '2026-11-26'), 3000);
  assert.equal(rolled.schedules['2.1']['2026-11-26'].comparison.changedAt, 2000);
  assert.equal(attachComparisons(before, snapshot(cases[0].after, '3.1', '2026-11-26'), 3000).schedules['3.1']['2026-11-26'].comparison, undefined);
  assert.equal(attachComparisons(before, snapshot(cases[0].after), 3000).schedules['2.1'][day].comparison, undefined);
});
test('first download is a baseline and missing intervals never produce a claimed gain', () => {
  assert.equal(attachComparisons(null, snapshot(cases[0].after), 2000).schedules['2.1'][day].comparison, undefined);
  const partial = snapshot(cases[0].after); partial.schedules['2.1'][day].slots.pop();
  assert.equal(attachComparisons(snapshot(cases[0].before), partial, 2000).schedules['2.1'][day].comparison, undefined);
});
test('possible durations stay separate and detail intervals retain before/after meaning', () => {
  const change = attachComparisons(snapshot(cases[3].before), snapshot(cases[3].after), 2000).schedules['2.1'][day].comparison;
  assert.equal(changeSummary(change), 'Тривалість світла за графіком — та сама');
  assert.equal(possibleSummary(change), 'Можливі відключення: 1 год → 1 год 30 хв.');
  assert.deepEqual(changedIntervals(cases[0].before, cases[0].after), [
    { start: 780, end: 810, before: 10, after: 0 }, { start: 810, end: 870, before: 1, after: 0 }, { start: 870, end: 900, before: 1, after: 10 },
  ]);
});
