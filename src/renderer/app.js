import uPlot from 'uplot';
import { parseActivity } from '../core/parse.js';
import { STREAMS, streamByKey, hasStream } from '../core/streams.js';
import { mergeActivities, defaultSources, rangePreset, autoAlign, computeStats, sampleAt, fileSpan, sourceAt } from '../core/merge.js';
import { toFit, toTcx, toGpx, SPORTS, sportFromActivity } from '../core/export.js';

const FILE_COLORS = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ec4899', '#06b6d4'];
const $ = (id) => document.getElementById(id);

const state = {
  tab: 'files',
  files: [], // { id, color, activity, offset, path, stats }
  sources: {},
  overrides: [], // { stream, fileId|null, from, to }
  rangeMode: 'auto', // 'auto' | 'all' | 'overlap' | fileId | 'custom'
  customRange: null,
  maxGap: 10,
  lapSource: 'auto',
  sport: null,
  selection: null,
  view: null,
  merged: null,
  nextId: 1,
};

// ---------------------------------------------------------------- helpers
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
function fmtDuration(sec) {
  sec = Math.round(sec);
  const s = Math.abs(sec);
  const str = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return sec < 0 ? `-${str}` : str;
}
const fmtClock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDateTime = (t) =>
  new Date(t * 1000).toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const streamColor = (key) => `var(--s-${key})`;

let toastTimer;
function toast(msg, kind = 'info', ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const fileById = (id) => state.files.find((f) => f.id === id);
const fileIndex = (id) => state.files.findIndex((f) => f.id === id);
const fileName = (id) => (id == null ? 'None' : fileById(id)?.activity.name ?? '?');

const ICONS = {
  remove: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  watch: '<svg viewBox="0 0 24 24" width="30" height="30"><rect x="6" y="6" width="12" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 6l.6-3h4.8L15 6M9 18l.6 3h4.8L15 18M12 9.5V12l1.6 1.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  screen: '<svg viewBox="0 0 24 24" width="30" height="30"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4M7 12l3-3 2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bike: '<svg viewBox="0 0 24 24" width="30" height="30"><rect x="6" y="3" width="12" height="18" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="8.5" y="6" width="7" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 16h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="30" height="30"><rect x="7" y="2.5" width="10" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v4h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="44" height="44"><path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const icon = (name, cls = 'icon') => h('span', { class: cls, html: ICONS[name], 'aria-hidden': 'true' });

const VIRTUAL_APPS = ['zwift', 'tacx', 'rouvy', 'mywhoosh', 'trainerroad', 'bkool', 'fulgaz', 'kinomap', 'wahoo_fitness', 'peloton', 'onelap'];
function deviceIcon(a) {
  const m = (a.manufacturer ?? a.device ?? '').toLowerCase();
  const d = (a.device ?? '').toLowerCase();
  if (VIRTUAL_APPS.some((v) => m.includes(v) || d.includes(v)) || a.subSport === 'virtualActivity') return 'screen';
  if (/edge|elemnt|bolt|roam|karoo|bryton|computer/.test(d)) return 'bike';
  if (/connect|strava|app|phone|android|iphone/.test(d)) return 'phone';
  if (/garmin|fenix|forerunner|coros|polar|suunto|watch|venu|epix|vivo/.test(d + m)) return 'watch';
  return 'file';
}

// The file that "leads" the merge: most streams chosen from it.
function primaryFile() {
  if (!state.files.length) return null;
  const counts = new Map(state.files.map((f) => [f.id, 0]));
  for (const k of ['power', 'speed', 'distance', 'position', 'cadence', 'hr', 'alt']) {
    const id = state.sources[k];
    if (counts.has(id)) counts.set(id, counts.get(id) + (k === 'power' || k === 'position' ? 1.5 : 1));
  }
  return [...state.files].sort((a, b) => counts.get(b.id) - counts.get(a.id))[0];
}

function currentRange() {
  if (state.rangeMode === 'custom' && state.customRange) return state.customRange;
  if (state.rangeMode === 'auto') return rangePreset(state.files, primaryFile()?.id);
  return rangePreset(state.files, state.rangeMode) ?? rangePreset(state.files, primaryFile()?.id);
}

const lapSourceId = () => (state.lapSource === 'auto' ? primaryFile()?.id : state.lapSource);

function mergeConfig() {
  return { files: state.files, sources: state.sources, overrides: state.overrides, range: currentRange(), maxGap: state.maxGap, lapSource: lapSourceId() };
}

// ---------------------------------------------------------------- theme
function getThemeChoice() {
  try {
    return localStorage.getItem('theme') || 'system';
  } catch {
    return 'system';
  }
}
function setTheme(choice) {
  try {
    localStorage.setItem('theme', choice);
  } catch {}
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  syncThemeButtons();
  if (state.tab === 'charts') renderCharts();
}
function syncThemeButtons() {
  const choice = getThemeChoice();
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    const on = b.dataset.themeChoice === choice;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('role', 'radio');
  }
}

// ---------------------------------------------------------------- loading
async function addFiles(list) {
  let added = 0;
  for (const { name, data, path } of list) {
    try {
      const activity = parseActivity(name, data);
      const id = `f${state.nextId++}`;
      const color = FILE_COLORS[(state.nextId - 2) % FILE_COLORS.length];
      state.files.push({ id, color, activity, offset: 0, path, stats: computeStats(activity.records) });
      for (const w of activity.warnings) toast(`${name}: ${w}`, 'warn', 6000);
      added++;
    } catch (err) {
      toast(`Could not read ${name}: ${err.message}`, 'error', 7000);
    }
  }
  if (!added) return;
  const defaults = defaultSources(state.files);
  for (const s of STREAMS) {
    if (state.sources[s.key] == null || !fileById(state.sources[s.key])) state.sources[s.key] = defaults[s.key];
  }
  if (!state.sport) state.sport = sportFromActivity(primaryFile().activity);
  if (state.files.length >= 2 && !rangePreset(state.files, 'overlap')) {
    toast('Some of these files do not overlap in time. Check that they are recordings of the same workout, or shift one with its time shift.', 'warn', 8000);
  }
  render();
}

async function readBrowserFiles(fileList) {
  const items = [];
  for (const f of fileList) items.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), path: window.api?.pathForFile(f) ?? null });
  await addFiles(items);
}

async function openDialog() {
  if (window.api) await addFiles(await window.api.openFiles());
  else $('file-input').click();
}

function removeFile(id) {
  state.files = state.files.filter((f) => f.id !== id);
  state.overrides = state.overrides.filter((o) => o.fileId !== id);
  const defaults = defaultSources(state.files);
  for (const s of STREAMS) if (state.sources[s.key] === id) state.sources[s.key] = defaults[s.key];
  if (state.rangeMode === id) state.rangeMode = 'auto';
  if (state.lapSource === id) state.lapSource = 'auto';
  if (!state.files.length) Object.assign(state, { sources: {}, sport: null, selection: null, view: null, rangeMode: 'auto', customRange: null, tab: 'files' });
  render();
}

function runAutoAlign(f) {
  const ref = primaryFile()?.id !== f.id ? primaryFile() : state.files.find((x) => x.id !== f.id);
  const res = autoAlign(ref, f);
  if (res.error) return toast(res.error, 'warn', 7000);
  const before = f.offset;
  f.offset = res.offset;
  const conf = res.score > 0.8 ? 'high' : res.score > 0.5 ? 'medium' : 'low';
  toast(`Shifted ${f.activity.name} by ${res.offset - before >= 0 ? '+' : ''}${res.offset - before} s using ${streamByKey(res.stream).label.toLowerCase()} (match: ${conf}).`, conf === 'low' ? 'warn' : 'ok', 6000);
  render();
}

// ---------------------------------------------------------------- files view
function streamHint(f, key) {
  const s = f.stats;
  const a = f.activity;
  const r = Math.round;
  switch (key) {
    case 'hr': return s.hr && `avg ${r(s.hr.avg)} · max ${s.hr.max} bpm`;
    case 'power': return s.power && `avg ${r(s.power.avg)} · max ${s.power.max} W`;
    case 'cadence': return s.cadence && `avg ${r(s.cadence.avg)} rpm`;
    case 'speed': return s.speed && `avg ${(s.speed.avg * 3.6).toFixed(1)} km/h`;
    case 'distance': return s.distance != null && `${(s.distance / 1000).toFixed(2)} km`;
    case 'position': return `${a.streamCounts.position} points`;
    case 'alt': return s.ascent != null && `+${r(s.ascent)} m`;
    case 'temp': return s.temp && `avg ${s.temp.avg.toFixed(1)} °C`;
  }
  return null;
}

function streamList(f) {
  const a = f.activity;
  const items = STREAMS.filter((s) => hasStream(a, s.key)).map((s) => {
    const checked = state.sources[s.key] === f.id;
    const id = `cb-${f.id}-${s.key}`;
    return h(
      'label',
      { class: `stream${checked ? ' on' : ''}`, for: id, style: `--c:${streamColor(s.key)}` },
      h('input', {
        type: 'checkbox',
        id,
        checked,
        onchange: (e) => {
          state.sources[s.key] = e.target.checked ? f.id : null;
          render();
        },
      }),
      h('span', { class: 'stream-name' }, s.label),
      h('small', {}, streamHint(f, s.key) || '')
    );
  });
  const laps = a.laps.length || 1;
  return h(
    'div',
    { class: 'stream-list' },
    items.length ? items : h('p', { class: 'muted' }, 'No usable data in this file.'),
    h('div', { class: 'stream-foot' }, h('span', { class: 'pill' }, `${laps} lap${laps === 1 ? '' : 's'}`))
  );
}

function fileRow(f, i) {
  const a = f.activity;
  const nudge = (d) => () => { f.offset += d; render(); };
  const sport = SPORTS.find((s) => s.id === sportFromActivity(a));
  const shift =
    state.files.length > 1 &&
    h(
      'div',
      { class: 'shift' },
      h('span', { class: 'shift-label' }, 'Time shift'),
      h('div', { class: 'stepper' },
        h('button', { onclick: nudge(-10), title: '−10 seconds' }, '−10'),
        h('button', { onclick: nudge(-1), title: '−1 second' }, '−1'),
        h('input', {
          type: 'number', step: '1', value: String(f.offset), 'aria-label': `Time shift for ${a.name} in seconds`,
          onchange: (e) => { f.offset = Math.round(Number(e.target.value) || 0); render(); },
        }),
        h('button', { onclick: nudge(1), title: '+1 second' }, '+1'),
        h('button', { onclick: nudge(10), title: '+10 seconds' }, '+10')),
      h('button', { class: 'btn small soft', title: 'Line this file up with another one automatically', onclick: () => runAutoAlign(f) }, 'Auto-align')
    );

  return h(
    'tr',
    { style: `--file:${f.color}` },
    h('td', { class: 'num' }, pad(i + 1)),
    h(
      'td',
      { class: 'file-cell' },
      h('div', { class: 'file-name' }, h('strong', { title: f.path ?? a.name }, a.name), h('span', {}, `Duration ${fmtDuration(a.end - a.start)}`)),
      h('dl', { class: 'times' }, h('dt', {}, 'Start'), h('dd', {}, fmtDateTime(a.start + f.offset)), h('dt', {}, 'End'), h('dd', {}, fmtDateTime(a.end + f.offset))),
      shift
    ),
    h('td', { class: 'device-cell' }, icon(deviceIcon(a), 'device-icon'), h('span', {}, a.device ?? 'Unknown device')),
    h('td', { class: 'type-cell' }, h('span', { class: `format-badge f-${a.format}` }, a.format.toUpperCase()), h('span', { class: 'sport' }, sport?.label ?? 'Activity')),
    h('td', { class: 'streams-cell' }, streamList(f)),
    h('td', { class: 'actions-cell' }, h('button', { class: 'icon-btn', title: 'Remove file', 'aria-label': `Remove ${a.name}`, onclick: () => removeFile(f.id), html: ICONS.remove }))
  );
}

function filesTable() {
  return h(
    'div',
    { class: 'card table-card' },
    h(
      'table',
      { class: 'files' },
      h('thead', {}, h('tr', {}, h('th', {}, 'File #'), h('th', {}, 'File'), h('th', {}, 'Device'), h('th', {}, 'Type · Sport'), h('th', {}, 'Data streams', h('small', {}, ' tick the data to use from each file')), h('th', {}))),
      h('tbody', {}, state.files.map(fileRow))
    ),
    h('button', { class: 'add-row', onclick: openDialog }, '+ Add another file')
  );
}

function card(title, accent, ...body) {
  return h('section', { class: `card ${title === 'Result' ? 'result' : ''}`, style: `--accent-c:${accent}` }, h('h3', {}, title), ...body);
}

function exceptionsCard() {
  const list = state.overrides.map((o, i) =>
    h(
      'div',
      { class: 'exception', style: `--c:${streamColor(o.stream)}` },
      h('span', { class: 'exc-stream' }, streamByKey(o.stream).label),
      h('span', {}, `${fmtClock(o.from)} – ${fmtClock(o.to)}`),
      h('span', { class: 'exc-src' }, '→ ', o.fileId ? h('span', { class: 'swatch', style: `background:${fileById(o.fileId)?.color}` }) : null, fileName(o.fileId)),
      h('button', { class: 'icon-btn', 'aria-label': 'Remove exception', onclick: () => { state.overrides.splice(i, 1); render(); }, html: ICONS.remove })
    )
  );
  return card(
    'Exceptions for a time range',
    'var(--s-power)',
    list.length ? list : h('p', { class: 'hint' }, 'Use a different file (or none) for part of the workout: open ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTab('charts'); } }, 'Charts'), ' and drag across a chart to select the time range.')
  );
}

function rangeCard() {
  const range = currentRange();
  const opts = [
    ['auto', `Main file (${primaryFile()?.activity.name ?? '–'})`],
    ['overlap', 'Where all files overlap'],
    ['all', 'Everything in all files'],
    ...state.files.map((f) => [f.id, f.activity.name]),
  ];
  if (state.rangeMode === 'custom') opts.push(['custom', 'Custom (trimmed)']);
  const timeInput = (which) =>
    h('input', {
      type: 'time', step: '1', 'aria-label': which === 'start' ? 'Start time' : 'End time',
      value: range ? new Date(range[which] * 1000).toTimeString().slice(0, 8) : '',
      onchange: (e) => {
        const [hh, mm, ss] = e.target.value.split(':').map(Number);
        const d = new Date(range[which] * 1000);
        d.setHours(hh, mm, ss || 0, 0);
        const next = { ...range, [which]: d.getTime() / 1000 };
        if (next.end <= next.start) return toast('The end must be after the start.', 'warn');
        state.customRange = next;
        state.rangeMode = 'custom';
        render();
      },
    });
  return card(
    'Time range',
    'var(--s-speed)',
    h('div', { class: 'field' }, h('label', {}, 'Keep'),
      h('select', { 'aria-label': 'Time range', onchange: (e) => { state.rangeMode = e.target.value; render(); } }, opts.map(([v, l]) => h('option', { value: v, selected: v === state.rangeMode }, l)))),
    h('div', { class: 'field' }, h('label', {}, 'Start'), timeInput('start')),
    h('div', { class: 'field' }, h('label', {}, 'End'), timeInput('end')),
    range && h('p', { class: 'hint' }, `Duration ${fmtDuration(range.end - range.start + 1)}`)
  );
}

function optionsCard() {
  return card(
    'Options',
    'var(--s-alt)',
    h('div', { class: 'field' }, h('label', {}, 'Fill gaps up to'),
      h('div', { class: 'inline' },
        h('input', { type: 'number', min: '0', max: '300', value: String(state.maxGap), class: 'narrow', 'aria-label': 'Fill gaps up to seconds',
          onchange: (e) => { state.maxGap = Math.max(0, Math.min(300, Number(e.target.value) || 0)); render(); } }),
        h('span', { class: 'muted' }, 'seconds'))),
    h('p', { class: 'hint' }, 'Watches often record every few seconds; short gaps are filled smoothly.'),
    h('div', { class: 'field' }, h('label', {}, 'Laps'),
      h('select', { 'aria-label': 'Laps', onchange: (e) => { state.lapSource = e.target.value; render(); } },
        h('option', { value: 'auto', selected: state.lapSource === 'auto' }, 'From main file'),
        state.files.map((f) => h('option', { value: f.id, selected: state.lapSource === f.id }, `${f.activity.name} (${f.activity.laps.length || 1})`)),
        h('option', { value: 'single', selected: state.lapSource === 'single' }, 'One lap for everything'))),
    h('div', { class: 'field' }, h('label', {}, 'Activity type'),
      h('select', { 'aria-label': 'Activity type', onchange: (e) => { state.sport = e.target.value; render(); } },
        SPORTS.map((s) => h('option', { value: s.id, selected: s.id === state.sport }, s.label))))
  );
}

function resultCard() {
  const m = state.merged;
  if (!m || !m.records.length) return card('Result', 'var(--s-hr)', h('p', { class: 'muted' }, 'Nothing to export in this time range.'));
  const s = computeStats(m.records);
  const r0 = Math.round;
  const tile = (key, label, value, sub) =>
    value != null && h('div', { class: 'tile', style: `--c:${key ? streamColor(key) : 'var(--accent)'}` }, h('span', {}, label), h('strong', {}, value), sub && h('small', {}, sub));
  return card(
    'Result',
    'var(--s-hr)',
    h(
      'div',
      { class: 'tiles' },
      tile(null, 'Duration', fmtDuration(s.elapsed), `${m.laps.length} lap${m.laps.length === 1 ? '' : 's'}`),
      tile('distance', 'Distance', s.distance != null ? `${(s.distance / 1000).toFixed(2)} km` : null),
      tile('hr', 'Heart rate', s.hr && `${r0(s.hr.avg)} bpm`, s.hr && `max ${s.hr.max}`),
      tile('power', 'Power', s.power && `${r0(s.power.avg)} W`, s.power && `NP ${r0(s.np ?? s.power.avg)} · max ${s.power.max}`),
      tile('cadence', 'Cadence', s.cadence && `${r0(s.cadence.avg)} rpm`),
      tile('speed', 'Speed', s.speed && `${(s.speed.avg * 3.6).toFixed(1)} km/h`, s.speed && `max ${(s.speed.max * 3.6).toFixed(1)}`),
      tile('alt', 'Elevation gain', s.ascent != null ? `${r0(s.ascent)} m` : null),
      tile('temp', 'Energy', s.work != null ? `${r0(s.work / 1000)} kJ` : null)
    ),
    coverageWarnings(m)
  );
}

function coverageWarnings(m) {
  const notes = [];
  const n = m.records.length;
  for (const key of ['hr', 'power', 'cadence']) {
    if (!state.sources[key] && !state.overrides.some((o) => o.stream === key && o.fileId)) continue;
    const have = m.records.filter((r) => r[key] != null).length;
    if (have < n * 0.95) notes.push(`${streamByKey(key).label} is missing for ${fmtDuration(n - have)} of the activity.`);
  }
  return notes.length ? h('div', { class: 'notes' }, notes.map((t) => h('p', {}, t))) : null;
}

function emptyState() {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'drop-target' },
      icon('upload', 'upload-icon'),
      h('h2', {}, 'Drop your activity files here'),
      h('p', {}, 'FIT, TCX or GPX from any app or device. Add two or more recordings of the same workout, for example an indoor ride and your watch.'),
      h('button', { class: 'btn primary', onclick: openDialog }, 'Choose files…'),
      h('div', { class: 'legend' }, STREAMS.map((s) => h('span', { style: `--c:${streamColor(s.key)}` }, s.label))))
  );
}

function renderFilesView() {
  const v = $('view-files');
  v.replaceChildren();
  if (!state.files.length) return v.append(emptyState());
  v.append(filesTable(), h('div', { class: 'cards' }, resultCard(), rangeCard(), optionsCard(), exceptionsCard()));
}

// ---------------------------------------------------------------- charts view
function renderSelectionBar() {
  const bar = $('selection-bar');
  const sel = state.selection;
  if (!sel || !state.files.length) return (bar.hidden = true);
  bar.hidden = false;
  const chartable = STREAMS.filter((s) => state.files.some((f) => hasStream(f.activity, s.key)));
  const streamSel = h('select', { 'aria-label': 'Data type for this range' }, chartable.map((s) => h('option', { value: s.key }, s.label)));
  const srcSel = h('select', { 'aria-label': 'Source for this range' },
    state.files.map((f) => h('option', { value: f.id }, f.activity.name)), h('option', { value: '' }, 'None (leave empty)'));
  bar.replaceChildren(
    h('span', { class: 'sel-label' }, `${fmtClock(sel.from)} – ${fmtClock(sel.to)}`, h('small', {}, ` (${fmtDuration(sel.to - sel.from)})`)),
    h('span', { class: 'sel-group' }, 'Use', streamSel, 'from', srcSel,
      h('button', { class: 'btn small primary', onclick: () => {
        state.overrides.push({ stream: streamSel.value, fileId: srcSel.value || null, from: sel.from, to: sel.to });
        state.selection = null;
        toast('Exception added. You can see and remove it on the Files & data tab.', 'ok');
        render();
      } }, 'Apply')),
    h('span', { class: 'sel-group' },
      h('button', { class: 'btn small', onclick: () => { state.customRange = { start: sel.from, end: sel.to }; state.rangeMode = 'custom'; state.selection = null; render(); } }, 'Trim to selection'),
      h('button', { class: 'btn small', onclick: () => { state.view = { min: sel.from, max: sel.to }; state.selection = null; render(); } }, 'Zoom in'),
      h('button', { class: 'btn small ghost', onclick: () => { state.selection = null; render(); } }, 'Clear'))
  );
}

let charts = [];
function chartWindow() {
  const spans = state.files.map(fileSpan);
  const range = currentRange();
  let min = Math.min(range.start, ...spans.map((s) => s.start));
  let max = Math.max(range.end, ...spans.map((s) => s.end));
  if (max - min > 12 * 3600) ({ start: min, end: max } = range);
  return { min: Math.floor(min), max: Math.ceil(max) };
}

function renderCharts() {
  for (const c of charts) c.destroy();
  charts = [];
  const host = $('charts');
  host.replaceChildren();
  if (state.tab !== 'charts') return;
  if (!state.files.length) {
    host.append(emptyState());
    return;
  }
  const range = currentRange();
  if (!range) return;

  const win = chartWindow();
  const xs = [];
  for (let t = win.min; t <= win.max; t++) xs.push(t);
  const mergedByT = new Map(state.merged.records.map((r) => [r.t, r]));
  const width = Math.max(400, host.clientWidth - 2);
  const grid = css('--grid');
  const axisColor = css('--muted');
  const shade = css('--shade');

  host.append(
    h('div', { class: 'charts-head' },
      h('p', { class: 'hint' }, 'Thin lines are your files, the thick line is the result. Grey areas are outside the time range. Drag across a chart to select a range.'),
      state.view && h('span', { class: 'zoom-info' }, `Zoomed to ${fmtClock(state.view.min)} – ${fmtClock(state.view.max)}`, h('button', { class: 'btn small', onclick: () => { state.view = null; render(); } }, 'Show all')))
  );

  const streams = STREAMS.filter((s) => s.chart && state.files.some((f) => hasStream(f.activity, s.key)));
  for (const s of streams) {
    const disp = s.display ?? ((v) => v);
    const color = css(`--s-${s.key}`);
    const files = state.files.filter((f) => hasStream(f.activity, s.key));
    const data = [xs];
    const series = [{}];
    for (const f of files) {
      data.push(xs.map((t) => { const v = sampleAt(f, s.key, t, state.maxGap); return v == null ? null : disp(v); }));
      series.push({ label: f.activity.name, stroke: f.color + '99', width: 1, points: { show: false } });
    }
    data.push(xs.map((t) => { const r = mergedByT.get(t); return r?.[s.key] == null ? null : disp(r[s.key]); }));
    series.push({ label: 'Result', stroke: color, width: 2, fill: color + '1f', points: { show: false } });

    const src = sourceAt(mergeConfig(), s.key, range.start);
    const wrap = h('div', { class: 'chart', style: `--c:${color}` },
      h('div', { class: 'chart-title' }, h('span', { class: 'chart-dot' }), s.label, h('small', {}, s.unit),
        h('span', { class: 'chart-src' }, 'from ', h('span', { class: 'swatch', style: `background:${fileById(src)?.color ?? 'transparent'}` }), fileName(src))));
    host.append(wrap);

    const u = new uPlot(
      {
        width,
        height: 180,
        series,
        scales: { x: { time: true, min: state.view?.min ?? win.min, max: state.view?.max ?? win.max } },
        axes: [
          { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
          { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 50 },
        ],
        legend: { show: true, live: true },
        cursor: { sync: { key: 'm', setSeries: false }, drag: { x: true, y: false, setScale: false } },
        select: { show: true },
        hooks: {
          drawClear: [
            (u) => {
              const { ctx } = u;
              const { left: l, top, width: w, height: hgt } = u.bbox;
              const rgt = l + w;
              const X = (t) => Math.max(l, Math.min(rgt, u.valToPos(t, 'x', true)));
              ctx.save();
              ctx.fillStyle = shade;
              const a = X(range.start);
              const b = X(range.end);
              if (a > l) ctx.fillRect(l, top, a - l, hgt);
              if (b < rgt) ctx.fillRect(b, top, rgt - b, hgt);
              for (const o of state.overrides) {
                if (o.stream !== s.key) continue;
                ctx.fillStyle = (fileById(o.fileId)?.color ?? '#888888') + '2a';
                const oa = X(o.from);
                const ob = X(o.to);
                if (ob > oa) ctx.fillRect(oa, top, ob - oa, hgt);
              }
              ctx.restore();
            },
          ],
          setSelect: [
            (u) => {
              if (u.select.width < 3) return;
              state.selection = { from: Math.round(u.posToVal(u.select.left, 'x')), to: Math.round(u.posToVal(u.select.left + u.select.width, 'x')) };
              for (const c of charts) if (c !== u) c.setSelect({ left: u.select.left, width: u.select.width, top: 0, height: c.bbox.height / devicePixelRatio }, false);
              renderSelectionBar();
            },
          ],
        },
      },
      data,
      wrap
    );
    charts.push(u);
  }
  if (!streams.length) host.append(h('p', { class: 'muted' }, 'These files contain no data that can be charted.'));
  if (state.selection) {
    for (const c of charts) {
      const left = c.valToPos(state.selection.from, 'x');
      c.setSelect({ left, width: c.valToPos(state.selection.to, 'x') - left, top: 0, height: c.bbox.height / devicePixelRatio }, false);
    }
  }
}

// ---------------------------------------------------------------- export
async function exportFile() {
  const m = state.merged;
  if (!m?.records.length) return;
  const format = $('format').value;
  const primary = primaryFile();
  const opts = { sport: state.sport, manufacturer: primary.activity.manufacturer, product: primary.activity.product };
  let data;
  try {
    data = format === 'fit' ? toFit(m, opts) : format === 'tcx' ? toTcx(m, opts) : toGpx(m, opts);
  } catch (err) {
    return toast(err.message, 'error', 7000);
  }
  const name = `${primary.activity.name.replace(/\.[^.]+$/, '')}-merged.${format}`;
  const dir = primary.path ? primary.path.replace(/[\\/][^\\/]*$/, '') : null;
  if (window.api) {
    const saved = await window.api.saveFile({ defaultPath: dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${name}` : name, ext: format, data });
    if (saved) toast(`Saved ${saved}`, 'ok', 6000);
  } else {
    const a = h('a', { href: URL.createObjectURL(new Blob([data])), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    toast(`Downloaded ${name}`, 'ok');
  }
}

// ---------------------------------------------------------------- render
function setTab(tab) {
  state.tab = tab;
  render();
}

function render() {
  if (state.files.length) {
    const range = currentRange();
    state.merged = range ? mergeActivities({ ...mergeConfig(), range }) : { records: [], laps: [] };
  } else {
    state.merged = null;
  }
  $('export-btn').disabled = !state.merged?.records.length;
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === state.tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  }
  $('view-files').hidden = state.tab !== 'files';
  $('view-charts').hidden = state.tab !== 'charts';
  renderFilesView();
  renderSelectionBar();
  renderCharts();
}

// ---------------------------------------------------------------- wiring
$('open-btn').addEventListener('click', openDialog);
$('export-btn').addEventListener('click', exportFile);
for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab));
for (const b of document.querySelectorAll('[data-theme-choice]')) b.addEventListener('click', () => setTheme(b.dataset.themeChoice));
$('file-input').addEventListener('change', async (e) => {
  await readBrowserFiles([...e.target.files]);
  e.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  if (e.dataTransfer?.files?.length) await readBrowserFiles([...e.dataTransfer.files]);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selection) { state.selection = null; render(); } });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { const w = Math.max(400, $('charts').clientWidth - 2); for (const c of charts) c.setSize({ width: w, height: 180 }); }, 100);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.tab === 'charts' && renderCharts());

// ---------------------------------------------------------------- updates
const upd = { manual: false, version: null };
function updateBar(content) {
  const bar = $('update-bar');
  if (!content) return (bar.hidden = true);
  bar.replaceChildren(...content);
  bar.hidden = false;
}
function onUpdateStatus(u) {
  if (u.state === 'available') {
    upd.manual = false;
    updateBar([
      h('span', { class: 'upd-icon', html: ICONS.upload }),
      h('span', {}, h('strong', {}, `Version ${u.version} is available.`), ` You have ${upd.version}.`),
      h('button', { class: 'btn small primary', onclick: () => { onUpdateStatus({ state: 'downloading', percent: 0 }); window.api.downloadUpdate().catch(() => {}); } }, 'Update now'),
      h('button', { class: 'btn small ghost', onclick: () => updateBar(null) }, 'Later'),
    ]);
  } else if (u.state === 'downloading') {
    updateBar([
      h('span', {}, h('strong', {}, 'Downloading update…'), ` ${u.percent ?? 0}%`),
      h('span', { class: 'progress' }, h('span', { style: `width:${u.percent ?? 0}%` })),
    ]);
  } else if (u.state === 'ready') {
    updateBar([
      h('span', {}, h('strong', {}, `Version ${u.version} is ready.`), ' The app restarts to finish updating.'),
      h('button', { class: 'btn small primary', onclick: () => window.api.installUpdate() }, 'Restart & install'),
      h('button', { class: 'btn small ghost', onclick: () => updateBar(null) }, 'Later (installs when you close the app)'),
    ]);
  } else if (u.state === 'none') {
    if (upd.manual) toast(`You have the latest version (${upd.version}).`, 'ok');
    upd.manual = false;
  } else if (u.state === 'error') {
    if (upd.manual || !$('update-bar').hidden) toast(`Update failed: ${u.message}`, 'error', 8000);
    updateBar(null);
    upd.manual = false;
  }
}
async function initUpdates() {
  if (!window.api?.appInfo) return;
  const info = await window.api.appInfo();
  upd.version = info.version;
  const btn = $('version-btn');
  btn.textContent = `v${info.version}`;
  btn.hidden = false;
  window.api.onUpdateStatus(onUpdateStatus);
  btn.addEventListener('click', async () => {
    upd.manual = true;
    const r = await window.api.checkForUpdates();
    if (r.state === 'unsupported') {
      upd.manual = false;
      toast('Automatic updates only work in the installed app (not the portable version).', 'warn', 6000);
    } else if (r.state === 'error') onUpdateStatus(r);
  });
  if (info.canUpdate) window.api.checkForUpdates();
}
initUpdates();

window.__state = state;
window.__onUpdateStatus = onUpdateStatus;
syncThemeButtons();
render();
