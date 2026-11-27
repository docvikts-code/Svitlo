import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { API_ORIGIN, TIME_ZONE, STATE_LABELS, members, groupsOf, kyivClock, addDays,
  hhmm, duration, formatSourceTimestamp, scheduleRequest, parseSchedules, intervals, statusInfo, alertEvents } from './core.js';

import { attachComparisons, changeSummary, possibleSummary, changedIntervals, compareDays, dayComparisonSummary } from './comparison.js';

const $ = selector => document.querySelector(selector);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const memory = new Map();
const store = {
  get(key, fallback) {
    try { const text = localStorage.getItem(key); if (text !== null) return JSON.parse(text); } catch { /* Private mode */ }
    return memory.has(key) ? memory.get(key) : fallback;
  },
  set(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { $('#storageNote').hidden = false; }
  },
};
const logs = [];
function log(text) {
  logs.push(`${new Date().toLocaleTimeString('uk-UA', { timeZone: TIME_ZONE })} ${text}`);
  $('#diag').textContent = logs.slice(-30).join('\n');
}
const native = Capacitor.isNativePlatform();
const android = Capacitor.getPlatform() === 'android';
const BackgroundSync = registerPlugin('BackgroundSync');
let backgroundEnabled = store.get('backgroundEnabled', true) !== false;
let notifyChanges = store.get('notifyChanges', true) !== false;
let nativeQueue = Promise.resolve();
let addresses = store.get('addrs', []);
if (!Array.isArray(addresses)) addresses = [];
addresses = addresses.filter(a => a && a.id != null && a.cityId && a.streetId && a.house != null);
let selectedId = String(store.get('sel', addresses[0]?.id ?? ''));
if (!addresses.some(a => String(a.id) === selectedId)) selectedId = String(addresses[0]?.id ?? '');
const savedLead = Number(store.get('lead', 30));
let lead = [15, 30, 60, 120].includes(savedLead) ? savedLead : 30;
const snapshots = new Map();
const requests = new Map();
const openComparisons = new Set();
let wizardVersion = 0;
let stopSearch = () => {};

async function api(path, headers = {}) {
  log(`Запит ${path.split('?')[0]}`);
  let status, data;
  try {
    if (native) {
      const response = await CapacitorHttp.get({ url: `${API_ORIGIN}/api${path}`, headers,
        connectTimeout: 15000, readTimeout: 25000, responseType: 'json' });
      status = response.status;
      data = response.data;
    } else {
      const response = await fetch(`/api${path}`, { headers, signal: AbortSignal.timeout(30000), cache: 'no-store' });
      status = response.status;
      if (response.ok && !response.headers.get('content-type')?.includes('json')) {
        throw new Error('Для вебверсії потрібен сервер Svitlo. Запустіть npm start або відкрийте Android-додаток.');
      }
      data = await response.json().catch(() => null);
    }
    log(`Відповідь ${status}`);
    if (status < 200 || status >= 300) throw new Error(status === 429
      ? 'Обленерго обмежило частоту запитів. Повторіть пізніше.'
      : `Сервіс обленерго тимчасово недоступний (HTTP ${status}).`);
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error('Сервіс повернув відповідь без графіка.'); }
    }
    if (!data || typeof data !== 'object') throw new Error('Невідомий формат відповіді обленерго.');
    return data;
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('Сервіс не відповів вчасно. Повторіть запит.');
    if (error instanceof TypeError) throw new Error('Немає зв’язку із сервером. Перевірте інтернет і повторіть запит.');
    throw error;
  }
}

async function getGroups(address) {
  const query = new URLSearchParams({ cityId: address.cityId, streetId: address.streetId, buildingNames: address.house });
  const data = await api(`/pw-accounts/building-groups?${query}`);
  if (!Array.isArray(data.buildingGroups)) throw new Error('Не вдалося визначити підчерги цього будинку.');
  return groupsOf(data.buildingGroups);
}

function persistAddresses() { store.set('addrs', addresses); if (android) void configureNative(); }

function acceptNative(state) {
  for (const address of addresses) {
    const snapshot = state.snapshots?.[String(address.id)];
    if (!snapshot) continue;
    snapshots.set(String(address.id), snapshot);
    store.set(`schedule:${address.id}`, snapshot);
  }
  if (state.lastBackgroundCheck) {
    $('#backgroundStatus').textContent = `Остання фонова перевірка: ${timestamp(state.lastBackgroundCheck)} (Київ).`
      + (state.backgroundFailures ? ' Частину графіків не вдалося оновити; спроба повториться.' : '');
  } else $('#backgroundStatus').textContent = backgroundEnabled
    ? 'Фонове оновлення ввімкнено. Перша автоматична перевірка — орієнтовно протягом 15 хвилин.'
    : 'Фонове оновлення вимкнено.';
  $('#backgroundTest').disabled = !backgroundEnabled || !addresses.length;
  $('#notificationStatus').textContent = `Заплановано сповіщень: ${state.alarms?.filter(event => event.at > Date.now()).length ?? 0}.`;
  render();
}

function configureNative() {
  if (!android) return Promise.resolve();
  const settings = { addresses: addresses.map(a => ({ id: String(a.id), cityId: String(a.cityId), streetId: String(a.streetId),
    house: String(a.house), label: a.label })), lead, enabled: backgroundEnabled, notifyChanges,
    seeds: Object.fromEntries(snapshots) };
  nativeQueue = nativeQueue.catch(() => {}).then(() => BackgroundSync.configure(settings)).then(acceptNative).catch(error => {
    log(`Фонове оновлення: ${error.message}`);
    $('#backgroundStatus').textContent = 'Не вдалося налаштувати фонове оновлення. Спробуйте відкрити додаток знову.';
  });
  return nativeQueue;
}

async function openWidgetAddress(refreshNow = true) {
  if (!android) return;
  try {
    const { addressId } = await BackgroundSync.consumeWidgetAddress();
    if (!addresses.some(a => String(a.id) === addressId)) return;
    if (refreshNow) await select(addressId);
    else { selectedId = addressId; store.set('sel', selectedId); drawChips(); render(); }
  } catch (error) { log(`Віджет: ${error.message}`); }
}

async function readNativeState() {
  if (!android) return;
  try { await nativeQueue; acceptNative(await BackgroundSync.getState()); }
  catch (error) { log(`Стан фонової перевірки: ${error.message}`); }
}
function cached(address) {
  const data = store.get(`schedule:${address.id}`, null);
  if (data?.schedules && Number.isFinite(data.fetchedAt)) snapshots.set(String(address.id), { ...data, stale: true });
}

async function refresh(address) {
  const id = String(address.id);
  if (requests.has(id)) return requests.get(id);
  const job = (async () => {
    try {
      if (android) {
        await nativeQueue;
        acceptNative(await BackgroundSync.refresh({ addressId: id }));
        return;
      }
      const groups = await getGroups(address);
      const { date } = kyivClock();
      let schedules = {};
      if (groups.length) {
        const query = scheduleRequest(address, groups, date);
        schedules = parseSchedules(await api(query.path, query.headers), groups, date);
      }
      if (!addresses.some(a => String(a.id) === id)) return;
      address.groups = groups;
      persistAddresses();
      const now = Date.now();
      const snapshot = attachComparisons(snapshots.get(id), { schedules, date, fetchedAt: now, stale: false }, now);
      snapshots.set(id, snapshot);
      store.set(`schedule:${id}`, snapshot);
    } catch (error) {
      if (!addresses.some(a => String(a.id) === id)) return;
      const old = snapshots.get(id);
      snapshots.set(id, { ...old, stale: true, error: error.message });
      log(error.message);
    } finally {
      requests.delete(id);
      if (selectedId === id) render();
    }
  })();
  requests.set(id, job);
  if (selectedId === id) render();
  return job;
}

function button(text, action, cls = 'ghost') {
  const node = el('button', cls, text);
  node.type = 'button';
  node.onclick = action;
  return node;
}

function showSettings() {
  if (!$('#settingsDialog').open) $('#settingsDialog').showModal();
}
function hideSettings() { $('#settingsDialog').close(); }

function drawChips() {
  const picker = $('#addressSelect');
  picker.replaceChildren();
  picker.disabled = !addresses.length;
  if (!addresses.length) picker.append(new Option('Додайте адресу в налаштуваннях', ''));
  for (const address of addresses) picker.append(new Option(address.label, String(address.id)));
  picker.value = selectedId;
  $('#selectedAddressLabel').textContent = addresses.find(a => String(a.id) === selectedId)?.label ?? 'Додайте адресу в налаштуваннях';
  const chips = $('#chips');
  chips.replaceChildren();
  if (!addresses.length) chips.append(el('p', 'mut', 'Додайте будинок, щоб побачити його графік.'));
  for (const address of addresses) {
    const row = el('div', 'address-row');
    const node = button(address.label, () => { hideSettings(); void select(address.id); }, 'chip');
    node.setAttribute('aria-pressed', String(String(address.id) === selectedId));
    const removeButton = button('×', () => remove(address.id), 'remove-address');
    removeButton.setAttribute('aria-label', `Видалити адресу: ${address.label}`);
    row.append(node, removeButton);
    chips.append(row);
  }
}

function timestamp(ms) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function comparisonCard(day, group, date, stale) {
  const change = day.comparison;
  if (!change?.before || !change.after || change.previousSlots?.length !== 48) return null;
  const delta = change.after.on - change.before.on;
  const card = el('section', `schedule-change ${delta > 0 ? 'change-positive' : delta < 0 ? 'change-negative' : 'change-neutral'}`);
  card.dataset.stale = String(!!stale);
  card.setAttribute('aria-label', 'Порівняння графіків');
  const heading = el('div', 'change-heading');
  heading.append(el('span', null, stale ? 'Остання збережена зміна' : 'Графік змінився'), el('span', null, timestamp(change.changedAt)));
  card.append(heading, el('p', 'change-title', changeSummary(change)),
    el('p', 'change-totals', `За добу: ${duration(change.before.on)} → ${duration(change.after.on)}`),
    el('p', 'change-possible', possibleSummary(change)));
  if (stale) card.append(el('p', 'change-possible', 'Порівняння збережених версій. Актуальність не підтверджена.'));
  const details = el('details', 'change-details');
  const key = `${selectedId}|${group}|${date}`;
  details.open = openComparisons.has(key);
  const summary = el('summary');
  const caption = el('span', null, details.open ? 'Згорнути порівняння' : 'Що змінилося');
  const chevron = el('span', 'change-chevron', '⌄'); chevron.setAttribute('aria-hidden', 'true');
  summary.append(caption, chevron);
  details.append(summary);
  const inside = el('div', 'comparison-content');
  for (const [name, slots, received] of [['Попередній графік', change.previousSlots, change.previousFetchedAt], ['Новий графік', day.slots, change.changedAt]]) {
    const graph = el('div', 'comparison-graph');
    graph.append(el('p', 'comparison-caption', `${name} · ${timestamp(received)} (Київ)`));
    const bar = el('div', 'mini-bar'); bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${name}. ${intervals(slots).map(i => `${hhmm(i.start)}–${hhmm(i.end)}: ${STATE_LABELS[i.value] ?? 'немає даних'}`).join('; ')}`);
    for (let i = 0; i < 48; i++) {
      const cell = el('i', `s${slots[i]}`);
      cell.title = `${hhmm(i * 30)}–${hhmm((i + 1) * 30)}: ${STATE_LABELS[slots[i]]}`;
      cell.setAttribute('aria-hidden', 'true'); bar.append(cell);
    }
    const axis = el('div', 'axis'); axis.setAttribute('aria-hidden', 'true');
    for (const t of ['00', '06', '12', '18', '24']) axis.append(el('span', null, t));
    graph.append(bar, axis); inside.append(graph);
  }
  const list = el('div', 'comparison-list');
  const label = value => ({ 0: 'є за графіком', 1: 'відключення', 10: 'можливе відключення' }[value]);
  for (const interval of changedIntervals(change.previousSlots, day.slots)) {
    const row = el('div', 'comparison-row'), states = el('div');
    states.append(el('p', 'comparison-before', `Було: ${label(interval.before)}`), el('p', null, `Стало: ${label(interval.after)}`));
    row.append(el('b', null, `${hhmm(interval.start)}–${hhmm(interval.end)}`), states); list.append(row);
  }
  inside.append(list, el('p', 'comparison-caption', `Порівняно з графіком, отриманим ${timestamp(change.previousFetchedAt)} (Київ).`));
  details.append(inside);
  details.ontoggle = () => {
    if (details.open) openComparisons.add(key); else openComparisons.delete(key);
    caption.textContent = details.open ? 'Згорнути порівняння' : 'Що змінилося';
  };
  card.append(details);
  return card;
}

function dayComparisonCard(comparison, stale) {
  const delta = comparison.after.on - comparison.before.on;
  const card = el('section', `day-comparison ${delta > 0 ? 'change-positive' : delta < 0 ? 'change-negative' : 'change-neutral'}`);
  card.dataset.stale = String(!!stale);
  card.setAttribute('aria-label', 'Порівняння завтра зі сьогодні');
  card.append(el('p', 'change-heading', 'Порівняно із сьогодні · за всю добу'),
    el('p', 'change-title', dayComparisonSummary(comparison)));
  const totals = el('div', 'day-totals');
  for (const [name, value] of [['Сьогодні', comparison.before.on], ['Завтра', comparison.after.on]]) {
    const item = el('div');
    item.append(el('span', null, name), el('strong', null, duration(value)));
    totals.append(item);
  }
  card.append(totals, el('p', 'change-possible', `Можливі відключення: сьогодні ${duration(comparison.before.maybe)}, завтра ${duration(comparison.after.maybe)}.`));
  if (stale) card.append(el('p', 'change-possible', 'За збереженими графіками. Актуальність не підтверджена.'));
  return card;
}

function dayCard(title, date, day, minute, stale, info, snapshot, group, dayComparison = null) {
  const card = el('section', 'card day');
  const heading = el('div', 'day-header');
  const dayHeading = el('h3', null, title);
  dayHeading.append(el('span', 'day-date', `${date.slice(8)}.${date.slice(5, 7)}`));
  heading.append(dayHeading, el('span', 'day-badge', 'Час за Києвом'));
  card.append(heading);
  if (!day || day.slots.every(s => s == null)) {
    const empty = el('div', 'day-empty');
    empty.append(el('span', 'empty-dash', '—'), el('p', null, 'Графік для цієї підчерги ще не опубліковано.'));
    card.append(empty);
    return card;
  }
  if (info) {
    const status = el('div', 'schedule-status');
    status.dataset.state = String(info.state);
    status.append(el('p', 'status-kicker', 'Зараз за графіком'),
      el('div', `big ${info.state === 1 ? 'tOff' : info.state === 0 ? 'tOn' : info.state === 10 ? 'tMaybe' : ''}`,
        { 0: 'Світло є', 1: 'Відключення', 10: 'Можливе відключення' }[info.state] ?? 'Немає даних'),
      el('p', 'status-detail', info.text));
    card.append(status);
  }
  if (dayComparison) card.append(dayComparisonCard(dayComparison, stale));
  const comparison = comparisonCard(day, group, date, stale);
  if (comparison) card.append(comparison);
  if (stale) card.append(el('p', 'mut', 'Збережений графік. Актуальність не підтверджена.'));
  const timeline = el('div', 'timeline');
  const bar = el('div', 'bar');
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 48; i++) {
    const value = day.slots[i];
    const cell = el('i', value == null ? '' : `s${value}`);
    cell.title = `${hhmm(i * 30)}–${hhmm((i + 1) * 30)}: ${STATE_LABELS[value] ?? 'немає даних'}`;
    bar.append(cell);
  }
  timeline.append(bar);
  if (minute != null && !stale) {
    const marker = el('b', 'now');
    marker.style.left = `${minute / 14.4}%`;
    marker.setAttribute('aria-hidden', 'true');
    const label = el('span', 'now-label', hhmm(minute));
    label.style.left = `clamp(27px, ${minute / 14.4}%, calc(100% - 27px))`;
    label.setAttribute('aria-label', `Зараз ${hhmm(minute)} за Києвом`);
    timeline.append(marker, label);
  }
  const axis = el('div', 'axis');
  axis.setAttribute('aria-hidden', 'true');
  for (const t of ['00', '06', '12', '18', '24']) axis.append(el('span', null, t));
  card.append(timeline, axis);
  const legend = el('div', 'legend');
  for (const [value, text] of [[0, 'Є'], [1, 'Відключення'], [10, 'Можливе'], [null, 'Немає даних']]) {
    const item = el('span');
    const swatch = el('i', value == null ? '' : `key${value}`);
    swatch.setAttribute('aria-hidden', 'true');
    item.append(swatch, document.createTextNode(text));
    legend.append(item);
  }
  card.append(legend);
  const table = el('table', 'intervals');
  const caption = el('caption', 'sr-only', `Усі інтервали: ${title}`);
  const body = el('tbody');
  for (const interval of intervals(day.slots)) {
    const current = !stale && minute != null && minute >= interval.start && minute < interval.end;
    const row = el('tr', current ? 'current-interval' : '');
    const time = el('th', null, `${hhmm(interval.start)}–${hhmm(interval.end)}`);
    time.scope = 'row';
    if (current) { row.setAttribute('aria-current', 'time'); time.append(el('span', 'current-tag', 'Зараз')); }
    const label = el('td', `t${interval.value === 1 ? 'Off' : interval.value === 10 ? 'Maybe' : interval.value === 0 ? 'On' : ''}`);
    const state = el('span', 'interval-state');
    const dot = el('i', interval.value == null ? 'interval-dot' : `interval-dot dot${interval.value}`);
    dot.setAttribute('aria-hidden', 'true');
    state.append(dot, document.createTextNode({ 0: 'Є за графіком', 1: 'Відключення', 10: 'Можливе відключення' }[interval.value] ?? 'Немає даних'));
    label.append(state);
    row.append(time, label);
    body.append(row);
  }
  table.append(caption, body);
  card.append(table);
  const source = el('div', 'source-time');
  const sourceStamp = formatSourceTimestamp(day.updatedAt);
  if (sourceStamp) source.append(el('p', null, `Оновлення на сайті обленерго: ${sourceStamp}`));
  if (snapshot?.fetchedAt) source.append(el('p', null, `Перевірено: ${timestamp(snapshot.fetchedAt)} (Київ)`));
  card.append(source);
  return card;
}

function render() {
  const view = $('#view');
  view.replaceChildren();
  const address = addresses.find(a => String(a.id) === selectedId);
  const loading = requests.has(selectedId);
  $('#refreshBtn').disabled = !address || loading;
  $('#refreshBtn').setAttribute('aria-busy', String(loading));
  if (!address) {
    const empty = el('section', 'card empty-view');
    empty.append(el('h2', null, 'Графік для вашого будинку'),
      el('p', 'mut', 'Додайте адресу, щоб бачити відключення на сьогодні й завтра.'),
      button('Додати адресу', startWizard));
    view.append(empty);
    return;
  }
  const snapshot = snapshots.get(selectedId);
  if (!snapshot?.schedules) {
    view.append(el('p', 'card', loading ? 'Завантажую графік…' : snapshot?.error ?? 'Немає даних. Натисніть кнопку оновлення біля адреси.'));
    return;
  }
  const { date, min } = kyivClock();
  const stale = snapshot.stale || snapshot.date !== date || Date.now() - snapshot.fetchedAt > 15 * 60000;
  if (stale) {
    const warning = el('section', 'card warn');
    warning.setAttribute('role', 'status');
    warning.append(el('b', null, 'Актуальність графіка не підтверджена'),
      el('p', null, snapshot.error ?? 'Потрібно оновити дані.'),
      el('p', 'mut', 'Нижче — останній збережений графік. Він міг змінитися.'));
    view.append(warning);
  }
  const groups = Object.keys(snapshot.schedules);
  if (!groups.length) {
    view.append(el('p', 'card', 'Для цього будинку обленерго не вказало підчергу ГПВ. Перевірте адресу на офіційному сайті.'));
    return;
  }
  if (groups.length > 1) view.append(el('p', 'mut', 'Будинок має кілька підчерг. Нижче — окремий графік кожної.'));
  for (const [group, days] of Object.entries(snapshot.schedules)) {
    const section = el('section', 'queue');
    section.setAttribute('aria-label', `Графіки підчерги ${group}`);
    section.append(el('h2', 'queue-title', `Підчерга ${group}`));
    const info = stale ? null : statusInfo(days, date, min);
    const tomorrow = addDays(date, 1);
    section.append(dayCard('Сьогодні', date, days[date], min, stale, info, snapshot, group),
      dayCard('Завтра', tomorrow, days[tomorrow], null, stale, null, snapshot, group, compareDays(days[date], days[tomorrow])));
    view.append(section);
  }
}

async function select(id) {
  selectedId = String(id);
  store.set('sel', id);
  drawChips();
  render();
  const address = addresses.find(a => String(a.id) === selectedId);
  if (address) { await refresh(address); await planAlerts(); }
}
function remove(id) {
  addresses = addresses.filter(a => String(a.id) !== String(id));
  snapshots.delete(String(id));
  store.set(`schedule:${id}`, null);
  persistAddresses();
  selectedId = String(addresses[0]?.id ?? '');
  store.set('sel', selectedId);
  drawChips(); render();
  void planAlerts();
  if (addresses.length) void select(selectedId); else startWizard();
}

const normalize = text => String(text).toLocaleLowerCase('uk-UA').replace(/[’'ʼ`]/g, '').trim();
function closeWizard() {
  wizardVersion++;
  stopSearch();
  $('#wiz').hidden = true;
}
function searchStep(title, placeholder, minimum, load, label, done, back) {
  stopSearch();
  const version = ++wizardVersion;
  const wizard = $('#wiz');
  wizard.hidden = false;
  wizard.replaceChildren(el('h2', null, title));
  const nav = el('div', 'row');
  if (back) nav.append(button('Назад', back));
  nav.append(button('Скасувати', closeWizard));
  const input = el('input');
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.autocomplete = 'off';
  const list = el('div', 'list');
  list.setAttribute('aria-live', 'polite');
  wizard.append(nav, input, list);
  let timer, sequence = 0;
  stopSearch = () => { clearTimeout(timer); sequence++; };
  const search = async () => {
    const current = ++sequence, query = input.value.trim();
    list.replaceChildren();
    if (query.length < minimum) { list.append(el('p', 'mut', `Введіть щонайменше ${minimum} символи.`)); return; }
    list.append(el('p', 'mut', 'Шукаю…'));
    try {
      const items = await load(query);
      if (version !== wizardVersion || current !== sequence) return;
      list.replaceChildren();
      if (!items.length) list.append(el('p', 'mut', 'Нічого не знайдено. Перевірте назву або номер.'));
      for (const item of items.slice(0, 60)) list.append(button(label(item), () => done(item), 'result'));
      if (items.length > 60) list.append(el('p', 'mut', `Знайдено ${items.length}. Уточніть пошук, щоб побачити потрібний варіант.`));
    } catch (error) {
      if (version !== wizardVersion || current !== sequence) return;
      list.replaceChildren(el('p', 'tOff', error.message), button('Спробувати ще', search));
    }
  };
  input.oninput = () => { clearTimeout(timer); sequence++; timer = setTimeout(search, 300); };
  void search();
  input.focus();
}
function startWizard() {
  showSettings();
  searchStep('1. Населений пункт', 'Назва, наприклад Бережани', 2,
    async query => members(await api(`/pw_cities?${new URLSearchParams({ pagination: 'false', name: query })}`))
      .filter(city => normalize(city.name).includes(normalize(query))),
    city => `${city.name}${city.otg?.name ? ` · ${city.otg.name}` : ''}`, pickStreet);
}
function pickStreet(city) {
  let data;
  searchStep(`2. Вулиця · ${city.name}`, 'Назва вулиці', 0,
    async query => {
      if (!data) data = members(await api(`/pw_streets?${new URLSearchParams({ pagination: 'false', 'city.id': city.id })}`));
      return data.filter(street => normalize(street.name).includes(normalize(query)))
        .sort((a, b) => a.name.localeCompare(b.name, 'uk', { numeric: true }));
    }, street => street.name, street => pickHouse(city, street), startWizard);
}
function pickHouse(city, street) {
  let data;
  searchStep(`3. Будинок · ${street.name}`, 'Номер будинку', 0,
    async query => {
      if (!data) {
        const response = await api(`/pw-accounts/building-names?${new URLSearchParams({ cityId: city.id, streetId: street.id })}`);
        if (!Array.isArray(response.buildingNames)) throw new Error('Не вдалося отримати перелік будинків.');
        data = [...new Map(response.buildingNames.map(h => [String(h.buildingName), h])).values()];
      }
      return data.filter(house => normalize(house.buildingName).includes(normalize(query)))
        .sort((a, b) => Number(normalize(b.buildingName) === normalize(query)) - Number(normalize(a.buildingName) === normalize(query))
          || String(a.buildingName).localeCompare(String(b.buildingName), 'uk', { numeric: true }));
    }, house => String(house.buildingName), house => saveAddress(city, street, house), () => pickStreet(city));
}
function saveAddress(city, street, house) {
  const existing = addresses.find(a => String(a.cityId) === String(city.id)
    && String(a.streetId) === String(street.id) && String(a.house) === String(house.buildingName));
  const address = existing ?? { id: crypto.randomUUID?.() ?? String(Date.now()), cityId: city.id,
    streetId: street.id, house: String(house.buildingName), label: `${city.name}, ${street.name}, ${house.buildingName}` };
  if (!existing) addresses.push(address);
  persistAddresses();
  closeWizard();
  hideSettings();
  void select(address.id);
}

let planning = Promise.resolve();
function planAlerts() {
  if (!native) return Promise.resolve();
  if (android) return nativeQueue.then(async () => {
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') {
        $('#notificationStatus').textContent = 'Сповіщення вимкнені. Натисніть «Увімкнути сповіщення».';
        return;
      }
      const state = await BackgroundSync.getState();
      acceptNative(state);
      const exact = await LocalNotifications.checkExactNotificationSetting();
      if (exact.exact_alarm !== 'granted') $('#notificationStatus').textContent += ' Android може затримувати їх. Дозвольте точні сигнали в налаштуваннях додатка.';
    } catch (error) { log(`Сповіщення: ${error.message}`); }
  });
  // Serialize replacements so an old refresh cannot restore cancelled notifications.
  planning = planning.catch(() => {}).then(async () => {
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') {
        $('#notificationStatus').textContent = 'Сповіщення вимкнені. Натисніть «Увімкнути сповіщення».';
        return;
      }
      const events = alertEvents(addresses, snapshots, lead);
      const pending = (await LocalNotifications.getPending()).notifications;
      if (pending.length) await LocalNotifications.cancel({ notifications: pending.map(n => ({ id: n.id })) });
      if (events.length) await LocalNotifications.schedule({ notifications: events.map((event, i) => ({
        id: i + 1, title: event.title, body: event.body,
        schedule: { at: new Date(event.at), allowWhileIdle: true },
      })) });
      const exact = await LocalNotifications.checkExactNotificationSetting();
      $('#notificationStatus').textContent = `Заплановано сповіщень: ${events.length}.${exact.exact_alarm === 'granted' ? '' : ' Android може затримувати їх. Дозвольте точні сигнали в налаштуваннях додатка.'}`;
    } catch (error) { log(`Сповіщення: ${error.message}`); $('#notificationStatus').textContent = 'Не вдалося оновити сповіщення.'; }
  });
  return planning;
}

async function refreshAll() {
  // Limit load on the official service; deduplicate concurrent refreshes per address.
  for (const address of [...addresses]) await refresh(address);
  await planAlerts();
}
$('#settingsBtn').onclick = showSettings;
$('#closeSettings').onclick = hideSettings;
$('#settingsDialog').addEventListener('close', closeWizard);
$('#settingsDialog').addEventListener('click', event => {
  if (event.target !== $('#settingsDialog')) return;
  const bounds = $('#settingsDialog').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) hideSettings();
});
$('#addressSelect').onchange = event => { void select(event.target.value); };
$('#refreshBtn').onclick = async () => {
  const address = addresses.find(a => String(a.id) === selectedId);
  if (address) { await refresh(address); await planAlerts(); }
};
$('#addBtn').onclick = startWizard;
$('#lead').value = String(lead);
$('#lead').onchange = async () => { lead = Number($('#lead').value); store.set('lead', lead); render(); await configureNative(); await planAlerts(); };
$('#backgroundOptions').hidden = !android;
$('#widgetHelp').hidden = !android;
$('#backgroundEnabled').checked = backgroundEnabled;
$('#notifyChanges').checked = notifyChanges;
$('#backgroundEnabled').onchange = async event => {
  backgroundEnabled = event.target.checked; store.set('backgroundEnabled', backgroundEnabled);
  await configureNative(); await readNativeState();
  if (backgroundEnabled) await refreshAll();
};
$('#notifyChanges').onchange = async event => {
  notifyChanges = event.target.checked; store.set('notifyChanges', notifyChanges); await configureNative();
};
$('#backgroundSettings').onclick = async () => {
  try { await BackgroundSync.openSettings(); } catch (error) { log(error.message); }
};
$('#backgroundTest').onclick = async () => {
  try {
    if ((await LocalNotifications.requestPermissions()).display !== 'granted') {
      $('#backgroundStatus').textContent = 'Спочатку дозвольте сповіщення.'; return;
    }
    await configureNative();
    await BackgroundSync.test();
    $('#backgroundStatus').textContent = 'Згорніть додаток. Фонова перевірка запуститься орієнтовно через 30 секунд за наявності інтернету й надішле результат.';
  } catch (error) { $('#backgroundStatus').textContent = error.message; }
};
$('#enableN').hidden = !native;
$('#testN').hidden = !native;
$('#notificationStatus').textContent = native ? 'Перевіряю налаштування сповіщень…' : 'Сповіщення доступні в Android-додатку.';
$('#enableN').onclick = async () => {
  try {
    await LocalNotifications.requestPermissions();
    const exact = await LocalNotifications.checkExactNotificationSetting();
    if (exact.exact_alarm !== 'granted') await LocalNotifications.changeExactNotificationSetting();
    await configureNative(); await refreshAll();
  } catch (error) { log(`Дозвіл: ${error.message}`); }
};
$('#testN').onclick = async () => {
  try {
    if ((await LocalNotifications.requestPermissions()).display !== 'granted') {
      $('#notificationStatus').textContent = 'Дозвольте сповіщення в налаштуваннях телефона.'; return;
    }
    await LocalNotifications.schedule({ notifications: [{ id: 999999, title: 'Світло: перевірка',
      body: 'Сповіщення працюють', schedule: { at: new Date(Date.now() + 10000), allowWhileIdle: true } }] });
    $('#notificationStatus').textContent = 'Тестове сповіщення заплановане через 10 секунд.';
  } catch (error) { $('#notificationStatus').textContent = error.message; }
};
$('#copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#diag').textContent); $('#copy').textContent = 'Скопійовано'; }
  catch { $('#copy').textContent = 'Виділіть текст і скопіюйте вручну'; }
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) { void readNativeState(); void refreshAll(); } });
window.addEventListener('svitloWidgetOpen', () => { void openWidgetAddress(); });
window.addEventListener('online', () => { void refreshAll(); });
setInterval(() => { if (!document.hidden) { if (android) void readNativeState(); else render(); } }, 30000);
setInterval(() => { if (!document.hidden) void refreshAll(); }, 5 * 60000);
for (const address of addresses) cached(address);
drawChips(); render();
if (!addresses.length) startWizard();
async function start() {
  if (android) {
    // Migrate scheduled alerts from the old JS planner exactly once per launch.
    try {
      const old = (await LocalNotifications.getPending()).notifications.filter(n => n.id >= 1 && n.id <= 60);
      if (old.length) await LocalNotifications.cancel({ notifications: old.map(n => ({ id: n.id })) });
    } catch (error) { log(error.message); }
    await configureNative();
    await openWidgetAddress(false);
  }
  await refreshAll();
}
void start();
