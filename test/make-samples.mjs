// Generates realistic sample files for testing: a Zwift-style ride without heart
// rate, and a Garmin watch recording of the same ride with only heart rate.
import { Encoder, Profile } from '@garmin/fitsdk';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const out = join(dirname(fileURLToPath(import.meta.url)), 'samples');
mkdirSync(out, { recursive: true });
const M = Profile.MesgNum;
const D2S = 2 ** 31 / 180;

// Deterministic pseudo-random
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const START = Date.parse('2026-11-20T18:00:00Z') / 1000;
const DURATION = 3600;

// Underlying "true" ride: intervals every 5 minutes.
const powerAt = (s) => {
  const block = Math.floor(s / 300) % 2;
  return (block ? 280 : 170) + 20 * Math.sin(s / 17) + (rand() - 0.5) * 30;
};
const hrSeries = [];
let hr = 95;
for (let s = 0; s <= DURATION + 600; s++) {
  const target = s < 120 || s > DURATION + 120 ? 100 : 95 + powerAt(s - 120) * 0.25;
  hr += (target - hr) / 25;
  hrSeries.push(hr + (rand() - 0.5) * 2);
}

function zwift({ withHr = false, name = 'zwift.fit', start = START + 120 } = {}) {
  const enc = new Encoder();
  enc.onMesg(M.FILE_ID, { type: 'activity', manufacturer: 'zwift', product: 0, serialNumber: 1234, timeCreated: new Date(start * 1000) });
  enc.onMesg(M.EVENT, { timestamp: new Date(start * 1000), event: 'timer', eventType: 'start' });
  let dist = 0;
  let lat = -11.64;
  let lon = 166.95;
  const laps = [0, 1200, 2400];
  for (let s = 0; s < DURATION; s++) {
    const p = powerAt(s);
    const speed = 6 + p / 40;
    dist += speed;
    lat += (speed / 111000) * Math.cos(s / 300);
    lon += (speed / 111000) * Math.sin(s / 300);
    const rec = {
      timestamp: new Date((start + s) * 1000),
      power: Math.round(p),
      cadence: Math.round(85 + (rand() - 0.5) * 8),
      speed,
      distance: dist,
      positionLat: Math.round(lat * D2S),
      positionLong: Math.round(lon * D2S),
      altitude: 10 + 30 * Math.sin(s / 600),
    };
    if (withHr) rec.heartRate = Math.round(hrSeries[s + 120]);
    enc.onMesg(M.RECORD, rec);
  }
  laps.forEach((l, i) => {
    const end = i + 1 < laps.length ? laps[i + 1] - 1 : DURATION - 1;
    enc.onMesg(M.LAP, { messageIndex: i, startTime: new Date((start + l) * 1000), timestamp: new Date((start + end) * 1000), totalElapsedTime: end - l + 1, totalTimerTime: end - l + 1, event: 'lap', eventType: 'stop' });
  });
  enc.onMesg(M.SESSION, { messageIndex: 0, startTime: new Date(start * 1000), timestamp: new Date((start + DURATION - 1) * 1000), sport: 'cycling', subSport: 'virtualActivity', totalElapsedTime: DURATION, totalTimerTime: DURATION, totalDistance: dist, numLaps: laps.length, firstLapIndex: 0, event: 'session', eventType: 'stop' });
  enc.onMesg(M.ACTIVITY, { timestamp: new Date((start + DURATION - 1) * 1000), numSessions: 1, type: 'manual', event: 'activity', eventType: 'stop', totalTimerTime: DURATION });
  writeFileSync(join(out, name), enc.close());
}

function watch() {
  const enc = new Encoder();
  enc.onMesg(M.FILE_ID, { type: 'activity', manufacturer: 'garmin', product: 3906, serialNumber: 99, timeCreated: new Date(START * 1000) });
  // Smart recording: a sample every 1–6 s, over 2 minutes before and after the ride.
  for (let s = 0; s <= DURATION + 240; s += 1 + Math.floor(rand() * 6)) {
    enc.onMesg(M.RECORD, { timestamp: new Date((START + s) * 1000), heartRate: Math.round(hrSeries[s]), temperature: 24 });
  }
  enc.onMesg(M.SESSION, { messageIndex: 0, startTime: new Date(START * 1000), timestamp: new Date((START + DURATION + 240) * 1000), sport: 'cycling', subSport: 'indoorCycling', totalElapsedTime: DURATION + 240, event: 'session', eventType: 'stop' });
  writeFileSync(join(out, 'watch.fit'), enc.close());
}

zwift();
// Same ride with HR but the device clock 7 s fast — for testing auto-align.
zwift({ withHr: true, name: 'zwift-with-hr-clock-off.fit', start: START + 120 + 7 });
watch();
console.log('samples written to', out);
