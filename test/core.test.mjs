import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseActivity } from '../src/core/parse.js';
import { mergeActivities, defaultSources, rangePreset, autoAlign, computeStats } from '../src/core/merge.js';
import { toFit, toTcx, toGpx } from '../src/core/export.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'samples');
const load = (name, id) => ({ id, offset: 0, activity: parseActivity(name, new Uint8Array(readFileSync(join(dir, name)))) });

function zwiftPlusWatch() {
  const files = [load('zwift.fit', 'z'), load('watch.fit', 'w')];
  return {
    files,
    sources: defaultSources(files),
    overrides: [],
    range: rangePreset(files, 'z'),
    maxGap: 10,
    lapSource: 'z',
  };
}

test('parses FIT files', () => {
  const z = load('zwift.fit', 'z').activity;
  const w = load('watch.fit', 'w').activity;
  assert.equal(z.format, 'fit');
  assert.equal(z.streamCounts.hr, 0);
  assert.equal(z.streamCounts.power, 3600);
  assert.equal(z.laps.length, 3);
  assert.equal(z.sport, 'cycling');
  assert.ok(w.streamCounts.hr > 500);
  assert.match(w.device, /Garmin/);
});

test('default sources pick HR from the watch and the rest from Zwift', () => {
  const { sources } = zwiftPlusWatch();
  assert.equal(sources.hr, 'w');
  assert.equal(sources.power, 'z');
  assert.equal(sources.position, 'z');
  assert.equal(sources.temp, 'w');
});

test('merge fills HR every second from smart-recorded watch data', () => {
  const cfg = zwiftPlusWatch();
  const m = mergeActivities(cfg);
  assert.equal(m.records.length, 3600);
  assert.ok(m.records.every((r) => r.hr != null && r.power != null));
  assert.equal(m.laps.length, 3);
  const s = computeStats(m.records);
  assert.ok(s.hr.avg > 120 && s.hr.avg < 160, `avg hr ${s.hr.avg}`);
  assert.ok(Math.abs(s.distance - cfg.files[0].activity.records.at(-1).distance) < 20);
});

test('no gap filling leaves holes where the watch skipped seconds', () => {
  const cfg = { ...zwiftPlusWatch(), maxGap: 0 };
  const m = mergeActivities(cfg);
  const withHr = m.records.filter((r) => r.hr != null).length;
  assert.ok(withHr < 3600 * 0.6, `${withHr}`);
});

test('override: no HR for the first 10 minutes', () => {
  const cfg = zwiftPlusWatch();
  cfg.overrides = [{ stream: 'hr', fileId: null, from: cfg.range.start, to: cfg.range.start + 599 }];
  const m = mergeActivities(cfg);
  assert.ok(m.records.slice(0, 600).every((r) => r.hr == null));
  assert.ok(m.records.slice(600).every((r) => r.hr != null));
});

test('distance stays continuous when its source switches', () => {
  const cfg = zwiftPlusWatch();
  cfg.overrides = [{ stream: 'distance', fileId: null, from: cfg.range.start + 1000, to: cfg.range.start + 1100 }];
  const m = mergeActivities(cfg);
  for (let i = 1; i < m.records.length; i++) {
    const d = m.records[i].distance - m.records[i - 1].distance;
    assert.ok(d >= 0 && d < 30, `jump ${d} at ${i}`);
  }
});

test('auto-align finds a 7 s clock difference', () => {
  const w = load('watch.fit', 'w');
  const z = load('zwift-with-hr-clock-off.fit', 'z');
  const res = autoAlign(w, z);
  assert.equal(res.stream, 'hr');
  assert.equal(res.offset, -7);
  assert.ok(res.score > 0.9);
});

test('auto-align explains when there is no shared stream', () => {
  const res = autoAlign(load('zwift.fit', 'z'), load('watch.fit', 'w'));
  assert.match(res.error, /no data stream in common/);
});

test('FIT export round-trips', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const bytes = toFit(m, { sport: 'cycling/virtualActivity', manufacturer: 'zwift' });
  const back = parseActivity('out.fit', bytes);
  assert.equal(back.records.length, 3600);
  assert.equal(back.streamCounts.hr, 3600);
  assert.equal(back.streamCounts.power, 3600);
  assert.equal(back.laps.length, 3);
  assert.equal(back.sport, 'cycling');
  assert.equal(back.subSport, 'virtualActivity');
  assert.deepEqual(back.warnings, []);
  assert.ok(Math.abs(back.records[100].lat - m.records[100].lat) < 1e-6);
});

test('TCX export round-trips', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const back = parseActivity('out.tcx', new TextEncoder().encode(toTcx(m, {})));
  assert.equal(back.format, 'tcx');
  assert.equal(back.records.length, 3600);
  assert.equal(back.streamCounts.hr, 3600);
  assert.equal(back.streamCounts.power, 3600);
  assert.equal(back.laps.length, 3);
});

test('GPX export round-trips', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const back = parseActivity('out.gpx', new TextEncoder().encode(toGpx(m, {})));
  assert.equal(back.format, 'gpx');
  assert.equal(back.records.length, 3600);
  assert.equal(back.streamCounts.hr, 3600);
  assert.equal(back.streamCounts.power, 3600);
  assert.equal(back.streamCounts.cadence, 3600);
});

test('GPX export refuses an activity without positions', () => {
  const files = [load('watch.fit', 'w')];
  const m = mergeActivities({ files, sources: defaultSources(files), overrides: [], range: rangePreset(files, 'w'), maxGap: 10 });
  assert.throws(() => toGpx(m), /GPS positions/);
});
