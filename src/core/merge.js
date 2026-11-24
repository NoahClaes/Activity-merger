import { STREAM_KEYS, recordValue, hasStream } from './streams.js';
import { haversine } from './parse.js';

// ---------------------------------------------------------------- sampling
// Per-activity, per-stream sorted (time, value) arrays, cached on the activity.
function sampler(activity, key) {
  activity._samplers ??= {};
  if (!activity._samplers[key]) {
    const times = [];
    const values = [];
    for (const r of activity.records) {
      const v = recordValue(r, key);
      if (v != null) {
        times.push(r.t);
        values.push(v);
      }
    }
    activity._samplers[key] = { times, values };
  }
  return activity._samplers[key];
}

function lerp(a, b, f) {
  if (Array.isArray(a)) return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  return a + (b - a) * f;
}

/**
 * Value of `key` from `file` at absolute time T (seconds, UTC), applying the file's
 * time offset. Samples within 0.5 s count as exact; between two samples no more
 * than `maxGap` seconds apart the value is interpolated; otherwise null.
 */
export function sampleAt(file, key, T, maxGap) {
  const { times, values } = sampler(file.activity, key);
  const n = times.length;
  if (n === 0) return null;
  const t = T - file.offset;
  if (t < times[0] - 0.5 || t > times[n - 1] + 0.5) return null;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  // lo = last index with times[lo] <= t (or 0)
  const a = times[lo] <= t ? lo : -1;
  const b = a + 1 < n ? a + 1 : -1;
  if (a >= 0 && t - times[a] < 0.5) return values[a];
  if (b >= 0 && times[b] - t < 0.5) return values[b];
  if (a >= 0 && b >= 0 && times[b] - times[a] <= Math.max(maxGap, 1)) {
    return lerp(values[a], values[b], (t - times[a]) / (times[b] - times[a]));
  }
  return null;
}

export function fileSpan(file) {
  return { start: file.activity.start + file.offset, end: file.activity.end + file.offset };
}

// ---------------------------------------------------------------- defaults
/** For each stream, the file with the most samples of it (or null). */
export function defaultSources(files) {
  const out = {};
  for (const key of STREAM_KEYS) {
    let best = null;
    let bestCount = 0;
    for (const f of files) {
      const c = f.activity.streamCounts[key];
      if (c > bestCount) {
        best = f.id;
        bestCount = c;
      }
    }
    out[key] = best;
  }
  return out;
}

export function rangePreset(files, preset) {
  if (files.length === 0) return null;
  const spans = files.map(fileSpan);
  if (preset === 'all') {
    return { start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) };
  }
  if (preset === 'overlap') {
    const start = Math.max(...spans.map((s) => s.start));
    const end = Math.min(...spans.map((s) => s.end));
    return end > start ? { start, end } : null;
  }
  const f = files.find((x) => x.id === preset);
  return f ? fileSpan(f) : null;
}

/** Which file is the source of `key` at time T, taking overrides into account. */
export function sourceAt(config, key, T) {
  let src = config.sources[key] ?? null;
  for (const o of config.overrides) {
    if (o.stream === key && T >= o.from && T <= o.to) src = o.fileId;
  }
  return src;
}

// ---------------------------------------------------------------- merge
/**
 * Build the merged 1 Hz activity.
 * config: { files, sources, overrides, range:{start,end}, maxGap, lapSource }
 */
export function mergeActivities(config) {
  const { files, range, maxGap } = config;
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  const start = Math.ceil(range.start);
  const end = Math.floor(range.end);
  const records = [];

  let dist = 0;
  let haveDist = false;
  let prevRawDist = null;
  let prevDistSrc = null;
  let prevPos = null;

  for (let T = start; T <= end; T++) {
    const rec = { t: T };
    for (const key of STREAM_KEYS) {
      if (key === 'distance') continue;
      const src = byId[sourceAt(config, key, T)];
      const v = src ? sampleAt(src, key, T, maxGap) : null;
      if (key === 'position') {
        rec.lat = v ? v[0] : null;
        rec.lon = v ? v[1] : null;
      } else {
        rec[key] = v == null ? null : key === 'hr' || key === 'cadence' || key === 'power' ? Math.round(v) : v;
      }
    }

    // Distance is accumulated so switching sources or gaps never makes it jump.
    const dSrcId = sourceAt(config, 'distance', T);
    const dSrc = byId[dSrcId];
    const raw = dSrc ? sampleAt(dSrc, 'distance', T, maxGap) : null;
    let delta = null;
    if (raw != null && prevRawDist != null && prevDistSrc === dSrcId) {
      delta = Math.min(Math.max(0, raw - prevRawDist), 60);
    } else if (rec.speed != null) {
      delta = rec.speed;
    } else if (rec.lat != null && prevPos && dSrcId == null) {
      delta = Math.min(haversine(prevPos[0], prevPos[1], rec.lat, rec.lon), 60);
    }
    if (records.length && delta != null) {
      dist += delta;
      haveDist = true;
    }
    if (raw != null || rec.speed != null) haveDist = true;
    rec.distance = haveDist ? dist : null;
    prevRawDist = raw;
    prevDistSrc = dSrcId;
    if (rec.lat != null) prevPos = [rec.lat, rec.lon];

    const hasData = STREAM_KEYS.some((k) => k !== 'distance' && recordValue(rec, k) != null);
    if (hasData) records.push(rec);
  }

  // Laps: boundaries taken from the chosen file, clipped to the range.
  let laps = [];
  const lapFile = byId[config.lapSource];
  if (lapFile && lapFile.activity.laps.length > 1) {
    const starts = lapFile.activity.laps
      .map((l) => Math.round(l.start + lapFile.offset))
      .filter((s) => s > start && s < end)
      .sort((a, b) => a - b);
    const bounds = [start, ...starts, end + 1];
    for (let i = 0; i < bounds.length - 1; i++) laps.push({ start: bounds[i], end: bounds[i + 1] - 1 });
  } else {
    laps = [{ start, end }];
  }

  return { records, laps, start, end };
}

// ---------------------------------------------------------------- statistics
export function computeStats(records, from = -Infinity, to = Infinity) {
  const rs = records.filter((r) => r.t >= from && r.t <= to);
  const s = {
    count: rs.length,
    start: rs[0]?.t ?? null,
    end: rs[rs.length - 1]?.t ?? null,
  };
  s.elapsed = rs.length ? s.end - s.start + 1 : 0;
  const agg = (key, { skipZero = false } = {}) => {
    let sum = 0;
    let n = 0;
    let max = null;
    for (const r of rs) {
      const v = r[key];
      if (v == null || (skipZero && v === 0)) continue;
      sum += v;
      n++;
      if (max == null || v > max) max = v;
    }
    return n ? { avg: sum / n, max, n } : null;
  };
  s.hr = agg('hr');
  s.power = agg('power');
  s.cadence = agg('cadence', { skipZero: true });
  s.speed = agg('speed');
  s.temp = agg('temp');

  const dists = rs.map((r) => r.distance).filter((d) => d != null);
  s.distance = dists.length ? dists[dists.length - 1] - dists[0] : null;

  // Moving time: seconds with speed > 0.5 m/s or power > 0 (or all, if neither exists).
  const anyMotion = rs.some((r) => r.speed != null || r.power != null);
  s.moving = anyMotion ? rs.filter((r) => (r.speed ?? 0) > 0.5 || (r.power ?? 0) > 0).length : s.elapsed;

  // Ascent/descent with 1 m hysteresis to ignore noise.
  let ascent = 0;
  let descent = 0;
  let ref = null;
  for (const r of rs) {
    if (r.alt == null) continue;
    if (ref == null) ref = r.alt;
    else if (r.alt - ref >= 1) {
      ascent += r.alt - ref;
      ref = r.alt;
    } else if (ref - r.alt >= 1) {
      descent += ref - r.alt;
      ref = r.alt;
    }
  }
  const hasAlt = rs.some((r) => r.alt != null);
  s.ascent = hasAlt ? ascent : null;
  s.descent = hasAlt ? descent : null;

  // Crank revolutions (1 Hz records): cadence / 60 per second.
  if (s.cadence) s.cycles = Math.round(rs.reduce((acc, r) => acc + (r.cadence ?? 0) / 60, 0));

  if (s.power) {
    let work = 0;
    for (const r of rs) work += r.power ?? 0;
    s.work = work; // joules (1 Hz)
    s.calories = Math.round(work / 1000); // kcal ≈ kJ for cycling
    // Normalized power: 30 s rolling mean, 4th-power average.
    const p = rs.map((r) => r.power ?? 0);
    if (p.length >= 30) {
      let win = 0;
      let acc = 0;
      let n = 0;
      for (let i = 0; i < p.length; i++) {
        win += p[i];
        if (i >= 30) win -= p[i - 30];
        if (i >= 29) {
          acc += (win / 30) ** 4;
          n++;
        }
      }
      s.np = (acc / n) ** 0.25;
    }
  }
  return s;
}

// ---------------------------------------------------------------- auto-align
const ALIGN_STREAMS = ['hr', 'power', 'cadence', 'speed'];

function series1Hz(file, key, maxGap) {
  const t0 = Math.ceil(file.activity.start);
  const t1 = Math.floor(file.activity.end);
  const raw = { ...file, offset: 0 };
  const vals = new Array(t1 - t0 + 1);
  for (let t = t0; t <= t1; t++) vals[t - t0] = sampleAt(raw, key, t, maxGap);
  return { t0, vals };
}

/**
 * Find the offset for `file` that best lines it up with `ref` by correlating a
 * stream both files contain. Returns { offset, stream, score } or { error }.
 */
export function autoAlign(ref, file, { maxLag = 600 } = {}) {
  const key = ALIGN_STREAMS.find((k) => hasStream(ref.activity, k) && hasStream(file.activity, k));
  if (!key) {
    return { error: 'These files have no data stream in common (heart rate, power, cadence or speed), so they cannot be aligned automatically.' };
  }
  const R = series1Hz(ref, key, 10);
  const O = series1Hz(file, key, 10);
  const base = Math.round(ref.offset);
  let best = { score: -Infinity, offset: file.offset };
  for (let lag = base - maxLag; lag <= base + maxLag; lag++) {
    // other value at absolute T is O[T - lag - O.t0]; ref value at T is R[T - base - R.t0]
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < R.vals.length; i++) {
      const x = R.vals[i];
      if (x == null) continue;
      const T = R.t0 + i + base;
      const j = T - lag - O.t0;
      if (j < 0 || j >= O.vals.length) continue;
      const y = O.vals[j];
      if (y == null) continue;
      n++;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    if (n < 60) continue;
    const cov = sxy - (sx * sy) / n;
    const vx = sxx - (sx * sx) / n;
    const vy = syy - (sy * sy) / n;
    if (vx <= 0 || vy <= 0) continue;
    const r = cov / Math.sqrt(vx * vy);
    // tiny preference for small shifts when correlations tie
    const score = r - Math.abs(lag - file.offset) * 1e-7;
    if (score > best.score) best = { score, offset: lag, r };
  }
  if (!Number.isFinite(best.score)) {
    return { error: 'The files do not overlap enough in time to align them automatically.' };
  }
  return { offset: best.offset, stream: key, score: best.r };
}
