import { duration } from './core.js';

const stateOf = value => [0, 1, 10, '0', '1', '10'].includes(value) ? Number(value) : null;
const values = day => Array.from({ length: 48 }, (_, i) => stateOf(day?.slots?.[i]));
const complete = day => day?.slots?.length === 48 && values(day).every(v => v !== null);
const same = (a, b) => values(a).every((v, i) => v === values(b)[i]);
export function dayTotals(slots) {
  return { on: slots.filter(v => v === 0).length * 30,
    off: slots.filter(v => v === 1).length * 30, maybe: slots.filter(v => v === 10).length * 30 };
}

// Called separately for each address. Dates and exact groups are never substituted.
// Keep the last actual revision across metadata-only refreshes and midnight.
export function attachComparisons(previous, next, now = Date.now()) {
  for (const [group, days] of Object.entries(next.schedules ?? {})) {
    for (const [date, day] of Object.entries(days)) {
      const before = previous?.schedules?.[group]?.[date];
      delete day.comparison;
      day.observedAt = before && same(before, day) ? before.observedAt ?? previous.fetchedAt ?? now : now;
      if (!complete(before) || !complete(day)) continue;
      if (same(before, day)) {
        if (before.comparison) day.comparison = structuredClone(before.comparison);
        continue;
      }
      const old = values(before), current = values(day);
      day.comparison = { changedAt: now, previousFetchedAt: before.observedAt ?? previous.fetchedAt ?? now,
        previousUpdatedAt: before.updatedAt ?? null, previousSlots: old,
        before: dayTotals(old), after: dayTotals(current) };
    }
  }
  return next;
}

export function changeSummary(change) {
  const delta = change.after.on - change.before.on;
  if (delta) return `Світла за графіком ${delta > 0 ? 'більше' : 'менше'} на ${duration(Math.abs(delta))}`;
  return change.after.off === change.before.off && change.after.maybe === change.before.maybe
    ? 'Години змінилися, тривалість світла — та сама'
    : 'Тривалість світла за графіком — та сама';
}
export function possibleSummary(change) {
  const { before, after } = change;
  return before.maybe === after.maybe
    ? `Можливі відключення: ${duration(after.maybe)}, без змін.`
    : `Можливі відключення: ${duration(before.maybe)} → ${duration(after.maybe)}.`;
}
export function changedIntervals(before, after) {
  const result = [];
  for (let i = 0; i < 48;) {
    if (before[i] === after[i]) { i++; continue; }
    let end = i + 1;
    while (end < 48 && before[end] === before[i] && after[end] === after[i]) end++;
    result.push({ start: i * 30, end: end * 30, before: before[i], after: after[i] });
    i = end;
  }
  return result;
}
