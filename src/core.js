export const TIME_ZONE = 'Europe/Kyiv';
export const API_ORIGIN = 'https://api-poweron.toe.com.ua';
export const STATE_LABELS = {
  0: 'Електропостачання за графіком',
  1: 'Відключення за графіком',
  10: 'Можливе відключення',
};

export function members(data) {
  const rows = Array.isArray(data) ? data : data?.['hydra:member'] ?? data?.member;
  if (!Array.isArray(rows)) throw new Error('Невідомий формат відповіді обленерго');
  return rows;
}

export function groupsOf(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(v => String(v?.chergGpv ?? v ?? '').trim())
    .filter(v => /^\d+(?:\.\d+)?(?:#[^\s]+)?$/.test(v)))];
}

export function kyivClock(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

export function addDays(date, count) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

export const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const duration = m => [m >= 60 && `${Math.floor(m / 60)} год`, m % 60 && `${m % 60} хв`].filter(Boolean).join(' ') || '0 хв';

// Convert a Kyiv wall-clock time using the offset at that instant, including DST.
export function kyivMs(date, minute) {
  const wall = Date.parse(`${date}T00:00:00Z`) + minute * 60000;
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const offset = new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
      .formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName').value;
    const m = offset.match(/GMT([+-])(\d\d):(\d\d)/);
    const minutes = m ? (m[1] === '+' ? 1 : -1) * (+m[2] * 60 + +m[3]) : 0;
    guess = wall - minutes * 60000;
  }
  return guess;
}

export function scheduleRequest(address, groups, date) {
  const addressKey = `${address.cityId}/${address.streetId}/${address.house}`;
  const query = new URLSearchParams({
    after: `${date}T00:00:00+00:00`,
    before: `${addDays(date, 1)}T00:00:00+00:00`,
    time: addressKey.replaceAll('/', ''),
  });
  for (const group of groups) query.append('group[]', group);
  // The official client sends this UTF-8 base64 header on every schedule request.
  const key = btoa(Array.from(new TextEncoder().encode(addressKey), b => String.fromCharCode(b)).join(''));
  return { path: `/a_gpv_g?${query}`, headers: { 'X-debug-key': key } };
}

export function parseSchedules(payload, groups, date) {
  const result = Object.fromEntries(groups.map(g => [g, {}]));
  const allowedDays = [date, addDays(date, 1)];
  for (const row of members(payload)) {
    const day = String(row.dateGraph ?? '').slice(0, 10);
    if (!allowedDays.includes(day)) continue;
    let data = row.dataJson;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('Обленерго повернуло пошкоджений графік'); }
    }
    for (const group of groups) {
      const times = data?.[group]?.times;
      // Never substitute a different group's schedule.
      if (!times || typeof times !== 'object' || Array.isArray(times)) continue;
      const slots = Array(48).fill(null);
      for (const [time, value] of Object.entries(times)) {
        if (!/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(time)) continue;
        if (![0, 1, 10, '0', '1', '10'].includes(value)) continue;
        const [h, m] = time.split(':').map(Number);
        slots[h * 2 + m / 30] = Number(value);
      }
      const previous = result[group][day];
      const updatedAt = row.dateCreate ?? null;
      if (previous && Date.parse(previous.updatedAt) > (Date.parse(updatedAt) || 0)) continue;
      result[group][day] = { slots, updatedAt };
    }
  }
  return result;
}

export function intervals(slots) {
  const result = [];
  for (let i = 0; i < 48;) {
    const value = slots?.[i] ?? null;
    let end = i + 1;
    while (end < 48 && (slots?.[end] ?? null) === value) end++;
    result.push({ value, start: i * 30, end: end * 30 });
    i = end;
  }
  return result;
}

export function statusInfo(days, date, minute) {
  const all = [...(days?.[date]?.slots ?? Array(48).fill(null)),
    ...(days?.[addDays(date, 1)]?.slots ?? Array(48).fill(null))];
  const index = Math.floor(minute / 30), state = all[index];
  if (state == null) return { state: null, text: 'Для цього часу немає опублікованих даних.' };
  let end = index + 1;
  while (end < 96 && all[end] === state) end++;
  const time = n => `${n >= 48 ? 'завтра ' : ''}${hhmm((n % 48) * 30)}`;
  if (state === 0) {
    // Stop at the first unknown slot: do not promise there are no outages beyond it.
    if (end < 96 && (all[end] === 1 || all[end] === 10)) return {
      state, until: end * 30 - minute,
      text: `${all[end] === 1 ? 'Наступне відключення' : 'Можливе відключення'} о ${time(end)} (через ${duration(end * 30 - minute)}).`,
    };
    return { state, text: 'В опублікованій частині графіка найближчих відключень немає. Далі дані можуть бути відсутні.' };
  }
  if (end === 96) return { state, text: 'Цей інтервал триває до кінця опублікованого графіка.' };
  return { state, text: `Поточний інтервал до ${time(end)}. ${all[end] == null ? 'Далі немає даних.' : `Далі: ${STATE_LABELS[all[end]].toLowerCase()}.`}` };
}

export function alertEvents(addresses, snapshots, lead, now = Date.now()) {
  const out = [];
  const { date } = kyivClock(new Date(now));
  for (const address of addresses) {
    const snapshot = snapshots.get(String(address.id));
    if (!snapshot || snapshot.stale || snapshot.date !== date || now - snapshot.fetchedAt > 15 * 60000) continue;
    for (const [group, days] of Object.entries(snapshot.schedules)) {
      for (const [day, data] of Object.entries(days)) {
        const s = data.slots;
        for (let i = 0; i < 48; i++) {
          if (s[i] !== 1 && s[i] !== 10) continue;
          const prev = i ? s[i - 1] : days[addDays(day, -1)]?.slots?.[47];
          if (prev === 1 || prev === 10) continue;
          const at = kyivMs(day, i * 30) - lead * 60000;
          if (at > now + 5000) out.push({ at, title: 'Світло: скоро відключення',
            body: `${address.label}, підчерга ${group}: ${s[i] === 1 ? 'відключення' : 'можливе відключення'} о ${hhmm(i * 30)} (за ${lead} хв).` });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
}
