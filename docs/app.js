'use strict';

const STORAGE_KEY = 'sen.tracker.v1';
const CYCLE_LENGTH = 28;
const DAY_NAMES = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];
const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze',
                'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

const DEFAULT_HABITS = [
  { id: 'wstawanie', name: 'Stała pora wstawania', startWeek: 1 },
  { id: 'swiatlo', name: 'Poranne światło (5–10 min)', startWeek: 2 },
  { id: 'kofeina', name: 'Kofeina tylko do ~14:00', startWeek: 3 },
  { id: 'wyciszenie', name: 'Wyciszenie 30 min przed snem', startWeek: 3 },
  { id: 'ekrany', name: 'Bez ekranów w łóżku', startWeek: 4 },
];

const SEED_URL = './seed.json';

/* ------------------------------------------------------------------ dates */

function toISO(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fromISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

function addDays(iso, count) {
  const date = fromISO(iso);
  date.setDate(date.getDate() + count);
  return toISO(date);
}

function todayISO() {
  return toISO(new Date());
}

function longDate(iso) {
  const date = fromISO(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/* ------------------------------------------------------------------ state */

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function newCycle(startDate) {
  return {
    id: makeId(),
    startDate,
    createdAt: new Date().toISOString(),
    habits: DEFAULT_HABITS.map((habit) => ({ ...habit })),
    days: {},
  };
}

function defaultState() {
  const cycle = newCycle(todayISO());
  return {
    version: 1,
    activeCycleId: cycle.id,
    cycles: [cycle],
    settings: { dataUrl: './data.json', theme: 'auto' },
  };
}

function loadState() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.warn('localStorage niedostępny', error);
  }
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    if (!parsed.cycles || !parsed.cycles.length) return defaultState();
    parsed.settings = Object.assign({ dataUrl: './data.json', theme: 'auto' }, parsed.settings);
    return parsed;
  } catch (error) {
    console.warn('Nie udało się odczytać zapisanych danych', error);
    return defaultState();
  }
}

let state = loadState() || defaultState();
const freshInstall = !localStorageHasState();
let garmin = { generatedAt: null, days: {} };
let activeWeek = 1;

function localStorageHasState() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY));
  } catch (error) {
    return false;
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    toast('Nie udało się zapisać zmiany');
    console.error(error);
  }
}

function cycle() {
  return state.cycles.find((item) => item.id === state.activeCycleId) || state.cycles[0];
}

function cycleDates() {
  const start = cycle().startDate;
  return Array.from({ length: CYCLE_LENGTH }, (_, index) => addDays(start, index));
}

function dayRecord(date, create) {
  const days = cycle().days;
  if (!days[date] && create) days[date] = { checks: {} };
  const record = days[date];
  if (record && !record.checks) record.checks = {};
  return record || null;
}

function garminFor(date) {
  return garmin.days ? garmin.days[date] || null : null;
}

/* value shown in a cell: manual override wins and is never overwritten */
function resolved(date, key) {
  const record = dayRecord(date, false);
  if (record && record[key] !== undefined && record[key] !== null) {
    return { value: record[key], manual: true };
  }
  const auto = garminFor(date);
  if (auto && auto[key] !== undefined && auto[key] !== null) {
    return { value: auto[key], manual: false };
  }
  return { value: null, manual: false };
}

/* ------------------------------------------------------------------- view */

const wideScreen = window.matchMedia('(min-width: 900px)');

function visibleDates() {
  const dates = cycleDates();
  if (wideScreen.matches) return dates;
  const start = (activeWeek - 1) * 7;
  return dates.slice(start, start + 7);
}

function weekOfDate(date) {
  const dates = cycleDates();
  const index = dates.indexOf(date);
  return index < 0 ? 1 : Math.floor(index / 7) + 1;
}

function scoreClass(score) {
  if (score === null) return 'empty';
  if (score < 60) return 'e1';
  if (score < 80) return 'e3';
  return 'e5';
}

function renderMeta() {
  const start = cycle().startDate;
  const end = addDays(start, CYCLE_LENGTH - 1);
  const parts = [`Start: ${longDate(start)}`, `28 dni (do ${longDate(end)})`];
  if (garmin.generatedAt) {
    const stamp = new Date(garmin.generatedAt);
    parts.push(`Garmin: ${stamp.toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
  } else {
    parts.push('Garmin: brak danych');
  }
  document.getElementById('meta').textContent = parts.join(' · ');
}

function renderWeekbar() {
  const bar = document.getElementById('weekbar');
  bar.innerHTML = '';
  for (let week = 1; week <= 4; week += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Tydzień ${week}`;
    button.setAttribute('aria-pressed', String(week === activeWeek));
    button.addEventListener('click', () => {
      activeWeek = week;
      render();
    });
    bar.appendChild(button);
  }
}

function headCell(tag, text, className) {
  const cell = document.createElement(tag);
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderGrid() {
  const table = document.getElementById('grid');
  const dates = visibleDates();
  const today = todayISO();
  table.innerHTML = '';

  const head = document.createElement('thead');

  if (wideScreen.matches) {
    const weekRow = document.createElement('tr');
    weekRow.appendChild(headCell('th', 'Zgodnie z planem', 'rowhead'));
    for (let week = 1; week <= 4; week += 1) {
      const cell = headCell('th', `Tydzień ${week}`, 'weekgroup');
      cell.colSpan = 7;
      weekRow.appendChild(cell);
    }
    head.appendChild(weekRow);
  }

  const nameRow = document.createElement('tr');
  nameRow.appendChild(headCell('th', 'Dzień', 'rowhead'));
  const numRow = document.createElement('tr');
  numRow.appendChild(headCell('th', 'Nawyk \\ data', 'rowhead'));

  dates.forEach((date) => {
    const parsed = fromISO(date);
    const sunday = parsed.getDay() === 0;
    const isToday = date === today;
    const name = headCell('th', DAY_NAMES[parsed.getDay()],
      `dayname${sunday ? ' sunday' : ''}${isToday ? ' today' : ''}`);
    const num = headCell('th', String(parsed.getDate()),
      `daynum${sunday ? ' sunday' : ''}${isToday ? ' today' : ''}`);
    nameRow.appendChild(name);
    numRow.appendChild(num);
  });

  head.appendChild(nameRow);
  head.appendChild(numRow);
  table.appendChild(head);

  const body = document.createElement('tbody');

  cycle().habits.forEach((habit) => {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.className = 'rowhead';
    label.textContent = habit.name;
    row.appendChild(label);

    dates.forEach((date) => {
      const cell = document.createElement('td');
      const active = weekOfDate(date) >= habit.startWeek;
      cell.className = `day${active ? '' : ' inactive'}${date === today ? ' today' : ''}${date > today ? ' future' : ''}`;
      if (active) {
        const record = dayRecord(date, false);
        const on = Boolean(record && record.checks && record.checks[habit.id]);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cell';
        button.innerHTML = `<span class="check${on ? '' : ' off'}">${on ? '✔' : '·'}</span>`;
        button.setAttribute('aria-label', `${habit.name}, ${longDate(date)}`);
        button.setAttribute('aria-pressed', String(on));
        button.addEventListener('click', () => toggleHabit(date, habit.id));
        cell.appendChild(button);
      }
      row.appendChild(cell);
    });

    body.appendChild(row);
  });

  body.appendChild(summaryRow('Energia rano (1–5)', dates, today, (date) => {
    const record = dayRecord(date, false);
    const value = record && record.energy ? record.energy : null;
    return {
      text: value === null ? '·' : String(value),
      className: value === null ? 'empty' : `e${value}`,
      onClick: () => openEnergy(date),
    };
  }, true));

  body.appendChild(summaryRow('Garmin Sleep Score (0–100)', dates, today, (date) => {
    const { value, manual } = resolved(date, 'sleepScore');
    return {
      text: value === null ? '·' : String(value),
      className: `${value === null ? 'empty' : scoreClass(value)}${manual ? '' : ' auto'}`,
      onClick: () => openNumber(date, 'sleepScore'),
    };
  }));

  body.appendChild(summaryRow('Body Battery – wpływ netto snu (+/−)', dates, today, (date) => {
    const { value, manual } = resolved(date, 'bbDelta');
    return {
      text: value === null ? '·' : (value > 0 ? `+${value}` : String(value)),
      className: `${value === null ? 'empty' : (value >= 0 ? 'pos' : 'neg')}${manual ? '' : ' auto'}`,
      onClick: () => openNumber(date, 'bbDelta'),
    };
  }));

  body.appendChild(summaryRow('Notatka dnia', dates, today, (date) => {
    const record = dayRecord(date, false);
    const filled = Boolean(record && record.note && record.note.trim());
    return {
      html: `<span class="note-dot${filled ? '' : ' empty'}"></span>`,
      onClick: () => openNote(date),
    };
  }));

  table.appendChild(body);
}

function summaryRow(title, dates, today, build, sectionStart) {
  const row = document.createElement('tr');
  row.className = `summary${sectionStart ? ' section-start' : ''}`;
  const head = document.createElement('td');
  head.className = 'rowhead';
  head.textContent = title;
  row.appendChild(head);

  dates.forEach((date) => {
    const cell = document.createElement('td');
    cell.className = `day${date === today ? ' today' : ''}${date > today ? ' future' : ''}`;
    const spec = build(date);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cell';
    button.innerHTML = spec.html || `<span class="value ${spec.className}">${spec.text}</span>`;
    button.setAttribute('aria-label', `${title}, ${longDate(date)}`);
    button.addEventListener('click', spec.onClick);
    cell.appendChild(button);
    row.appendChild(cell);
  });

  return row;
}

function renderNotes() {
  const container = document.getElementById('notes');
  container.innerHTML = '<h2>Notatki dnia</h2>';
  visibleDates().forEach((date) => {
    const record = dayRecord(date, false);
    const text = record && record.note ? record.note.trim() : '';
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML =
      `<span class="when">${DAY_NAMES[fromISO(date).getDay()]} ${fromISO(date).getDate()}</span>` +
      `<span class="what${text ? '' : ' empty'}"></span>`;
    button.querySelector('.what').textContent = text || 'Dodaj notatkę…';
    button.addEventListener('click', () => openNote(date));
    container.appendChild(button);
  });
}

function render() {
  document.documentElement.dataset.theme = state.settings.theme;
  renderMeta();
  renderWeekbar();
  renderGrid();
  renderNotes();
}

/* ---------------------------------------------------------------- editing */

function toggleHabit(date, habitId) {
  const record = dayRecord(date, true);
  record.checks[habitId] = !record.checks[habitId];
  if (!record.checks[habitId]) delete record.checks[habitId];
  save();
  render();
}

function setDayValue(date, key, value) {
  const record = dayRecord(date, true);
  if (value === null || value === '') delete record[key];
  else record[key] = value;
  save();
  render();
}

/* ----------------------------------------------------------------- sheets */

const overlay = document.getElementById('overlay');
const sheet = document.getElementById('sheet');

function openSheet(html) {
  sheet.innerHTML = html;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  overlay.hidden = true;
  sheet.innerHTML = '';
  document.body.style.overflow = '';
}

overlay.addEventListener('click', (event) => {
  if (event.target === overlay) closeSheet();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !overlay.hidden) closeSheet();
});

let toastTimer = null;

function toast(message) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function openEnergy(date) {
  const record = dayRecord(date, false);
  const current = record && record.energy ? record.energy : null;
  const labels = ['Wyczerpany', 'Ospały', 'Średnio', 'Dobrze', 'W pełni wypoczęty'];

  openSheet(`
    <h2>Energia rano</h2>
    <p class="sheet-sub">${longDate(date)} · oceń przed kawą i telefonem</p>
    <div class="choices">
      ${[1, 2, 3, 4, 5].map((n) =>
        `<button type="button" data-value="${n}" aria-pressed="${current === n}">${n}</button>`).join('')}
    </div>
    <p class="hint">1 = ${labels[0]} · 5 = ${labels[4]}</p>
    <div class="row-actions">
      <button class="btn" type="button" data-action="clear">Wyczyść</button>
      <button class="btn primary" type="button" data-action="close">Gotowe</button>
    </div>
  `);

  sheet.querySelectorAll('[data-value]').forEach((button) => {
    button.addEventListener('click', () => {
      setDayValue(date, 'energy', Number(button.dataset.value));
      closeSheet();
    });
  });
  sheet.querySelector('[data-action="clear"]').addEventListener('click', () => {
    setDayValue(date, 'energy', null);
    closeSheet();
  });
  sheet.querySelector('[data-action="close"]').addEventListener('click', closeSheet);
}

function openNumber(date, key) {
  const isScore = key === 'sleepScore';
  const record = dayRecord(date, false);
  const manual = record && record[key] !== undefined ? record[key] : null;
  const auto = garminFor(date);
  const autoValue = auto ? auto[key] : null;

  const autoLine = autoValue === null || autoValue === undefined
    ? 'Garmin nie przysłał jeszcze wartości na ten dzień.'
    : `Z Garmina: <b>${isScore ? autoValue : (autoValue > 0 ? '+' + autoValue : autoValue)}</b>` +
      (auto && auto.bbStart !== undefined && !isScore
        ? ` (przy zaśnięciu ${auto.bbStart}, przy pobudce ${auto.bbEnd})` : '');

  openSheet(`
    <h2>${isScore ? 'Garmin Sleep Score' : 'Body Battery – wpływ netto snu'}</h2>
    <p class="sheet-sub">${longDate(date)}</p>
    <div class="field">
      <label for="numval">Wartość własna${isScore ? ' (0–100)' : ' (np. 53 lub -12)'}</label>
      <input type="number" id="numval" inputmode="numeric"
             ${isScore ? 'min="0" max="100"' : 'min="-100" max="100"'}
             value="${manual === null ? '' : manual}" placeholder="${autoValue ?? ''}">
    </div>
    <p class="hint">${autoLine}</p>
    <p class="hint">Wpisana ręcznie wartość ma pierwszeństwo i nie zostanie nadpisana przez synchronizację.</p>
    <div class="row-actions">
      <button class="btn" type="button" data-action="auto">Użyj Garmina</button>
      <button class="btn primary" type="button" data-action="save">Zapisz</button>
    </div>
  `);

  const input = sheet.querySelector('#numval');
  input.focus();

  sheet.querySelector('[data-action="auto"]').addEventListener('click', () => {
    setDayValue(date, key, null);
    closeSheet();
  });
  sheet.querySelector('[data-action="save"]').addEventListener('click', () => {
    const raw = input.value.trim();
    setDayValue(date, key, raw === '' ? null : Number(raw));
    closeSheet();
  });
}

function openNote(date) {
  const record = dayRecord(date, false);
  const text = record && record.note ? record.note : '';

  openSheet(`
    <h2>Notatka dnia</h2>
    <p class="sheet-sub">${longDate(date)}</p>
    <div class="field">
      <textarea id="noteval" placeholder="Co dziś wpłynęło na sen?">${text.replace(/</g, '&lt;')}</textarea>
    </div>
    <div class="row-actions">
      <button class="btn" type="button" data-action="cancel">Anuluj</button>
      <button class="btn primary" type="button" data-action="save">Zapisz</button>
    </div>
  `);

  const area = sheet.querySelector('#noteval');
  area.focus();

  sheet.querySelector('[data-action="cancel"]').addEventListener('click', closeSheet);
  sheet.querySelector('[data-action="save"]').addEventListener('click', () => {
    setDayValue(date, 'note', area.value.trim() || null);
    closeSheet();
  });
}

function openSettings() {
  const current = cycle();

  openSheet(`
    <h2>Ustawienia</h2>
    <p class="sheet-sub">Dane trzymane są tylko na tym urządzeniu.</p>

    <h3>Cykl</h3>
    <div class="field">
      <label for="cyclestart">Pierwszy dzień cyklu</label>
      <input type="date" id="cyclestart" value="${current.startDate}">
    </div>
    <button class="btn" type="button" data-action="new-cycle">Rozpocznij nowy cykl (28 dni)</button>
    <button class="btn" type="button" data-action="import-seed" style="margin-top:8px">Wczytaj arkusz startowy</button>
    <p class="hint">Uzupełnia puste pola danymi z papierowego arkusza. Twoje własne
    wpisy zostają nietknięte, więc można to zrobić wielokrotnie.</p>

    <h3>Nawyki</h3>
    <div class="habit-editor" id="habits"></div>
    <button class="btn" type="button" data-action="add-habit" style="margin-top:8px">Dodaj nawyk</button>
    <p class="hint">„Tydzień” to tydzień cyklu, w którym nawyk wchodzi do gry. Wcześniejsze pola
    zostają szare — zgodnie z zasadą narastającego wdrażania.</p>

    <h3>Dane z Garmina</h3>
    <div class="field">
      <label for="dataurl">Adres pliku data.json</label>
      <input type="url" id="dataurl" value="${state.settings.dataUrl}">
    </div>
    <p class="hint">${garmin.generatedAt
      ? 'Ostatnia aktualizacja: ' + new Date(garmin.generatedAt).toLocaleString('pl-PL')
      : 'Nie wczytano jeszcze żadnych danych.'}</p>

    <h3>Wygląd</h3>
    <div class="field">
      <label for="theme">Motyw</label>
      <select id="theme">
        <option value="auto">Jak w systemie</option>
        <option value="light">Jasny</option>
        <option value="dark">Ciemny</option>
      </select>
    </div>

    <h3>Cykle</h3>
    <div class="cycle-list" id="cycles"></div>

    <div class="row-actions">
      <button class="btn primary" type="button" data-action="close">Zamknij</button>
    </div>
  `);

  sheet.querySelector('#theme').value = state.settings.theme;

  renderHabitEditor();
  renderCycleList();

  sheet.querySelector('#cyclestart').addEventListener('change', (event) => {
    if (!event.target.value) return;
    current.startDate = event.target.value;
    save();
    render();
  });

  sheet.querySelector('#dataurl').addEventListener('change', (event) => {
    state.settings.dataUrl = event.target.value.trim() || './data.json';
    save();
    loadGarmin(true);
  });

  sheet.querySelector('#theme').addEventListener('change', (event) => {
    state.settings.theme = event.target.value;
    save();
    render();
  });

  sheet.querySelector('[data-action="add-habit"]').addEventListener('click', () => {
    current.habits.push({ id: makeId(), name: 'Nowy nawyk', startWeek: 1 });
    save();
    renderHabitEditor();
    render();
  });

  sheet.querySelector('[data-action="new-cycle"]').addEventListener('click', () => {
    const start = sheet.querySelector('#cyclestart').value || todayISO();
    const created = newCycle(start);
    created.habits = current.habits.map((habit) => ({ ...habit, id: makeId() }));
    state.cycles.push(created);
    state.activeCycleId = created.id;
    activeWeek = 1;
    save();
    closeSheet();
    render();
    toast('Nowy cykl rozpoczęty');
  });

  sheet.querySelector('[data-action="import-seed"]').addEventListener('click', async () => {
    await importSeed(true);
    closeSheet();
  });

  sheet.querySelector('[data-action="close"]').addEventListener('click', closeSheet);
}

function renderHabitEditor() {
  const container = sheet.querySelector('#habits');
  if (!container) return;
  const current = cycle();
  container.innerHTML = '';

  current.habits.forEach((habit) => {
    const row = document.createElement('div');
    row.className = 'habit-row';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = habit.name;
    name.addEventListener('change', () => {
      habit.name = name.value.trim() || 'Nawyk';
      save();
      render();
    });

    const week = document.createElement('select');
    [1, 2, 3, 4].forEach((n) => {
      const option = document.createElement('option');
      option.value = String(n);
      option.textContent = `Tydz. ${n}`;
      week.appendChild(option);
    });
    week.value = String(habit.startWeek);
    week.addEventListener('change', () => {
      habit.startWeek = Number(week.value);
      save();
      render();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Usuń nawyk';
    remove.addEventListener('click', () => {
      current.habits = current.habits.filter((item) => item.id !== habit.id);
      save();
      renderHabitEditor();
      render();
    });

    row.append(name, week, remove);
    container.appendChild(row);
  });
}

function renderCycleList() {
  const container = sheet.querySelector('#cycles');
  if (!container) return;
  container.innerHTML = '';

  state.cycles.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(item.id === state.activeCycleId));
    const days = Object.keys(item.days || {}).length;
    button.innerHTML = `<span>${longDate(item.startDate)}</span><span>${days} dni z wpisami</span>`;
    button.addEventListener('click', () => {
      state.activeCycleId = item.id;
      activeWeek = 1;
      save();
      render();
      renderCycleList();
      const startInput = sheet.querySelector('#cyclestart');
      if (startInput) startInput.value = cycle().startDate;
      renderHabitEditor();
    });
    container.appendChild(button);
  });
}

/* -------------------------------------------------------------- seed sheet */

async function fetchSeed() {
  const response = await fetch(`${SEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/* Fills in whatever the current cycle does not already have. Anything you have
   already entered on this device wins, so importing twice is harmless. */
function applySeed(seed) {
  const current = cycle();
  if (seed.startDate) current.startDate = seed.startDate;

  const known = new Map(current.habits.map((habit) => [habit.id, habit]));
  (seed.habits || []).forEach((habit) => {
    if (!known.has(habit.id)) current.habits.push({ ...habit });
  });

  let filled = 0;
  Object.entries(seed.days || {}).forEach(([date, entry]) => {
    const record = dayRecord(date, true);

    (entry.checks || []).forEach((habitId) => {
      if (record.checks[habitId] === undefined) {
        record.checks[habitId] = true;
        filled += 1;
      }
    });

    for (const key of ['energy', 'note', 'sleepScore', 'bbDelta']) {
      if (entry[key] !== undefined && entry[key] !== null && record[key] === undefined) {
        record[key] = entry[key];
        filled += 1;
      }
    }
  });

  save();
  pickInitialWeek();
  render();
  return filled;
}

async function importSeed(announce) {
  try {
    const filled = applySeed(await fetchSeed());
    if (announce) {
      toast(filled ? `Wczytano ${filled} wpisów z arkusza` : 'Brak nowych wpisów w arkuszu');
    }
  } catch (error) {
    console.warn('Nie udało się wczytać seed.json', error);
    if (announce) toast('Nie udało się wczytać arkusza');
  }
}

/* ------------------------------------------------------------ garmin data */

async function loadGarmin(announce) {
  const button = document.getElementById('refresh');
  button.dataset.busy = 'true';
  try {
    const url = state.settings.dataUrl + (state.settings.dataUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    garmin = { generatedAt: data.generatedAt || null, days: data.days || {} };
    try {
      localStorage.setItem(STORAGE_KEY + '.garmin', JSON.stringify(garmin));
    } catch (error) {
      console.warn('Nie udało się zapisać kopii danych Garmina', error);
    }
    render();
    if (announce) toast('Dane z Garmina odświeżone');
  } catch (error) {
    console.warn('Nie udało się pobrać data.json', error);
    if (announce) toast('Brak połączenia — pokazuję ostatnie dane');
  } finally {
    button.dataset.busy = 'false';
  }
}

function loadCachedGarmin() {
  try {
    const cached = localStorage.getItem(STORAGE_KEY + '.garmin');
    if (cached) garmin = JSON.parse(cached);
  } catch (error) {
    console.warn('Brak zapisanej kopii danych Garmina', error);
  }
}

/* ------------------------------------------------------------------ start */

function pickInitialWeek() {
  const dates = cycleDates();
  const index = dates.indexOf(todayISO());
  activeWeek = index < 0 ? 1 : Math.floor(index / 7) + 1;
}

document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('refresh').addEventListener('click', () => loadGarmin(true));
wideScreen.addEventListener('change', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadGarmin(false);
});

loadCachedGarmin();
pickInitialWeek();
save();
render();
if (freshInstall) importSeed(false);
loadGarmin(false);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service worker nie wystartował', error);
    });
  });
}
