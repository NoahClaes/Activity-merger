import uPlot from 'uplot';
import { parseActivity } from '../core/parse.js';
import { STREAMS, streamByKey, hasStream } from '../core/streams.js';
import { mergeActivities, defaultSources, rangePreset, autoAlign, computeStats, sampleAt, fileSpan, sourceAt } from '../core/merge.js';
import { toFit, toTcx, toGpx, SPORTS, sportFromActivity } from '../core/export.js';

const COLORS = ['#2f6fed', '#e8590c', '#2b9348', '#9c36b5', '#d6336c', '#0c8599'];
const $ = (id) => document.getElementById(id);

const state = {
  files: [], // { id, color, activity, offset, path }
  sources: {},
  overrides: [], // { stream, fileId|null, from, to }
  rangeMode: 'auto', // 'auto' | 'all' | 'overlap' | fileId | 'custom'
  customRange: null,
  maxGap: 10,
  lapSource: 'auto',
  sport: null,
  selection: null, // { from, to }
  view: null, // zoomed x range { min, max }
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
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

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
const fileName = (id) => (id == null ? 'None' : fileById(id)?.activity.name ?? '?');

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

function lapSourceId() {
  return state.lapSource === 'auto' ? primaryFile()?.id : state.lapSource;
}

function mergeConfig() {
  return {
    files: state.files,
    sources: state.sources,
    overrides: state.overrides,
    range: currentRange(),
    maxGap: state.maxGap,
    lapSource: lapSourceId(),
  };
}

// ---------------------------------------------------------------- loading
async function addFiles(list) {
  let added = 0;
  for (const { name, data, path } of list) {
    try {
      const activity = parseActivity(name, data);
      const id = `f${state.nextId++}`;
      const color = COLORS[(state.nextId - 2) % COLORS.length];
      state.files.push({ id, color, activity, offset: 0, path });
      for (const w of activity.warnings) toast(`${name}: ${w}`, 'warn', 6000);
      added++;
    } catch (err) {
      toast(`Could not read ${name}: ${err.message}`, 'error', 7000);
    }
  }
  if (!added) return;
  // Fill in sources for streams that have none yet (keeps the user's choices).
  const defaults = defaultSources(state.files);
  for (const s of STREAMS) {
    if (state.sources[s.key] == null || !fileById(state.sources[s.key])) state.sources[s.key] = defaults[s.key];
  }
  if (!state.sport) state.sport = sportFromActivity(primaryFile().activity);
  checkOverlap();
  render();
}

function checkOverlap() {
  if (state.files.length < 2) return;
  if (!rangePreset(state.files, 'overlap')) {
    toast('Some of these files do not overlap in time. Check that they are recordings of the same workout, or shift one with its time offset.', 'warn', 8000);
  }
}

async function readBrowserFiles(fileList) {
  const items = [];
  for (const f of fileList) {
    items.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), path: window.api?.pathForFile(f) ?? null });
  }
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
  if (!state.files.length) Object.assign(state, { sources: {}, sport: null, selection: null, view: null, rangeMode: 'auto', customRange: null });
  render();
}

// ---------------------------------------------------------------- sidebar
function section(title, ...body) {
  return h('section', { class: 'panel' }, h('h3', {}, title), ...body);
}

function renderFiles() {
  const cards = state.files.map((f) => {
    const a = f.activity;
    const chips = STREAMS.filter((s) => hasStream(a, s.key)).map((s) => h('span', { class: 'chip' }, s.label));
    const offsetInput = h('input', {
      type: 'number',
      step: '1',
      value: String(f.offset),
      class: 'offset-input',
      'aria-label': `Time offset for ${a.name} in seconds`,
      onchange: (e) => {
        f.offset = Math.round(Number(e.target.value) || 0);
        render();
      },
    });
    const nudge = (d) => () => {
      f.offset += d;
      render();
    };
    const others = state.files.filter((x) => x.id !== f.id);
    return h(
      'div',
      { class: 'file-card', style: `--file-color:${f.color}` },
      h(
        'div',
        { class: 'file-head' },
        h('span', { class: 'dot' }),
        h('div', { class: 'file-title' }, h('strong', { title: f.path ?? a.name }, a.name), h('small', {}, [a.format.toUpperCase(), a.device].filter(Boolean).join(' · '))),
        h('button', { class: 'icon-btn', title: 'Remove file', 'aria-label': `Remove ${a.name}`, onclick: () => removeFile(f.id) }, '×')
      ),
      h('div', { class: 'file-meta' }, `${fmtDate(a.start)} · ${fmtClock(a.start + f.offset)} – ${fmtClock(a.end + f.offset)} · ${fmtDuration(a.end - a.start)}`),
      h('div', { class: 'chips' }, chips),
      state.files.length > 1 &&
        h(
          'div',
          { class: 'offset-row' },
          h('label', {}, 'Time shift'),
          h('button', { class: 'btn small', onclick: nudge(-10), title: '−10 s' }, '−10'),
          h('button', { class: 'btn small', onclick: nudge(-1), title: '−1 s' }, '−1'),
          offsetInput,
          h('span', { class: 'unit' }, 's'),
          h('button', { class: 'btn small', onclick: nudge(1), title: '+1 s' }, '+1'),
          h('button', { class: 'btn small', onclick: nudge(10), title: '+10 s' }, '+10'),
          others.length > 0 &&
            h('button', { class: 'btn small', title: 'Line this file up with another one automatically', onclick: () => runAutoAlign(f) }, 'Auto-align')
        )
    );
  });
  return section(
    'Files',
    cards.length ? cards : h('p', { class: 'muted' }, 'No files yet.'),
    h('button', { class: 'btn ghost full', onclick: openDialog }, '+ Add files')
  );
}

function runAutoAlign(f) {
  // Align against the primary file, or the first other file.
  const ref = primaryFile()?.id !== f.id ? primaryFile() : state.files.find((x) => x.id !== f.id);
  const res = autoAlign(ref, f);
  if (res.error) return toast(res.error, 'warn', 7000);
  const before = f.offset;
  f.offset = res.offset;
  const conf = res.score > 0.8 ? 'high' : res.score > 0.5 ? 'medium' : 'low';
  toast(`Shifted ${f.activity.name} by ${res.offset - before >= 0 ? '+' : ''}${res.offset - before} s using ${streamByKey(res.stream).label.toLowerCase()} (match: ${conf}).`, conf === 'low' ? 'warn' : 'ok', 6000);
  render();
}

function fileOptions(key, selected, { includeNone = true } = {}) {
  const opts = state.files
    .filter((f) => !key || hasStream(f.activity, key))
    .map((f) => h('option', { value: f.id, selected: f.id === selected }, f.activity.name));
  if (includeNone) opts.push(h('option', { value: '', selected: selected == null }, 'None'));
  return opts;
}

function renderSources() {
  const rows = STREAMS.filter((s) => state.files.some((f) => hasStream(f.activity, s.key)) || s.key === 'distance').map((s) => {
    const sel = h(
      'select',
      {
        'aria-label': `Source for ${s.label}`,
        onchange: (e) => {
          state.sources[s.key] = e.target.value || null;
          render();
        },
      },
      fileOptions(s.key === 'distance' ? null : s.key, state.sources[s.key])
    );
    const color = fileById(state.sources[s.key])?.color;
    return h('div', { class: 'source-row' }, h('span', { class: 'dot', style: color ? `background:${color}` : 'background:transparent;border:1px dashed var(--muted)' }), h('label', {}, s.label), sel);
  });

  const overrides = state.overrides.map((o, i) =>
    h(
      'div',
      { class: 'override', style: `--file-color:${fileById(o.fileId)?.color ?? 'var(--muted)'}` },
      h('span', {}, h('strong', {}, streamByKey(o.stream).label), ` ${fmtClock(o.from)}–${fmtClock(o.to)} → ${fileName(o.fileId)}`),
      h('button', { class: 'icon-btn', 'aria-label': 'Remove exception', onclick: () => { state.overrides.splice(i, 1); render(); } }, '×')
    )
  );

  return section(
    'Data sources',
    h('p', { class: 'hint' }, 'Choose which file each type of data comes from.'),
    rows,
    h('h4', {}, 'Exceptions for a time range'),
    overrides.length ? overrides : h('p', { class: 'hint' }, 'Drag across a chart to select a time range, then pick a different source for it.')
  );
}

function renderRange() {
  const range = currentRange();
  const opts = [
    ['auto', `Main file (${primaryFile()?.activity.name ?? '–'})`],
    ['overlap', 'Where all files overlap'],
    ['all', 'Everything in all files'],
    ...state.files.map((f) => [f.id, f.activity.name]),
  ];
  if (state.rangeMode === 'custom') opts.push(['custom', 'Custom (trimmed)']);
  const sel = h(
    'select',
    { 'aria-label': 'Time range', onchange: (e) => { state.rangeMode = e.target.value; render(); } },
    opts.map(([v, l]) => h('option', { value: v, selected: v === state.rangeMode }, l))
  );
  const timeInput = (which) =>
    h('input', {
      type: 'time',
      step: '1',
      value: range ? new Date(range[which] * 1000).toTimeString().slice(0, 8) : '',
      'aria-label': which === 'start' ? 'Start time' : 'End time',
      onchange: (e) => {
        const [hh, mm, ss] = e.target.value.split(':').map(Number);
        const d = new Date(range[which] * 1000);
        d.setHours(hh, mm, ss || 0, 0);
        state.customRange = { ...range, [which]: d.getTime() / 1000 };
        if (state.customRange.end <= state.customRange.start) return toast('The end must be after the start.', 'warn');
        state.rangeMode = 'custom';
        render();
      },
    });
  return section(
    'Time range',
    h('div', { class: 'field' }, h('label', {}, 'Keep'), sel),
    h('div', { class: 'field two' }, h('label', {}, 'From'), timeInput('start'), h('label', {}, 'to'), timeInput('end')),
    range && h('p', { class: 'hint' }, `Duration ${fmtDuration(range.end - range.start + 1)}`)
  );
}

function renderOptions() {
  const gap = h('input', {
    type: 'number',
    min: '0',
    max: '300',
    value: String(state.maxGap),
    class: 'narrow',
    'aria-label': 'Fill gaps up to seconds',
    onchange: (e) => { state.maxGap = Math.max(0, Math.min(300, Number(e.target.value) || 0)); render(); },
  });
  const laps = h(
    'select',
    { 'aria-label': 'Laps', onchange: (e) => { state.lapSource = e.target.value; render(); } },
    h('option', { value: 'auto', selected: state.lapSource === 'auto' }, 'From main file'),
    state.files.map((f) => h('option', { value: f.id, selected: state.lapSource === f.id }, `${f.activity.name} (${f.activity.laps.length || 1})`)),
    h('option', { value: 'single', selected: state.lapSource === 'single' }, 'One lap for the whole activity')
  );
  const sport = h(
    'select',
    { 'aria-label': 'Activity type', onchange: (e) => { state.sport = e.target.value; render(); } },
    SPORTS.map((s) => h('option', { value: s.id, selected: s.id === state.sport }, s.label))
  );
  return section(
    'Options',
    h('div', { class: 'field' }, h('label', {}, 'Fill gaps up to'), h('span', { class: 'inline' }, gap, ' seconds')),
    h('p', { class: 'hint' }, 'Watches often record every few seconds. Short gaps are filled by drawing a line between the points on either side.'),
    h('div', { class: 'field' }, h('label', {}, 'Laps'), laps),
    h('div', { class: 'field' }, h('label', {}, 'Activity type'), sport)
  );
}

function renderSummary() {
  const m = state.merged;
  if (!m || !m.records.length) return section('Result', h('p', { class: 'muted' }, 'Nothing to export in this time range.'));
  const s = computeStats(m.records);
  const item = (label, value) => value != null && h('div', { class: 'stat' }, h('span', {}, label), h('strong', {}, value));
  const r0 = (v) => Math.round(v);
  return section(
    'Result',
    h(
      'div',
      { class: 'stats' },
      item('Duration', fmtDuration(s.elapsed)),
      item('Distance', s.distance != null ? `${(s.distance / 1000).toFixed(2)} km` : null),
      item('Avg / max HR', s.hr && `${r0(s.hr.avg)} / ${s.hr.max} bpm`),
      item('Avg / max power', s.power && `${r0(s.power.avg)} / ${s.power.max} W`),
      item('Normalized power', s.np && `${r0(s.np)} W`),
      item('Avg cadence', s.cadence && `${r0(s.cadence.avg)} rpm`),
      item('Avg speed', s.speed && `${(s.speed.avg * 3.6).toFixed(1)} km/h`),
      item('Elevation gain', s.ascent != null ? `${r0(s.ascent)} m` : null),
      item('Energy', s.work != null ? `${r0(s.work / 1000)} kJ` : null),
      item('Laps', String(m.laps.length))
    ),
    coverageWarnings(s, m)
  );
}

function coverageWarnings(s, m) {
  const notes = [];
  const n = m.records.length;
  for (const key of ['hr', 'power', 'cadence']) {
    if (!state.sources[key] && !state.overrides.some((o) => o.stream === key && o.fileId)) continue;
    const have = m.records.filter((r) => r[key] != null).length;
    if (have < n * 0.95) {
      notes.push(`${streamByKey(key).label} is missing for ${fmtDuration(n - have)} of the activity.`);
    }
  }
  return notes.length ? h('div', { class: 'notes' }, notes.map((t) => h('p', {}, t))) : null;
}

function renderSidebar() {
  const sb = $('sidebar');
  sb.replaceChildren();
  if (!state.files.length) {
    sb.append(section('Files', h('p', { class: 'muted' }, 'No files yet.'), h('button', { class: 'btn ghost full', onclick: openDialog }, '+ Add files')));
    return;
  }
  sb.append(renderFiles(), renderSources(), renderRange(), renderOptions(), renderSummary());
}

// ---------------------------------------------------------------- selection
function renderSelectionBar() {
  const bar = $('selection-bar');
  const sel = state.selection;
  if (!sel || !state.files.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const chartable = STREAMS.filter((s) => state.files.some((f) => hasStream(f.activity, s.key)));
  const streamSel = h('select', { 'aria-label': 'Data type for this range' }, chartable.map((s) => h('option', { value: s.key }, s.label)));
  const srcSel = h('select', { 'aria-label': 'Source for this range' }, fileOptions(null, state.files[0]?.id));
  bar.replaceChildren(
    h('span', { class: 'sel-label' }, `Selected ${fmtClock(sel.from)} – ${fmtClock(sel.to)} (${fmtDuration(sel.to - sel.from)})`),
    h('span', { class: 'sel-group' }, 'Use', streamSel, 'from', srcSel,
      h('button', {
        class: 'btn small primary',
        onclick: () => {
          state.overrides.push({ stream: streamSel.value, fileId: srcSel.value || null, from: sel.from, to: sel.to });
          state.selection = null;
          render();
        },
      }, 'Apply')),
    h('span', { class: 'sel-group' },
      h('button', { class: 'btn small', onclick: () => { state.customRange = { start: sel.from, end: sel.to }; state.rangeMode = 'custom'; state.selection = null; render(); } }, 'Trim to selection'),
      h('button', { class: 'btn small', onclick: () => { state.view = { min: sel.from, max: sel.to }; state.selection = null; render(); } }, 'Zoom in'),
      h('button', { class: 'btn small ghost', onclick: () => { state.selection = null; render(); } }, 'Clear'))
  );
}

// ---------------------------------------------------------------- charts
let charts = [];
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function chartWindow() {
  const spans = state.files.map(fileSpan);
  const range = currentRange();
  let min = Math.min(range.start, ...spans.map((s) => s.start));
  let max = Math.max(range.end, ...spans.map((s) => s.end));
  // Don't plot days of empty time when files are far apart.
  if (max - min > 12 * 3600) ({ start: min, end: max } = range);
  return { min: Math.floor(min), max: Math.ceil(max) };
}

function renderCharts() {
  for (const c of charts) c.destroy();
  charts = [];
  const host = $('charts');
  host.replaceChildren();
  $('empty').hidden = state.files.length > 0;
  if (!state.files.length) return;

  const win = chartWindow();
  const xs = [];
  for (let t = win.min; t <= win.max; t++) xs.push(t);
  const range = currentRange();
  const mergedByT = new Map(state.merged.records.map((r) => [r.t, r]));
  const width = Math.max(400, host.clientWidth - 8);
  const cfg = mergeConfig();
  const grid = css('--grid');
  const axisColor = css('--muted');
  const shade = css('--shade');
  const resultColor = css('--text');

  const streams = STREAMS.filter((s) => s.chart && state.files.some((f) => hasStream(f.activity, s.key)));
  for (const s of streams) {
    const disp = s.display ?? ((v) => v);
    const files = state.files.filter((f) => hasStream(f.activity, s.key));
    const data = [xs];
    const series = [{}];
    for (const f of files) {
      data.push(xs.map((t) => { const v = sampleAt(f, s.key, t, state.maxGap); return v == null ? null : disp(v); }));
      series.push({ label: f.activity.name, stroke: f.color + 'aa', width: 1, spanGaps: false, points: { show: false } });
    }
    data.push(xs.map((t) => { const r = mergedByT.get(t); return r?.[s.key] == null ? null : disp(r[s.key]); }));
    series.push({ label: 'Result', stroke: resultColor, width: 1.6, points: { show: false } });

    const wrap = h('div', { class: 'chart' }, h('div', { class: 'chart-title' }, `${s.label}`, h('small', {}, s.unit)));
    host.append(wrap);

    const opts = {
      width,
      height: 170,
      series,
      scales: { x: { time: true, min: state.view?.min ?? win.min, max: state.view?.max ?? win.max } },
      axes: [
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid } },
        { stroke: axisColor, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, size: 48 },
      ],
      legend: { show: true, live: true },
      cursor: { sync: { key: 'm', setSeries: false }, drag: { x: true, y: false, setScale: false } },
      select: { show: true },
      hooks: {
        drawClear: [
          (u) => {
            // Grey out time outside the export range, and tint exception ranges.
            const { ctx } = u;
            const top = u.bbox.top;
            const hgt = u.bbox.height;
            const X = (t) => u.valToPos(t, 'x', true);
            ctx.save();
            ctx.fillStyle = shade;
            const l = u.bbox.left;
            const rgt = u.bbox.left + u.bbox.width;
            const a = Math.max(l, Math.min(rgt, X(range.start)));
            const b = Math.max(l, Math.min(rgt, X(range.end)));
            if (a > l) ctx.fillRect(l, top, a - l, hgt);
            if (b < rgt) ctx.fillRect(b, top, rgt - b, hgt);
            for (const o of cfg.overrides) {
              if (o.stream !== s.key) continue;
              ctx.fillStyle = (fileById(o.fileId)?.color ?? '#888888') + '22';
              const oa = Math.max(l, X(o.from));
              const ob = Math.min(rgt, X(o.to));
              if (ob > oa) ctx.fillRect(oa, top, ob - oa, hgt);
            }
            ctx.restore();
          },
        ],
        setSelect: [
          (u) => {
            if (u.select.width < 3) return;
            const from = Math.round(u.posToVal(u.select.left, 'x'));
            const to = Math.round(u.posToVal(u.select.left + u.select.width, 'x'));
            state.selection = { from, to };
            for (const c of charts) if (c !== u) c.setSelect({ left: u.select.left, width: u.select.width, top: 0, height: c.bbox.height / devicePixelRatio }, false);
            renderSelectionBar();
          },
        ],
      },
    };
    const u = new uPlot(opts, data, wrap);
    charts.push(u);
  }

  if (state.view) {
    host.prepend(h('div', { class: 'zoom-bar' }, `Zoomed to ${fmtClock(state.view.min)} – ${fmtClock(state.view.max)}`, h('button', { class: 'btn small', onclick: () => { state.view = null; render(); } }, 'Show all')));
  }
  if (!streams.length) host.append(h('p', { class: 'muted' }, 'These files contain no data that can be charted.'));
  if (state.selection) {
    const sel = state.selection;
    for (const c of charts) {
      const left = c.valToPos(sel.from, 'x');
      const right = c.valToPos(sel.to, 'x');
      c.setSelect({ left, width: right - left, top: 0, height: c.bbox.height / devicePixelRatio }, false);
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
  const base = primary.activity.name.replace(/\.[^.]+$/, '');
  const name = `${base}-merged.${format}`;
  const dir = primary.path ? primary.path.replace(/[\\/][^\\/]*$/, '') : null;

  if (window.api) {
    const saved = await window.api.saveFile({ defaultPath: dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${name}` : name, ext: format, data });
    if (saved) toast(`Saved ${saved}`, 'ok', 6000);
  } else {
    const blob = new Blob([data], { type: format === 'fit' ? 'application/octet-stream' : 'application/xml' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    toast(`Downloaded ${name}`, 'ok');
  }
}

// ---------------------------------------------------------------- render
function render() {
  if (state.files.length) {
    const range = currentRange();
    state.merged = range ? mergeActivities({ ...mergeConfig(), range }) : { records: [], laps: [] };
  } else {
    state.merged = null;
  }
  $('export-btn').disabled = !state.merged?.records.length;
  renderSidebar();
  renderSelectionBar();
  renderCharts();
}

// ---------------------------------------------------------------- wiring
$('open-btn').addEventListener('click', openDialog);
$('open-btn-2').addEventListener('click', openDialog);
$('export-btn').addEventListener('click', exportFile);
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
  resizeTimer = setTimeout(() => { const w = Math.max(400, $('charts').clientWidth - 8); for (const c of charts) c.setSize({ width: w, height: 170 }); }, 100);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.files.length && renderCharts());

// Expose for automated UI tests.
window.__state = state;
render();
