import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { API_ORIGIN, TIME_ZONE, STATE_LABELS, members, groupsOf, kyivClock, addDays,
  hhmm, duration, formatSourceTimestamp, scheduleRequest, parseSchedules, intervals, statusInfo, alertEvents } from './core.js';

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
      const snapshot = { schedules, date, fetchedAt: Date.now(), stale: false };
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

function drawChips() {
  const chips = $('#chips');
  chips.replaceChildren();
  if (!addresses.length) chips.append(el('span', 'mut', 'Додайте будинок, щоб побачити його графік.'));
  for (const address of addresses) {
    const node = button(address.label, () => select(address.id), 'chip');
    node.setAttribute('aria-pressed', String(String(address.id) === selectedId));
    chips.append(node);
  }
}

function timestamp(ms) {
  return new Intl.DateTimeFormat('uk-UA', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function dayCard(title, date, day, minute, stale) {
  const card = el('section', 'card day');
  card.append(el('h3', null, `${title}, ${date.slice(8)}.${date.slice(5, 7)}`));
  if (!day || day.slots.every(s => s == null)) {
    card.append(el('p', 'mut', 'Графік для цієї підчерги ще не опубліковано.'));
    return card;
  }
  const sourceStamp = formatSourceTimestamp(day.updatedAt);
  if (sourceStamp) card.append(el('p', 'mut', `Оновлення на сайті обленерго: ${sourceStamp}`));
  if (stale) card.append(el('p', 'tMaybe', 'Збережений графік. Актуальність не підтверджена.'));
  const bar = el('div', 'bar');
  bar.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 48; i++) {
    const value = day.slots[i];
    const cell = el('i', value == null ? '' : `s${value}`);
    cell.title = `${hhmm(i * 30)}–${hhmm((i + 1) * 30)}: ${STATE_LABELS[value] ?? 'немає даних'}`;
    bar.append(cell);
  }
  if (minute != null && !stale) {
    const marker = el('b', 'now');
    marker.style.left = `${minute / 14.4}%`;
    bar.append(marker);
  }
  const axis = el('div', 'axis');
  for (const t of ['00', '06', '12', '18', '24']) axis.append(el('span', null, t));
  card.append(bar, axis);
  const legend = el('p', 'mut legend', '🟢 За графіком є · 🔴 Відключення · 🟡 Можливе · ⚪ Немає даних');
  card.append(legend);
  const table = el('table', 'intervals');
  const caption = el('caption', 'sr-only', `Усі інтервали: ${title}`);
  const body = el('tbody');
  for (const interval of intervals(day.slots)) {
    const row = el('tr');
    const label = el('td', `t${interval.value === 1 ? 'Off' : interval.value === 10 ? 'Maybe' : interval.value === 0 ? 'On' : ''}`,
      STATE_LABELS[interval.value] ?? 'Немає даних');
    row.append(el('th', null, `${hhmm(interval.start)}–${hhmm(interval.end)}`), label);
    body.append(row);
  }
  table.append(caption, body);
  card.append(table);
  return card;
}

function render() {
  const view = $('#view');
  view.replaceChildren();
  const address = addresses.find(a => String(a.id) === selectedId);
  if (!address) return;
  const snapshot = snapshots.get(selectedId);
  const loading = requests.has(selectedId);
  const header = el('section', 'card');
  header.append(el('h2', null, address.label));
  if (snapshot?.fetchedAt) header.append(el('p', 'mut', `Отримано: ${timestamp(snapshot.fetchedAt)} (Київ)`));
  const actions = el('div', 'row');
  const reload = button(loading ? 'Оновлюю…' : 'Оновити', async () => { await refresh(address); await planAlerts(); });
  reload.disabled = loading;
  actions.append(reload, button('Видалити адресу', () => remove(address.id)));
  header.append(actions);
  view.append(header);
  if (!snapshot?.schedules) {
    view.append(el('p', 'card', loading ? 'Завантажую графік…' : snapshot?.error ?? 'Немає даних. Натисніть «Оновити».'));
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
  if (groups.length > 1) view.append(el('p', 'card', 'Будинок має кілька підчерг. Показуємо окремий графік кожної: конкретне підключення може відрізнятися.'));
  for (const [group, days] of Object.entries(snapshot.schedules)) {
    const section = el('div', 'queue');
    section.append(el('h2', 'queue-title', `Підчерга ${group}`));
    if (!stale) {
      const info = statusInfo(days, date, min);
      const status = el('section', 'card');
      status.append(el('div', `big ${info.state === 1 ? 'tOff' : info.state === 0 ? 'tOn' : info.state === 10 ? 'tMaybe' : ''}`,
        STATE_LABELS[info.state] ?? 'Немає даних'), el('p', null, info.text));
      if (info.until != null && info.until <= lead) status.classList.add('warn');
      section.append(status);
    }
    section.append(dayCard('Сьогодні', date, days[date], min, stale),
      dayCard('Завтра', addDays(date, 1), days[addDays(date, 1)], null, stale));
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
$('#addBtn').onclick = startWizard;
$('#lead').value = String(lead);
$('#lead').onchange = async () => { lead = Number($('#lead').value); store.set('lead', lead); render(); await configureNative(); await planAlerts(); };
$('#backgroundOptions').hidden = !android;
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
  }
  await refreshAll();
}
void start();
