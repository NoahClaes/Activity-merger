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

// ---------------------------------------------------------------- overrides, device, zip
import { Decoder, Stream } from '@garmin/fitsdk';
import { zipSync } from 'fflate';
import { adjustRecords, buildSummary } from '../src/core/overrides.js';
import { deviceCatalog, findDevice } from '../src/core/devices.js';
import { expandZips } from '../src/core/zip.js';

function decode(bytes) {
  const d = new Decoder(Stream.fromByteArray(bytes));
  assert.ok(d.checkIntegrity());
  return d.read().messages;
}

test('FIT export writes the chosen device, serial and software version', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const dev = findDevice(deviceCatalog().popular.find((d) => /955/.test(d.label)).id);
  const msgs = decode(toFit(m, { device: dev, serialNumber: 3456789012, softwareVersion: 26.12 }));
  assert.equal(msgs.fileIdMesgs[0].manufacturer, 'garmin');
  assert.equal(msgs.fileIdMesgs[0].garminProduct, 'fr955');
  assert.equal(msgs.fileIdMesgs[0].serialNumber, 3456789012);
  assert.equal(msgs.fileCreatorMesgs[0].softwareVersion, 2612);
  assert.equal(msgs.deviceInfoMesgs[0].deviceIndex, 'creator');
  assert.equal(msgs.deviceInfoMesgs[0].softwareVersion, 26.12);
});

test('FIT export can claim an app such as MyWhoosh', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const msgs = decode(toFit(m, { device: findDevice('mfr:mywhoosh') }));
  assert.equal(msgs.fileIdMesgs[0].manufacturer, 'mywhoosh');
});

test('random serial numbers differ between exports', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const a = decode(toFit(m, {})).fileIdMesgs[0].serialNumber;
  const b = decode(toFit(m, {})).fileIdMesgs[0].serialNumber;
  assert.notEqual(a, b);
});

test('summary overrides end up in the FIT session', () => {
  const m = mergeActivities(zwiftPlusWatch());
  const ov = { totalCalories: 900, totalDistance: 42000, totalAscent: 300, aerobicTE: 3.4, anaerobicTE: 1.2, trainingLoad: 150, ftp: 250, avgHr: 140, jumps: 3, totalGrit: 12.5, avgFlow: 4.2 };
  const s = decode(toFit(m, { overrides: ov })).sessionMesgs[0];
  assert.equal(s.totalCalories, 900);
  assert.equal(s.totalDistance, 42000);
  assert.equal(s.totalAscent, 300);
  assert.equal(s.totalTrainingEffect, 3.4);
  assert.equal(s.totalAnaerobicTrainingEffect, 1.2);
  assert.equal(s.trainingLoadPeak, 150);
  assert.equal(s.thresholdPower, 250);
  assert.equal(s.avgHeartRate, 140);
  assert.equal(s.jumpCount, 3);
  assert.ok(Math.abs(s.totalGrit - 12.5) < 0.01);
  // IF and TSS calculated from FTP and NP
  assert.ok(s.intensityFactor > 0.9 && s.intensityFactor < 1.0, `IF ${s.intensityFactor}`);
  assert.ok(s.trainingStressScore > 80 && s.trainingStressScore < 100, `TSS ${s.trainingStressScore}`);
});

test('explicit TSS/IF win over calculated ones', () => {
  const sum = buildSummary({ elapsed: 3600, np: 250 }, { ftp: 250, tss: 77, if: 0.81 });
  assert.equal(sum.tss, 77);
  assert.equal(sum.if, 0.81);
  assert.deepEqual(sum.edited.sort(), ['ftp', 'if', 'tss']);
});

test('discard and adjust values in records', () => {
  const recs = [{ t: 1, hr: 120, power: 200 }, { t: 2, hr: 230, power: 1800 }, { t: 3, hr: 130, power: 0 }];
  const a = adjustRecords(recs, { maxHr: 200, maxPower: 1500, powerAdjust: { value: 10, mode: 'percent' } });
  assert.deepEqual(a.map((r) => [r.hr, r.power]), [[120, 220], [null, null], [130, 0]]);
  const b = adjustRecords(recs, { powerAdjust: { value: -15, mode: 'watts' } });
  assert.deepEqual(b.map((r) => r.power), [185, 1785, 0]);
  assert.equal(recs[0].power, 200, 'original records untouched');
});

test('device catalog has popular devices, apps and all Garmin products', () => {
  const c = deviceCatalog();
  assert.ok(c.popular.some((d) => d.label === 'Garmin Forerunner 955 / 955 Solar'));
  for (const app of ['Zwift', 'MyWhoosh', 'TrainerRoad']) assert.ok(c.apps.some((d) => d.label === app), app);
  assert.ok(c.garmin.length > 300);
});

test('zip files are expanded into the activity files inside', () => {
  const fit = new Uint8Array(readFileSync(join(dir, 'zwift.fit')));
  const zip = zipSync({ '12345_ACTIVITY.fit': fit, 'readme.txt': new TextEncoder().encode('hi') });
  const items = expandZips([{ name: 'export.zip', data: zip }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, '12345_ACTIVITY.fit');
  assert.equal(parseActivity(items[0].name, items[0].data).streamCounts.power, 3600);
});

test('Garmin Connect GPX export gets a warning', () => {
  const gpx = '<?xml version="1.0"?><gpx creator="Garmin Connect" version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="50" lon="4"><time>2026-11-21T10:00:00Z</time></trkpt><trkpt lat="50.0001" lon="4"><time>2026-11-21T10:00:01Z</time></trkpt></trkseg></trk></gpx>';
  const a = parseActivity('a.gpx', new TextEncoder().encode(gpx));
  assert.match(a.warnings[0], /Export Original/);
});
