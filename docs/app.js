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
const GATE_URL = './gate.json';
const UNLOCK_KEY = `${STORAGE_KEY}.unlocked`;
const GATE_CACHE_KEY = `${STORAGE_KEY}.gate`;
const DATA_KEY_KEY = `${STORAGE_KEY}.datakey`;

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

/* ------------------------------------------------------------------- moon */

/* Full moon times from Meeus, Astronomical Algorithms ch. 49. The textbook
   mean-phase formula is simpler but runs up to 17 hours off, which in 2026
   alone puts the full moon on the wrong calendar day six times out of nine -
   visible to anyone who looks up at the sky. */
function fullMoonUTC(k) {
  const kk = k + 0.5;
  const T = kk / 1236.85;
  const rad = Math.PI / 180;
  let jde = 2451550.09766 + 29.530588861 * kk + 0.00015437 * T * T
    - 0.000000150 * T ** 3 + 0.00000000073 * T ** 4;

  const M = (2.5534 + 29.10535670 * kk - 0.0000014 * T * T) * rad;
  const Mp = (201.5643 + 385.81693528 * kk + 0.0107582 * T * T) * rad;
  const F = (160.7108 + 390.67050284 * kk - 0.0016118 * T * T) * rad;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;

  jde += -0.40614 + 0.17302 * E * Math.cos(M) + 0.01614 * Math.cos(2 * Mp)
    + 0.01043 * Math.cos(2 * F) + 0.00734 * E * Math.cos(Mp - M)
    - 0.00515 * E * Math.cos(Mp + M) + 0.00209 * E * E * Math.cos(2 * M)
    - 0.00111 * Math.cos(Mp - 2 * F) - 0.00057 * Math.cos(Mp + 2 * F)
    + 0.00056 * E * Math.cos(2 * Mp + M) - 0.00042 * Math.cos(3 * Mp)
    + 0.00042 * E * Math.cos(M + 2 * F) + 0.00038 * E * Math.cos(M - 2 * F);
  jde += 0.000325 * Math.sin((299.77 + 0.107408 * kk) * rad);

  return new Date((jde - 2440587.5) * 86400000);
}

/* Whole days from `iso` to the next full moon, 0 on the night itself. Counted
   between local calendar dates, so it matches what the sky does here rather
   than what UTC says. */
function daysToFullMoon(iso) {
  const day = fromISO(iso);
  // One lunation back, to be sure the search starts before the answer.
  let k = Math.floor((day.getTime() / 86400000 - 10957) / 29.530588853) - 1;
  for (let step = 0; step < 4; step += 1, k += 1) {
    const full = fullMoonUTC(k);
    const localDate = fromISO(toISO(full));
    const diff = Math.round((localDate - day) / 86400000);
    if (diff >= 0) return diff;
  }
  return null;
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

const PHONE_CELL = 66;   // day column width when the grid scrolls sideways
const PHONE_LABEL = 92;  // the sticky habit-name column

/* The grid always holds all 28 days now. On a phone it scrolls sideways with
   the habit names pinned; on a wide screen the columns simply fit. */
function visibleDates() {
  return cycleDates();
}

/* The notes list and the week buttons follow whatever the grid is scrolled to. */
function weekDates() {
  const start = (activeWeek - 1) * 7;
  return cycleDates().slice(start, start + 7);
}

function gridScroller() {
  return document.querySelector('.grid-wrap');
}

/* Scroll offset that puts `index` flush against the pinned column. Measured
   from the DOM rather than index * PHONE_CELL, so padding and borders in the
   chain cannot make the jumps drift. */
function dayOffset(index) {
  const scroller = gridScroller();
  const cell = document.querySelectorAll('#grid thead th.daynum')[index];
  if (!scroller || !cell) return 0;
  const left = cell.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
  return Math.max(0, scroller.scrollLeft + left - PHONE_LABEL);
}

function scrollToWeek(week, smooth) {
  const scroller = gridScroller();
  if (!scroller) return;
  scroller.scrollTo({
    left: dayOffset((week - 1) * 7),
    behavior: smooth ? 'smooth' : 'auto',
  });
}

/* Land on today. Called on start-up and again after the seed import, which
   can move the cycle's first day out from under the grid. */
function scrollToToday(smooth) {
  const scroller = gridScroller();
  const index = cycleDates().indexOf(todayISO());
  if (!scroller || index < 0) return;
  scroller.scrollTo({ left: dayOffset(index), behavior: smooth ? 'smooth' : 'auto' });
  activeWeek = Math.floor(index / 7) + 1;
  renderWeekbar();
  renderNotes();
  updateRail();
}

function weekFromScroll() {
  const scroller = gridScroller();
  if (!scroller) return activeWeek;
  const step = dayOffset(7);
  if (!step) return 1;
  return Math.min(4, Math.max(1, Math.round(scroller.scrollLeft / step) + 1));
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

/* The most recent date Garmin has a sleep score for, or null when there is
   nothing on file yet. */
function newestGarminDate() {
  const dates = Object.keys(garmin.days || {}).filter((date) => {
    const day = garmin.days[date];
    return day && day.sleepScore !== undefined && day.sleepScore !== null;
  });
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1];
}

function syncStamp() {
  if (!garmin.generatedAt) return null;
  return new Date(garmin.generatedAt).toLocaleString('pl-PL', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/* A missing night has several causes that look identical from here, so the
   sync writes down which one it found and this only phrases it. The fourth
   case is the absence of a note: nothing has even looked yet today. */
function missingNightReason() {
  const gap = garmin.gap;
  const stamp = syncStamp();

  if (gap && gap.date === todayISO()) {
    const upload = gap.deviceLastUpload
      ? new Date(gap.deviceLastUpload).toLocaleString('pl-PL', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
      : null;
    const watch = gap.device || 'Zegarek';

    if (gap.reason === 'watch-not-synced') {
      return upload
        ? `${watch} nie zsynchronizował się od ${upload} — otwórz aplikację Garmin Connect`
        : `${watch} nie zsynchronizował się — otwórz aplikację Garmin Connect`;
    }
    if (gap.reason === 'garmin-processing') {
      return 'Garmin nie policzył jeszcze tej nocy — dane zwykle dochodzą w ciągu godziny';
    }
    if (gap.reason === 'not-recorded') {
      return `${watch} nie zapisał tej nocy — prawdopodobnie nie był noszony`;
    }
  }

  /* No note for today means no sync run has looked since yesterday. */
  return stamp
    ? `brak dzisiejszej nocy — ostatnia synchronizacja ${stamp}`
    : 'brak dzisiejszej nocy';
}

function renderMeta() {
  const start = cycle().startDate;
  const end = addDays(start, CYCLE_LENGTH - 1);
  const parts = [`Start: ${longDate(start)}`, `28 dni (do ${longDate(end)})`];
  const meta = document.getElementById('meta');
  const stamp = syncStamp();
  const newest = newestGarminDate();

  /* Say so when last night is still missing. Without this the line shows only
     when the sync last ran, which looks healthy even while the night that
     matters never arrived. */
  if (stamp && newest && newest < todayISO()) {
    // Phones hide this line to buy height; a warning has to override that.
    meta.dataset.warn = 'true';
    meta.textContent = parts.join(' · ') + ' · ';
    const warn = document.createElement('span');
    warn.className = 'stale';
    warn.textContent = `Garmin: ${missingNightReason()}`;
    meta.appendChild(warn);
    return;
  }

  delete meta.dataset.warn;
  parts.push(stamp ? `Garmin: ${stamp}` : 'Garmin: brak danych');
  meta.textContent = parts.join(' · ');
}

/* ----------------------------------------------------------- token expiry */

/* Garmin's refresh token dies 30 days after it was issued, and the sync reads
   the same stored copy on every run, so the deadline never moves on its own.
   The sync writes it into data.json; here we only count down to it. */
const TOKEN_WARN_DAYS = 7;

function tokenDaysLeft() {
  if (!garmin.tokenExpires) return null;
  const deadline = fromISO(garmin.tokenExpires);
  if (Number.isNaN(deadline.getTime())) return null;
  const today = fromISO(todayISO());
  return Math.round((deadline - today) / 86400000);
}

function plDays(count) {
  return count === 1 ? '1 dzień' : `${count} dni`;
}

function renderTokenBar() {
  const bar = document.getElementById('tokenbar');
  if (!bar) return;
  const left = tokenDaysLeft();

  if (left === null || left > TOKEN_WARN_DAYS) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  bar.dataset.level = left <= 0 ? 'dead' : 'soon';
  bar.textContent = left <= 0
    ? `Dostęp do Garmina wygasł ${longDate(garmin.tokenExpires)} — nowe dane nie przychodzą. Dotknij, aby odnowić.`
    : `Dostęp do Garmina wygasa za ${plDays(left)} (${longDate(garmin.tokenExpires)}). Dotknij, aby odnowić.`;
}

function openTokenHelp() {
  const left = tokenDaysLeft();
  const headline = left !== null && left <= 0
    ? `Dostęp wygasł ${longDate(garmin.tokenExpires)}.`
    : `Dostęp wygasa ${longDate(garmin.tokenExpires)}.`;

  openSheet(`
    <h2>Odnów dostęp do Garmina</h2>
    <p class="sheet-sub">${headline} Garmin wydaje token ważny 30 dni — po tym czasie
    synchronizacja przestaje pobierać nowe noce, dopóki nie wgrasz nowego.</p>

    <p class="hint">Tego kroku nie da się wykonać w samej aplikacji: musiałaby
    przechowywać hasło do GitHuba, a strona jest publiczna. Zrób to na komputerze —
    zajmuje minutę.</p>

    <h3>1. Zaloguj się do Garmina</h3>
    <p class="hint">W terminalu, w katalogu projektu. Zapyta o e-mail, hasło i kod MFA.</p>
    <code class="cmd" id="cmd1">.venv/bin/python scripts/garmin_login.py</code>
    <button class="btn" type="button" data-action="copy1" style="margin-top:8px">Kopiuj polecenie</button>

    <h3>2. Wyślij nowy token do GitHuba</h3>
    <p class="hint">Token idzie prosto do sekretu, nie pokazuje się na ekranie.</p>
    <code class="cmd" id="cmd2">.venv/bin/python scripts/garmin_login.py --show-tokens | gh secret set GARMIN_TOKENS</code>
    <button class="btn" type="button" data-action="copy2" style="margin-top:8px">Kopiuj polecenie</button>

    <h3>3. Sprawdź</h3>
    <p class="hint">Data poniżej zmieni się po najbliższej synchronizacji — zwykle w ciągu
    kilku godzin. Możesz też podejrzeć sekret na GitHubie.</p>
    <a class="btn" href="https://github.com/tgolembiewski/sleep-tracker/settings/secrets/actions"
       target="_blank" rel="noopener">Otwórz sekrety na GitHubie</a>

    <div class="row-actions">
      <button class="btn primary" type="button" data-action="close">Zamknij</button>
    </div>
  `);

  const copy = (id) => async () => {
    const text = sheet.querySelector('#' + id).textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('Skopiowano');
    } catch (error) {
      /* Clipboard needs a secure context and a permission the browser may
         refuse; selecting the text leaves the user a working fallback. */
      const range = document.createRange();
      range.selectNodeContents(sheet.querySelector('#' + id));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast('Zaznaczono — skopiuj ręcznie');
    }
  };

  sheet.querySelector('[data-action="copy1"]').addEventListener('click', copy('cmd1'));
  sheet.querySelector('[data-action="copy2"]').addEventListener('click', copy('cmd2'));
  sheet.querySelector('[data-action="close"]').addEventListener('click', closeSheet);
}

function renderWeekbar() {
  const bar = document.getElementById('weekbar');
  bar.innerHTML = '';

  for (let week = 1; week <= 4; week += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    // "Tydzień 1" wraps to two lines at 375 px once the Dziś button is there.
    button.textContent = `T${week}`;
    button.setAttribute('aria-label', `Tydzień ${week}`);
    button.setAttribute('aria-pressed', String(week === activeWeek));
    button.addEventListener('click', () => {
      activeWeek = week;
      scrollToWeek(week, true);
      renderWeekbar();
      renderNotes();
    });
    bar.appendChild(button);
  }

  const today = todayISO();
  const index = cycleDates().indexOf(today);
  if (index >= 0) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jump';
    jump.textContent = 'Dziś';
    jump.addEventListener('click', () => {
      const scroller = gridScroller();
      if (scroller) scroller.scrollTo({ left: dayOffset(index), behavior: 'smooth' });
    });
    bar.appendChild(jump);
  }
}

/* U+2714 defaults to emoji presentation on iOS, and a colour-emoji glyph
   ignores CSS `color` — the ticks came out grey on iPhone and green on
   Android. Drawing the mark removes the font from the question entirely. */
const CHECK_SVG = '<svg class="tick-svg" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M2.6 8.4 6.2 12l7.2-8" fill="none" stroke="currentColor"'
  + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CROSS_SVG = '<svg class="tick-svg" viewBox="0 0 16 16" aria-hidden="true">'
  + '<path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" fill="none" stroke="currentColor"'
  + ' stroke-width="2.4" stroke-linecap="round"/></svg>';

/* A habit cell holds one of three states, and the difference matters:
   undefined is "not filled in", false is "deliberately missed". */
const DONE = true;
const MISSED = false;

function habitState(date, habitId) {
  const record = dayRecord(date, false);
  if (!record || !record.checks) return undefined;
  return record.checks[habitId];
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

  // Two header rows cost twice the height; on a phone the weekday and the
  // date share one line instead.
  const oneHeaderRow = !wideScreen.matches;
  const nameRow = document.createElement('tr');
  nameRow.appendChild(headCell('th', oneHeaderRow ? 'Nawyk \\ data' : 'Dzień', 'rowhead'));
  const numRow = document.createElement('tr');
  if (!oneHeaderRow) numRow.appendChild(headCell('th', 'Nawyk \\ data', 'rowhead'));

  dates.forEach((date, index) => {
    const parsed = fromISO(date);
    const sunday = parsed.getDay() === 0;
    const isToday = date === today;
    const starts = index % 7 === 0 && index > 0;
    const marks = `${sunday ? ' sunday' : ''}${isToday ? ' today' : ''}${starts ? ' weekstart' : ''}`;

    if (oneHeaderRow) {
      // Still carries the daynum class: the scroll snapping and the week jumps
      // both measure from it.
      const cell = headCell('th', '', `daynum${marks}`);
      cell.innerHTML = `<span class="dow">${DAY_NAMES[parsed.getDay()]}</span>`
        + `<span class="dom">${parsed.getDate()}</span>`;
      nameRow.appendChild(cell);
      return;
    }

    nameRow.appendChild(headCell('th', DAY_NAMES[parsed.getDay()], `dayname${marks}`));
    numRow.appendChild(headCell('th', String(parsed.getDate()), `daynum${marks}`));
  });

  head.appendChild(nameRow);
  if (!oneHeaderRow) head.appendChild(numRow);
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
      const starts = dates.indexOf(date) % 7 === 0 && dates.indexOf(date) > 0;
      cell.className = `day${active ? '' : ' inactive'}${date === today ? ' today' : ''}`
        + `${date > today ? ' future' : ''}${starts ? ' weekstart' : ''}`;
      if (active) {
        const mark = habitState(date, habit.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cell';

        if (mark === DONE) {
          button.innerHTML = `<span class="check">${CHECK_SVG}</span>`;
        } else if (mark === MISSED) {
          button.innerHTML = `<span class="check miss">${CROSS_SVG}</span>`;
        } else {
          button.innerHTML = '<span class="check off">·</span>';
        }

        // aria-pressed cannot describe three states, so say it plainly.
        const said = mark === DONE ? 'zrobione'
          : mark === MISSED ? 'nie zrobione' : 'brak wpisu';
        button.setAttribute('aria-label', `${habit.name}, ${longDate(date)}: ${said}`);
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

  body.appendChild(summaryRow('Sen: zaśnięcie / pobudka', dates, today, (date) => {
    const auto = garminFor(date);
    if (!auto || !auto.sleepStart || !auto.sleepEnd) {
      return { html: '<span class="value empty">·</span>' };
    }
    return {
      html: `<span class="hours"><b>${auto.sleepStart}</b>${auto.sleepEnd}</span>`,
    };
  }, false, true));

  body.appendChild(summaryRow('Kroki', dates, today, (date) => {
    const auto = garminFor(date);
    const steps = auto && auto.steps !== undefined && auto.steps !== null ? auto.steps : null;
    return {
      html: steps === null
        ? '<span class="value empty">·</span>'
        // A thin space groups the thousands without widening the column much.
        : `<span class="value steps">${String(steps).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009')}</span>`,
    };
  }, false, true));

  body.appendChild(summaryRow('Dzień cyklu', dates, today, (date) => {
    const day = cycleDays[date];
    return {
      html: day === undefined
        ? '<span class="value empty">·</span>'
        : `<span class="value cycle">${day}</span>`,
    };
  }, false, true));

  body.appendChild(summaryRow('Księżyc: dni do pełni', dates, today, (date) => {
    const left = daysToFullMoon(date);
    if (left === null) return { html: '<span class="value empty">·</span>' };
    return {
      html: left === 0
        ? '<span class="value moon full">\u25CF</span>'
        : `<span class="value moon">${left}</span>`,
    };
  }, false, true));

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

/* The label column is 92px on a phone, so a full title wraps to two or three
   lines and the row grows with it. The short form is the same row named for
   the narrow column; the legend under the table carries the long explanation
   either way. */
const SHORT_LABELS = {
  'Energia rano (1–5)': 'Energia rano',
  'Garmin Sleep Score (0–100)': 'Sleep Score',
  'Body Battery – wpływ netto snu (+/−)': 'Body Battery',
  'Sen: zaśnięcie / pobudka': 'Sen: zaśn./pob.',
  'Księżyc: dni do pełni': 'Do pełni',
  'Notatka dnia': 'Notatka',
};

function summaryRow(fullTitle, dates, today, build, sectionStart, readOnly) {
  const title = wideScreen.matches
    ? fullTitle
    : (SHORT_LABELS[fullTitle] || fullTitle);
  const row = document.createElement('tr');
  row.className = `summary${sectionStart ? ' section-start' : ''}`;
  const head = document.createElement('td');
  head.className = 'rowhead';
  head.textContent = title;
  row.appendChild(head);

  dates.forEach((date, index) => {
    const cell = document.createElement('td');
    const starts = index % 7 === 0 && index > 0;
    cell.className = `day${date === today ? ' today' : ''}`
      + `${date > today ? ' future' : ''}${starts ? ' weekstart' : ''}`;
    const spec = build(date);
    const body = spec.html || `<span class="value ${spec.className}">${spec.text}</span>`;

    if (readOnly) {
      const box = document.createElement('div');
      box.className = 'cell';
      box.innerHTML = body;
      cell.appendChild(box);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cell';
      button.innerHTML = body;
      button.setAttribute('aria-label', `${title}, ${longDate(date)}`);
      button.addEventListener('click', spec.onClick);
      cell.appendChild(button);
    }
    row.appendChild(cell);
  });

  return row;
}

function renderNotes() {
  const container = document.getElementById('notes');
  container.innerHTML = `<h2>Notatki dnia · tydzień ${activeWeek}</h2>`;
  weekDates().forEach((date) => {
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

/* On a phone the day columns keep a fixed width and the table is wider than
   the screen; on a wide screen the columns share whatever space there is. */
function sizeGrid() {
  const table = document.getElementById('grid');
  if (!table) return;
  table.style.width = wideScreen.matches
    ? ''
    : `${PHONE_LABEL + CYCLE_LENGTH * PHONE_CELL}px`;
}

function updateRail() {
  const scroller = gridScroller();
  const thumb = document.getElementById('rail-thumb');
  if (!scroller || !thumb) return;

  const span = scroller.scrollWidth - scroller.clientWidth;
  const visible = Math.min(1, scroller.clientWidth / Math.max(1, scroller.scrollWidth));
  thumb.style.width = `${Math.max(12, visible * 100)}%`;
  thumb.style.marginLeft = span > 0
    ? `${(scroller.scrollLeft / span) * (100 - Math.max(12, visible * 100))}%`
    : '0%';
}

function render() {
  document.documentElement.dataset.theme = state.settings.theme;

  // Rebuilding the table empties the scroller, which would throw it back to
  // day one; hold the offset and restore it once the rows are in place.
  const scroller = gridScroller();
  const keepAt = scroller ? scroller.scrollLeft : 0;

  renderMeta();
  renderTokenBar();
  renderWeekbar();
  renderGrid();
  sizeGrid();

  const after = gridScroller();
  if (after) after.scrollLeft = keepAt;

  renderNotes();
  updateRail();
}

/* ---------------------------------------------------------------- editing */

/* empty → done → missed → empty */
function toggleHabit(date, habitId) {
  const record = dayRecord(date, true);
  const current = record.checks[habitId];

  if (current === undefined) record.checks[habitId] = DONE;
  else if (current === DONE) record.checks[habitId] = MISSED;
  else delete record.checks[habitId];

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

/* The cycle day fails quietly by design - it is one row, not the app - so
   Settings is where the reason has to be findable. */
function cycleHint() {
  const status = garmin.cycle && garmin.cycle.status;
  if (status === 'passphrase-mismatch') {
    return '<p class="hint stale">Sekret APP_PASSPHRASE nie zgadza się z hasłem'
      + ' aplikacji — dzień cyklu nie jest zapisywany.</p>';
  }
  if (status === 'no-gate') {
    return '<p class="hint stale">Brak gate.json — dzień cyklu nie jest szyfrowany'
      + ' ani zapisywany.</p>';
  }
  if (cycleKeyBad) {
    return '<p class="hint stale">Nie udało się odszyfrować dnia cyklu na tym'
      + ' urządzeniu — hasło zmieniło się po ostatnim odblokowaniu.</p>';
  }
  return '';
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
    <div class="field">
      <label for="ghtoken">Token GitHub (dla przycisku ⟳)</label>
      <input type="password" id="ghtoken" autocomplete="off" autocapitalize="off"
             autocorrect="off" spellcheck="false"
             value="${state.settings.githubToken ? '········' : ''}"
             placeholder="wklej token, aby odświeżać na żądanie">
    </div>
    <p class="hint">Bez tokenu ⟳ tylko wczytuje to, co już opublikowano. Z tokenem
    uruchamia pobranie z Garmina od razu. Token zostaje na tym urządzeniu — nie ma
    go w kodzie strony. Zobacz <b>Jak odnowić?</b> poniżej, jeśli nie wiesz, skąd go wziąć.</p>
    <p class="hint">${garmin.generatedAt
      ? 'Ostatnia aktualizacja: ' + new Date(garmin.generatedAt).toLocaleString('pl-PL')
      : 'Nie wczytano jeszcze żadnych danych.'}</p>
    ${cycleHint()}
    ${garmin.tokenExpires ? `<p class="hint">Dostęp do Garmina ważny do:
      <b>${longDate(garmin.tokenExpires)}</b>.
      <button class="linkish" type="button" data-action="token-help">Jak odnowić?</button></p>` : ''}

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

  const tokenHelp = sheet.querySelector('[data-action="token-help"]');
  if (tokenHelp) tokenHelp.addEventListener('click', openTokenHelp);

  renderHabitEditor();
  renderCycleList();

  sheet.querySelector('#cyclestart').addEventListener('change', (event) => {
    if (!event.target.value) return;
    current.startDate = event.target.value;
    save();
    render();
    scrollToToday(false);
  });

  sheet.querySelector('#ghtoken').addEventListener('change', (event) => {
    const value = event.target.value.trim();
    /* The masked placeholder means "unchanged", so only a real edit counts. */
    if (value === '········') return;
    state.settings.githubToken = value;
    save();
    toast(value ? 'Token zapisany na tym urządzeniu' : 'Token usunięty');
    event.target.value = value ? '········' : '';
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
  requestAnimationFrame(() => scrollToToday(false));
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

/* ------------------------------------------------------- sync on demand */

const DISPATCH_URL =
  'https://api.github.com/repos/tgolembiewski/sleep-tracker/actions/workflows/garmin-sync.yml/dispatches';
const POLL_EVERY = 8000;
const POLL_LIMIT = 120000;

/* Asking GitHub to run the sync now, straight from the browser - the API sends
   Access-Control-Allow-Origin: *, so no middleman is needed. The token is the
   user's own, typed into Settings on each device and kept in localStorage; it
   is never part of the published page, which anyone can read. */
async function dispatchSync(token) {
  const response = await fetch(DISPATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { days: '1' } }),
  });

  if (response.status === 204) return;  /* success carries no body */

  /* Never let the token itself reach a message. */
  if (response.status === 401) throw new Error('Token odrzucony — wygasł lub jest błędny');
  if (response.status === 403) throw new Error('Token bez uprawnień (Actions: Read and write)');
  if (response.status === 404) throw new Error('Nie znaleziono repozytorium lub workflow');
  throw new Error(`GitHub odpowiedział HTTP ${response.status}`);
}

async function fetchGarminFile() {
  const url = state.settings.dataUrl
    + (state.settings.dataUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function applyGarmin(data) {
  garmin = {
    generatedAt: data.generatedAt || null,
    days: data.days || {},
    tokenExpires: data.tokenExpires || null,
    gap: data.gap || null,
    cycle: data.cycle || null,
  };
  try {
    localStorage.setItem(STORAGE_KEY + '.garmin', JSON.stringify(garmin));
  } catch (error) {
    console.warn('Nie udało się zapisać kopii danych Garmina', error);
  }
  await decryptCycle();
  render();
}

let syncing = false;

/* Fire the workflow, then watch data.json until the run publishes something
   new. The run itself takes about a minute, but a scheduled run already in
   flight holds the concurrency group and ours waits its turn, so the window
   is generous and a timeout is not a failure.

   `quiet` is for the run the app starts by itself: the dimmed refresh button
   is signal enough, and an error nobody asked for should not interrupt
   anything. Arriving data still announces itself either way. */
async function syncNow(options) {
  if (syncing) return;
  const quiet = Boolean(options && options.quiet);
  const token = (state.settings.githubToken || '').trim();
  if (!token) { if (!quiet) loadGarmin(true); return; }

  const button = document.getElementById('refresh');
  syncing = true;
  button.dataset.busy = 'true';

  try {
    await dispatchSync(token);
    if (!quiet) toast('Synchronizacja uruchomiona…');

    const before = garmin.generatedAt;
    const deadline = Date.now() + POLL_LIMIT;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_EVERY));
      try {
        const data = await fetchGarminFile();
        if (data.generatedAt && data.generatedAt !== before) {
          applyGarmin(data);
          toast('Dane z Garmina odświeżone');
          return;
        }
      } catch (error) {
        /* One failed poll is not the end of the run; keep waiting. */
        console.warn('Sprawdzenie danych nie powiodło się', error);
      }
    }
    if (!quiet) toast('Synchronizacja trwa dłużej — sprawdź za chwilę');
  } catch (error) {
    if (!quiet) toast(error.message);
    console.warn('Nie udało się uruchomić synchronizacji', error);
  } finally {
    syncing = false;
    button.dataset.busy = 'false';
  }
}

const AUTO_KEY = STORAGE_KEY + '.lastAutoSync';
const AUTO_COOLDOWN = 20 * 60 * 1000;
const AUTO_EARLIEST_HOUR = 6;

/* Whether opening the app should go and fetch the night by itself.

   An installed app is resumed far more often than it is opened, so every
   guard here exists to stop that turning into a stream of pointless runs:
   nothing to fetch, too early for the night to exist, a night Garmin has
   already said was never recorded, or simply too soon after the last try. */
function shouldAutoSync() {
  if (!(state.settings.githubToken || '').trim()) return false;

  const today = todayISO();
  const newest = newestGarminDate();
  if (newest && newest >= today) return false;

  // Before dawn the night is not over yet, so there is nothing to ask for.
  if (new Date().getHours() < AUTO_EARLIEST_HOUR) return false;

  // Garmin has already told us this night does not exist. It will not appear
  // later, and asking again every time the app is opened would be noise.
  const gap = garmin.gap;
  if (gap && gap.date === today && gap.reason === 'not-recorded') return false;

  let last = 0;
  try {
    last = Number(localStorage.getItem(AUTO_KEY)) || 0;
  } catch (error) {
    /* No storage: fall through and allow it, at worst one run per launch. */
  }
  return Date.now() - last > AUTO_COOLDOWN;
}

/* Deliberately not awaited by the caller: the interface is already drawn from
   the cached copy, and the run takes a minute it should not be waiting on. */
function autoSync() {
  if (!shouldAutoSync()) return;
  try {
    localStorage.setItem(AUTO_KEY, String(Date.now()));
  } catch (error) {
    console.warn('Nie udało się zapisać czasu synchronizacji', error);
  }
  syncNow({ quiet: true });
}

async function loadGarmin(announce) {
  const button = document.getElementById('refresh');
  button.dataset.busy = 'true';
  try {
    const url = state.settings.dataUrl + (state.settings.dataUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await applyGarmin(await response.json());
    if (announce) toast('Dane z Garmina odświeżone');
  } catch (error) {
    console.warn('Nie udało się pobrać data.json', error);
    if (announce) toast('Brak połączenia — pokazuję ostatnie dane');
  } finally {
    button.dataset.busy = 'false';
  }
}

async function loadCachedGarmin() {
  try {
    const cached = localStorage.getItem(STORAGE_KEY + '.garmin');
    if (cached) garmin = JSON.parse(cached);
  } catch (error) {
    console.warn('Brak zapisanej kopii danych Garmina', error);
  }
  await decryptCycle();
}

/* ------------------------------------------------------------------ print */

/* Rebuilds the paper sheet the tracker was copied from: one A4 landscape page,
   28 columns, the same rows and the same wording. Filling it in is optional, so
   the same button also produces a blank sheet to hang on the fridge. */

const ENERGY_SCALE = [
  ['Wyczerpany', 'budzik to udręka, ciężka głowa, „mgła”'],
  ['Ospały', 'wstajesz z trudem, rozkręcasz się wolno'],
  ['Średnio', 'funkcjonujesz, ale bez energii — „da się”'],
  ['Dobrze', 'wstajesz lekko, szybko gotowy do działania'],
  ['W pełni wypoczęty', 'budzisz się bez walki, jasna głowa od razu'],
];

function printCell(row, className, text) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  if (text) cell.innerHTML = text;
  row.appendChild(cell);
  return cell;
}

function buildPrintSheet(withData) {
  const host = document.getElementById('printsheet');
  const dates = cycleDates();
  const current = cycle();
  const start = current.startDate;
  const end = addDays(start, CYCLE_LENGTH - 1);

  host.innerHTML = '';

  const title = document.createElement('h1');
  title.textContent = 'Tracker nawyków snu';
  host.appendChild(title);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.innerHTML = `Start: <b>${longDate(start)}</b> · 28 dni (do ${longDate(end)}) · `
    + 'odhaczaj codziennie wieczorem · śledź tylko nawyki, które są już aktywne';
  host.appendChild(sub);

  const table = document.createElement('table');
  table.className = 'psheet';

  const head = document.createElement('thead');

  const weekRow = document.createElement('tr');
  const weekLab = document.createElement('th');
  weekLab.className = 'lab';
  weekLab.textContent = 'Zgodnie z planem';
  weekRow.appendChild(weekLab);
  for (let week = 1; week <= 4; week += 1) {
    const cell = document.createElement('th');
    cell.colSpan = 7;
    cell.textContent = `Tydzień ${week}`;
    if (week > 1) cell.className = 'weekstart';
    weekRow.appendChild(cell);
  }
  head.appendChild(weekRow);

  const dayRow = document.createElement('tr');
  const dayLab = document.createElement('th');
  dayLab.className = 'lab';
  dayLab.textContent = 'Dzień';
  dayRow.appendChild(dayLab);

  const numRow = document.createElement('tr');
  numRow.className = 'nums';
  const numLab = document.createElement('th');
  numLab.className = 'lab';
  numLab.textContent = 'Nawyk \\ data';
  numRow.appendChild(numLab);

  dates.forEach((date, index) => {
    const parsed = fromISO(date);
    const classes = [
      parsed.getDay() === 0 ? 'sun' : '',
      index % 7 === 0 && index > 0 ? 'weekstart' : '',
    ].filter(Boolean).join(' ');

    const name = document.createElement('th');
    name.textContent = DAY_NAMES[parsed.getDay()];
    if (classes) name.className = classes;
    dayRow.appendChild(name);

    const num = document.createElement('th');
    num.textContent = String(parsed.getDate());
    if (classes) num.className = classes;
    numRow.appendChild(num);
  });

  head.appendChild(dayRow);
  head.appendChild(numRow);
  table.appendChild(head);

  const body = document.createElement('tbody');

  current.habits.forEach((habit) => {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.className = 'lab';
    label.textContent = habit.name;
    row.appendChild(label);

    dates.forEach((date, index) => {
      const live = weekOfDate(date) >= habit.startWeek;
      const mark = withData && live ? habitState(date, habit.id) : undefined;
      const classes = [
        live ? '' : 'off',
        index % 7 === 0 && index > 0 ? 'weekstart' : '',
      ].filter(Boolean).join(' ');

      let glyph = '';
      if (mark === DONE) glyph = `<span class="tick">${CHECK_SVG}</span>`;
      else if (mark === MISSED) glyph = `<span class="tick miss">${CROSS_SVG}</span>`;
      printCell(row, classes, glyph);
    });
    body.appendChild(row);
  });

  const summaryRowFor = (title_, first, value) => {
    const row = document.createElement('tr');
    row.className = 'sum' + (first ? ' first-sum' : '');
    const label = document.createElement('th');
    label.className = 'lab';
    label.innerHTML = title_;
    row.appendChild(label);

    dates.forEach((date, index) => {
      const text = withData ? value(date) : '';
      const classes = index % 7 === 0 && index > 0 ? 'weekstart' : '';
      printCell(row, classes, text ? `<span class="num">${text}</span>` : '');
    });
    body.appendChild(row);
  };

  summaryRowFor('Energia rano (1–5)', true, (date) => {
    const record = dayRecord(date, false);
    return record && record.energy ? String(record.energy) : '';
  });

  summaryRowFor('Garmin Sleep Score (0–100)', false, (date) => {
    const { value } = resolved(date, 'sleepScore');
    return value === null ? '' : String(value);
  });

  summaryRowFor('Body Battery – wpływ netto snu (+/−)', false, (date) => {
    const { value } = resolved(date, 'bbDelta');
    if (value === null) return '';
    return value > 0 ? `+${value}` : String(value);
  });

  const noteRow = document.createElement('tr');
  noteRow.className = 'pnotes';
  const noteLab = document.createElement('th');
  noteLab.className = 'lab';
  noteLab.innerHTML = 'Notatka dnia<small>(pisz pionowo)</small>';
  noteRow.appendChild(noteLab);

  dates.forEach((date, index) => {
    const record = dayRecord(date, false);
    const text = withData && record && record.note ? record.note.replace(/\n/g, ' · ') : '';
    const cell = printCell(noteRow, index % 7 === 0 && index > 0 ? 'weekstart' : '', '');
    if (text) {
      const span = document.createElement('span');
      span.className = 'vnote';
      span.textContent = text;
      cell.appendChild(span);
    }
  });
  body.appendChild(noteRow);

  table.appendChild(body);
  host.appendChild(table);

  const howto = document.createElement('p');
  howto.className = 'howto';
  howto.innerHTML = '<b>Jak używać:</b> „✔︎” = zrobione, „✘” = nie zrobione, puste pole = '
    + 'brak wpisu · <b>szare pola</b> = tego '
    + 'nawyku jeszcze nie śledzisz (dochodzi w danym tygodniu wg planu) · w wierszu '
    + '<b>Energia rano</b> wpisz liczbę <b>1–5</b> (1 = wyczerpany, 5 = w pełni wypoczęty) · '
    + '<b>zasada „nigdy dwa razy z rzędu”</b>: jeden opuszczony dzień to wypadek, dwóch z rzędu '
    + 'nie odpuszczaj.';
  host.appendChild(howto);

  const scaleTitle = document.createElement('h2');
  scaleTitle.textContent = 'Skala „Energia rano” (oceń w pierwszych minutach po wstaniu, przed kawą i telefonem)';
  host.appendChild(scaleTitle);

  const scale = document.createElement('div');
  scale.className = 'pscale';
  ENERGY_SCALE.forEach(([name, hint], index) => {
    const box = document.createElement('div');
    box.innerHTML = `<span class="badge s${index + 1}">${index + 1}</span>`
      + `<b>${name}</b><span>${hint}</span>`;
    scale.appendChild(box);
  });
  host.appendChild(scale);

  const trend = document.createElement('p');
  trend.className = 'fine';
  trend.textContent = 'Liczy się trend, nie pojedynczy dzień: plan działa, jeśli w kolejnych '
    + 'tygodniach coraz częściej wpisujesz 4–5 zamiast 2–3. Niski wynik to informacja, nie ocena Ciebie.';
  host.appendChild(trend);

  const scoreNote = document.createElement('p');
  scoreNote.className = 'fine';
  scoreNote.innerHTML = '<b>Garmin Sleep Score (0–100):</b> poniżej 60 = słabo · 60–79 = przyzwoicie · '
    + '80–89 = dobrze · 90–100 = doskonale. Wynik wczytuje się z Garmin Connect obok Twojej oceny '
    + 'energii — po tygodniu zobaczysz, czy odczucie i dane idą w tę samą stronę (rozjazdy też są '
    + 'ciekawą wskazówką). W wierszu <b>Body Battery – wpływ netto snu</b> jest przyrost z Garmin '
    + 'Connect (poziom przy pobudce minus przy zaśnięciu, np. +53) — często lepiej niż sam wynik snu '
    + 'tłumaczy, dlaczego czułeś się słabo mimo dobrej nocy.';
  host.appendChild(scoreNote);

  const tip = document.createElement('p');
  tip.className = 'fine';
  tip.textContent = 'Wskazówka: śledź nawyki narastająco zgodnie z planem — w tygodniu 1 tylko '
    + '„stała pora wstawania”, w kolejnych dokładaj następne wiersze.';
  host.appendChild(tip);
}

function openPrint() {
  openSheet(`
    <h2>Drukuj arkusz</h2>
    <p class="sheet-sub">Jedna strona A4 poziomo, dokładnie jak papierowy arkusz.</p>
    <div class="row-actions" style="flex-direction:column">
      <button class="btn primary" type="button" data-action="with">Z moimi wpisami</button>
      <button class="btn" type="button" data-action="blank">Pusty arkusz do wypełnienia</button>
    </div>
    <p class="hint">W wierszu „Notatka dnia” tekst drukuje się pionowo, tak jak na oryginale.</p>
  `);

  const run = (withData) => {
    buildPrintSheet(withData);
    closeSheet();
    // Let the sheet close and the layout settle before the dialog blocks.
    setTimeout(() => window.print(), 120);
  };

  sheet.querySelector('[data-action="with"]').addEventListener('click', () => run(true));
  sheet.querySelector('[data-action="blank"]').addEventListener('click', () => run(false));
}

/* ------------------------------------------------------------------- gate */

/* A passphrase screen, not a security boundary: this site is served from a
   public repository, so data.json and seed.json remain readable by anyone who
   requests those URLs. The gate keeps the app out of view on a shared device.
   Protecting the numbers themselves would mean encrypting the data files. */

function storedUnlock() {
  try {
    return localStorage.getItem(UNLOCK_KEY);
  } catch (error) {
    return null;
  }
}

async function loadGateConfig() {
  try {
    const response = await fetch(`${GATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    try {
      localStorage.setItem(GATE_CACHE_KEY, JSON.stringify(config));
    } catch (error) {
      console.warn('Nie udało się zapisać konfiguracji blokady', error);
    }
    return config;
  } catch (error) {
    // Offline, or the file is not published yet: fall back to the last copy.
    try {
      const cached = localStorage.getItem(GATE_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (parseError) {
      console.warn('Brak zapisanej konfiguracji blokady', parseError);
    }
    return null;
  }
}

/* The key for the encrypted cycle day. Derived from the passphrase again with
   a different salt rather than from the verifier, because the verifier is the
   hash published in gate.json - anything derived from that is derivable by
   anyone who fetches the file. Kept as raw bytes so later launches do not have
   to ask for the passphrase again, exactly like the unlock flag beside it. */
async function deriveDataKey(passphrase, config) {
  const encoder = new TextEncoder();
  const base = Uint8Array.from(atob(config.salt), (char) => char.charCodeAt(0));
  const suffix = encoder.encode('sen-data');
  const salt = new Uint8Array(base.length + suffix.length);
  salt.set(base);
  salt.set(suffix, base.length);

  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: config.iterations, hash: 'SHA-256' },
    material,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

let dataKey = null;

async function loadDataKey() {
  let stored = null;
  try {
    stored = localStorage.getItem(DATA_KEY_KEY);
  } catch (error) {
    return;
  }
  if (!stored || !crypto.subtle) return;
  try {
    const raw = Uint8Array.from(atob(stored), (char) => char.charCodeAt(0));
    dataKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  } catch (error) {
    console.warn('Nie udało się wczytać klucza danych', error);
  }
}

/* Plaintext lives here and nowhere else - never in localStorage, never in a
   log. Rebuilt from the file on every load. */
let cycleDays = {};
let cycleKeyBad = false;

async function decryptCycle() {
  cycleDays = {};
  cycleKeyBad = false;
  if (!dataKey) return;

  const decoder = new TextDecoder();
  for (const [date, day] of Object.entries(garmin.days || {})) {
    if (!day || !day.cycleDayEnc) continue;
    try {
      const raw = Uint8Array.from(atob(day.cycleDayEnc), (char) => char.charCodeAt(0));
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: raw.slice(0, 12) }, dataKey, raw.slice(12)
      );
      const value = Number(decoder.decode(plain));
      if (Number.isFinite(value)) cycleDays[date] = value;
    } catch (error) {
      // Wrong key, or the field was tampered with. Say so once, show nothing.
      cycleKeyBad = true;
    }
  }
}

async function derivePasscode(passphrase, config) {
  const encoder = new TextEncoder();
  const salt = Uint8Array.from(atob(config.salt), (char) => char.charCodeAt(0));
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: config.iterations, hash: 'SHA-256' },
    material,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function askForPasscode(config) {
  return new Promise((resolve) => {
    const gate = document.getElementById('gate');
    const form = document.getElementById('gate-form');
    const input = document.getElementById('gate-input');
    const error = document.getElementById('gate-error');
    const submit = document.getElementById('gate-submit');

    gate.hidden = false;
    input.focus();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value) return;

      submit.disabled = true;
      submit.textContent = 'Sprawdzam…';
      error.hidden = true;

      let matches = false;
      try {
        matches = (await derivePasscode(input.value, config)) === config.hash;
      } catch (failure) {
        console.warn('Nie udało się sprawdzić hasła', failure);
      }

      submit.disabled = false;
      submit.textContent = 'Odblokuj';

      if (!matches) {
        error.hidden = false;
        input.value = '';
        input.focus();
        return;
      }

      try {
        localStorage.setItem(UNLOCK_KEY, config.hash);
        localStorage.setItem(DATA_KEY_KEY, await deriveDataKey(input.value, config));
      } catch (failure) {
        console.warn('Nie udało się zapamiętać odblokowania', failure);
      }
      gate.hidden = true;
      document.documentElement.removeAttribute('data-locked');
      resolve();
    });
  });
}

async function passGate() {
  const config = await loadGateConfig();

  // No passphrase configured: nothing to ask for.
  if (!config || !config.hash || !crypto.subtle) {
    document.documentElement.removeAttribute('data-locked');
    return;
  }

  if (storedUnlock() === config.hash) {
    document.documentElement.removeAttribute('data-locked');
    return;
  }

  await askForPasscode(config);
}

/* ------------------------------------------------------------------ start */

function pickInitialWeek() {
  const dates = cycleDates();
  const index = dates.indexOf(todayISO());
  activeWeek = index < 0 ? 1 : Math.floor(index / 7) + 1;
}

let railTicking = false;
document.addEventListener('scroll', (event) => {
  const scroller = gridScroller();
  if (!scroller || event.target !== scroller || railTicking) return;
  railTicking = true;
  requestAnimationFrame(() => {
    updateRail();
    const week = weekFromScroll();
    if (week !== activeWeek) {
      activeWeek = week;
      renderWeekbar();
      renderNotes();
    }
    railTicking = false;
  });
}, true);

document.getElementById('print').addEventListener('click', openPrint);
document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('tokenbar').addEventListener('click', openTokenHelp);
document.getElementById('refresh').addEventListener('click', syncNow);
wideScreen.addEventListener('change', render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadGarmin(false).then(autoSync);
});

// Hide the interface up front so it never flashes before the gate appears.
if (storedUnlock()) document.documentElement.removeAttribute('data-locked');

passGate().then(async () => {
  await loadDataKey();
  await loadCachedGarmin();
  pickInitialWeek();
  save();
  render();

  // Land on today, the way you would open the paper sheet.
  requestAnimationFrame(() => scrollToToday(false));

  if (freshInstall) importSeed(false);
  // Read what is published first, then decide whether it is worth asking
  // GitHub for more. Neither step holds up the interface.
  loadGarmin(false).then(autoSync);
});

if ('serviceWorker' in navigator) {
  // True on every launch except the very first, when there is nothing to
  // replace and a reload would be pointless.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // A new worker has taken over and its cache already holds the new files,
    // but this page is still showing the old ones. Claiming control does not
    // reload anything on its own, so without this the app can sit on an old
    // version indefinitely — an installed PWA is resumed far more often than
    // it is genuinely reopened.
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((registration) => {
      // An installed app can sit suspended for days without ever asking
      // whether sw.js changed; check whenever it comes back to the front.
      const checkForUpdate = () => {
        if (!document.hidden) registration.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', checkForUpdate);
      window.addEventListener('focus', checkForUpdate);
    }).catch((error) => {
      console.warn('Service worker nie wystartował', error);
    });
  });
}
