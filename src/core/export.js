import { Encoder, Profile, Utils } from '@garmin/fitsdk';
import { computeStats } from './merge.js';
import { buildSummary } from './overrides.js';

const DEG_TO_SEMI = 2 ** 31 / 180;
const date = (t) => new Date(t * 1000);
const iso = (t) => new Date(Math.round(t) * 1000).toISOString().replace('.000Z', 'Z');
const r = (v, d = 0) => (v == null ? null : Number(v.toFixed(d)));
const clamp = (v, lo, hi) => (v == null ? null : Math.min(hi, Math.max(lo, v)));

export const SPORTS = [
  // [sport, subSport, label, group]
  ['cycling', 'virtualActivity', 'Virtual ride', 'Cycling'],
  ['cycling', 'indoorCycling', 'Indoor ride (trainer)', 'Cycling'],
  ['cycling', 'road', 'Road ride', 'Cycling'],
  ['cycling', 'gravelCycling', 'Gravel ride', 'Cycling'],
  ['cycling', 'mountain', 'Mountain bike ride', 'Cycling'],
  ['cycling', 'cyclocross', 'Cyclocross', 'Cycling'],
  ['cycling', 'trackCycling', 'Track cycling', 'Cycling'],
  ['cycling', 'commuting', 'Commute ride', 'Cycling'],
  ['cycling', 'recumbent', 'Recumbent ride', 'Cycling'],
  ['cycling', 'handCycling', 'Hand cycling', 'Cycling'],
  ['cycling', 'generic', 'Ride', 'Cycling'],
  ['eBiking', 'generic', 'E-bike ride', 'Cycling'],
  ['eBiking', 'eBikeMountain', 'E-mountain bike ride', 'Cycling'],
  ['running', 'virtualActivity', 'Virtual run', 'Running'],
  ['running', 'treadmill', 'Treadmill run', 'Running'],
  ['running', 'indoorRunning', 'Indoor run', 'Running'],
  ['running', 'street', 'Road run', 'Running'],
  ['running', 'trail', 'Trail run', 'Running'],
  ['running', 'track', 'Track run', 'Running'],
  ['running', 'ultra', 'Ultra run', 'Running'],
  ['running', 'generic', 'Run', 'Running'],
  ['walking', 'generic', 'Walk', 'Other'],
  ['walking', 'indoorWalking', 'Indoor walk', 'Other'],
  ['hiking', 'generic', 'Hike', 'Other'],
  ['rowing', 'indoorRowing', 'Indoor rowing', 'Other'],
  ['rowing', 'generic', 'Rowing', 'Other'],
  ['fitnessEquipment', 'elliptical', 'Elliptical', 'Other'],
  ['fitnessEquipment', 'stairClimbing', 'Stair stepper', 'Other'],
  ['swimming', 'openWater', 'Open water swim', 'Other'],
  ['crossCountrySkiing', 'generic', 'Cross-country skiing', 'Other'],
  ['inlineSkating', 'generic', 'Inline skating', 'Other'],
  ['training', 'cardioTraining', 'Cardio', 'Other'],
  ['training', 'strengthTraining', 'Strength training', 'Other'],
  ['hiit', 'generic', 'HIIT', 'Other'],
  ['generic', 'generic', 'Other', 'Other'],
].map(([sport, subSport, label, group]) => ({ id: `${sport}/${subSport}`, sport, subSport, label, group }));

export function sportFromActivity(a) {
  const exact = SPORTS.find((s) => s.sport === a.sport && s.subSport === a.subSport);
  if (exact) return exact.id;
  const bySport = SPORTS.find((s) => s.sport === a.sport && s.subSport === 'generic');
  return bySport?.id ?? 'generic/generic';
}

const TCX_SPORT = { cycling: 'Biking', eBiking: 'Biking', running: 'Running' };

// Summary values in FIT field names, from a buildSummary() result.
function summaryFields(sum) {
  return {
    totalElapsedTime: sum.elapsed,
    totalTimerTime: sum.elapsed,
    totalDistance: sum.distance,
    avgSpeed: r(sum.avgSpeed, 3),
    maxSpeed: r(sum.maxSpeed, 3),
    enhancedAvgSpeed: r(sum.avgSpeed, 3),
    enhancedMaxSpeed: r(sum.maxSpeed, 3),
    avgHeartRate: clamp(r(sum.avgHr), 0, 254),
    maxHeartRate: clamp(r(sum.maxHr), 0, 254),
    avgPower: r(sum.avgPower),
    maxPower: r(sum.maxPower),
    normalizedPower: r(sum.np),
    thresholdPower: r(sum.ftp),
    trainingStressScore: r(sum.tss, 1),
    intensityFactor: r(sum.if, 3),
    totalWork: sum.work != null ? Math.round(sum.work) : null,
    avgCadence: clamp(r(sum.avgCadence), 0, 254),
    maxCadence: clamp(r(sum.maxCadence), 0, 254),
    totalCycles: r(sum.totalCycles),
    totalAscent: r(sum.ascent),
    totalDescent: r(sum.descent),
    totalCalories: r(sum.calories),
    avgTemperature: r(sum.avgTemp),
    maxTemperature: r(sum.maxTemp),
    totalTrainingEffect: clamp(r(sum.aerobicTE, 1), 0, 5),
    totalAnaerobicTrainingEffect: clamp(r(sum.anaerobicTE, 1), 0, 5),
    trainingLoadPeak: sum.trainingLoad,
    totalGrit: sum.totalGrit,
    avgFlow: sum.avgFlow,
    jumpCount: r(sum.jumps),
  };
}

function dropNulls(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && !Number.isNaN(v)));
}

/**
 * @param merged result of mergeActivities (records already cleaned up)
 * @param opts {
 *   sport: 'cycling/virtualActivity',
 *   device: { manufacturer, product },   // what the file says it was recorded on
 *   serialNumber, softwareVersion (e.g. 26.12),
 *   overrides                            // see overrides.js
 * }
 * @returns Uint8Array
 */
export function toFit(merged, opts = {}) {
  const sport = SPORTS.find((s) => s.id === opts.sport) ?? SPORTS[0];
  const { records, laps, start } = merged;
  const end = records[records.length - 1].t;
  const enc = new Encoder();
  const M = Profile.MesgNum;
  const write = (mesgNum, fields) => enc.onMesg(mesgNum, dropNulls(fields));

  const known = Object.values(Profile.types.manufacturer);
  const dev = opts.device ?? {};
  const manufacturer = dev.manufacturer && known.includes(dev.manufacturer) ? dev.manufacturer : 'development';
  const product = Number.isInteger(dev.product) ? dev.product : 0;
  const serialNumber = Number.isInteger(opts.serialNumber) && opts.serialNumber > 0 ? opts.serialNumber : Math.floor(1e9 + Math.random() * 1e9);
  const sw = typeof opts.softwareVersion === 'number' && Number.isFinite(opts.softwareVersion) ? opts.softwareVersion : null;

  write(M.FILE_ID, { type: 'activity', manufacturer, product, serialNumber, timeCreated: date(start) });
  if (sw != null) write(M.FILE_CREATOR, { softwareVersion: Math.round(sw * 100) });
  write(M.DEVICE_INFO, {
    timestamp: date(start),
    deviceIndex: 'creator',
    manufacturer,
    product,
    serialNumber,
    softwareVersion: sw,
  });
  write(M.EVENT, { timestamp: date(start), event: 'timer', eventType: 'start' });

  for (const rec of records) {
    write(M.RECORD, {
      timestamp: date(rec.t),
      heartRate: clamp(r(rec.hr), 0, 254),
      power: clamp(r(rec.power), 0, 65534),
      cadence: clamp(r(rec.cadence), 0, 254),
      speed: clamp(r(rec.speed, 3), 0, 65.5),
      enhancedSpeed: r(rec.speed, 3),
      distance: r(rec.distance, 2),
      positionLat: rec.lat != null ? Math.round(rec.lat * DEG_TO_SEMI) : null,
      positionLong: rec.lon != null ? Math.round(rec.lon * DEG_TO_SEMI) : null,
      altitude: clamp(r(rec.alt, 1), -500, 12000),
      enhancedAltitude: r(rec.alt, 1),
      temperature: clamp(r(rec.temp), -127, 127),
    });
  }

  write(M.EVENT, { timestamp: date(end), event: 'timer', eventType: 'stopAll' });

  const total = buildSummary(computeStats(records), opts.overrides);
  laps.forEach((lap, i) => {
    const stats = computeStats(records, lap.start, lap.end);
    if (!stats.count) return;
    // With a single lap the lap is the whole activity, so it gets the overrides too.
    const sum = laps.length === 1 ? total : buildSummary(stats, {});
    const first = records.find((x) => x.t >= lap.start && x.lat != null && x.t <= lap.end);
    write(M.LAP, {
      messageIndex: i,
      timestamp: date(stats.end),
      startTime: date(stats.start),
      event: 'lap',
      eventType: 'stop',
      lapTrigger: i === laps.length - 1 ? 'sessionEnd' : 'manual',
      sport: sport.sport,
      subSport: sport.subSport,
      startPositionLat: first ? Math.round(first.lat * DEG_TO_SEMI) : null,
      startPositionLong: first ? Math.round(first.lon * DEG_TO_SEMI) : null,
      ...summaryFields(sum),
      // these are session-only in the FIT profile
      totalTrainingEffect: undefined,
      totalAnaerobicTrainingEffect: undefined,
      trainingLoadPeak: undefined,
      thresholdPower: undefined,
      trainingStressScore: undefined,
      intensityFactor: undefined,
      totalGrit: undefined,
      avgFlow: undefined,
      jumpCount: undefined,
    });
  });

  write(M.SESSION, {
    messageIndex: 0,
    timestamp: date(end),
    startTime: date(start),
    event: 'session',
    eventType: 'stop',
    trigger: 'activityEnd',
    sport: sport.sport,
    subSport: sport.subSport,
    firstLapIndex: 0,
    numLaps: laps.length,
    ...summaryFields(total),
  });

  const tzOffset = -new Date(end * 1000).getTimezoneOffset() * 60;
  write(M.ACTIVITY, {
    timestamp: date(end),
    totalTimerTime: total.elapsed,
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
    localTimestamp: Utils.convertDateToDateTime(date(end)) + tzOffset,
  });

  return enc.close();
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

export function toTcx(merged, opts = {}) {
  const sport = SPORTS.find((s) => s.id === opts.sport) ?? SPORTS[0];
  const tcxSport = TCX_SPORT[sport.sport] ?? 'Other';
  const { records, laps, start } = merged;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"' +
      ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">'
  );
  out.push(`<Activities><Activity Sport="${tcxSport}"><Id>${iso(start)}</Id>`);
  for (const lap of laps) {
    const s = computeStats(records, lap.start, lap.end);
    if (!s.count) continue;
    const sum = buildSummary(s, laps.length === 1 ? opts.overrides : {});
    out.push(`<Lap StartTime="${iso(s.start)}">`);
    out.push(`<TotalTimeSeconds>${s.elapsed}</TotalTimeSeconds>`);
    out.push(`<DistanceMeters>${r(sum.distance ?? 0, 1)}</DistanceMeters>`);
    if (s.speed) out.push(`<MaximumSpeed>${r(s.speed.max, 3)}</MaximumSpeed>`);
    out.push(`<Calories>${r(sum.calories ?? 0)}</Calories>`);
    if (sum.avgHr != null) out.push(`<AverageHeartRateBpm><Value>${r(sum.avgHr)}</Value></AverageHeartRateBpm>`);
    if (sum.maxHr != null) out.push(`<MaximumHeartRateBpm><Value>${r(sum.maxHr)}</Value></MaximumHeartRateBpm>`);
    out.push('<Intensity>Active</Intensity>');
    if (sum.avgCadence != null) out.push(`<Cadence>${clamp(r(sum.avgCadence), 0, 254)}</Cadence>`);
    out.push('<TriggerMethod>Manual</TriggerMethod><Track>');
    for (const rec of records) {
      if (rec.t < lap.start || rec.t > lap.end) continue;
      let tp = `<Trackpoint><Time>${iso(rec.t)}</Time>`;
      if (rec.lat != null) {
        tp += `<Position><LatitudeDegrees>${r(rec.lat, 7)}</LatitudeDegrees><LongitudeDegrees>${r(rec.lon, 7)}</LongitudeDegrees></Position>`;
      }
      if (rec.alt != null) tp += `<AltitudeMeters>${r(rec.alt, 1)}</AltitudeMeters>`;
      if (rec.distance != null) tp += `<DistanceMeters>${r(rec.distance, 1)}</DistanceMeters>`;
      if (rec.hr != null) tp += `<HeartRateBpm><Value>${rec.hr}</Value></HeartRateBpm>`;
      if (rec.cadence != null) tp += `<Cadence>${clamp(rec.cadence, 0, 254)}</Cadence>`;
      if (rec.speed != null || rec.power != null) {
        tp += '<Extensions><ns3:TPX>';
        if (rec.speed != null) tp += `<ns3:Speed>${r(rec.speed, 3)}</ns3:Speed>`;
        if (rec.power != null) tp += `<ns3:Watts>${rec.power}</ns3:Watts>`;
        tp += '</ns3:TPX></Extensions>';
      }
      out.push(tp + '</Trackpoint>');
    }
    out.push('</Track>');
    if (s.speed || s.power) {
      out.push('<Extensions><ns3:LX>');
      if (s.speed) out.push(`<ns3:AvgSpeed>${r(s.speed.avg, 3)}</ns3:AvgSpeed>`);
      if (s.power) out.push(`<ns3:AvgWatts>${r(s.power.avg)}</ns3:AvgWatts><ns3:MaxWatts>${r(s.power.max)}</ns3:MaxWatts>`);
      out.push('</ns3:LX></Extensions>');
    }
    out.push('</Lap>');
  }
  out.push('<Creator xsi:type="Device_t"><Name>Activity Merger</Name><UnitId>0</UnitId><ProductID>0</ProductID>');
  out.push('<Version><VersionMajor>1</VersionMajor><VersionMinor>0</VersionMinor></Version></Creator>');
  out.push('</Activity></Activities></TrainingCenterDatabase>');
  return out.join('\n');
}

export function toGpx(merged, opts = {}) {
  const sport = SPORTS.find((s) => s.id === opts.sport) ?? SPORTS[0];
  const { records, start } = merged;
  const pts = records.filter((x) => x.lat != null);
  if (!pts.length) throw new Error('GPX needs GPS positions, but the merged activity has none. Export as FIT or TCX instead.');
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<gpx version="1.1" creator="Activity Merger" xmlns="http://www.topografix.com/GPX/1/1"' +
      ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">'
  );
  out.push(`<metadata><time>${iso(start)}</time></metadata>`);
  out.push(`<trk><name>${esc(opts.name ?? sport.label)}</name><type>${sport.sport}</type><trkseg>`);
  for (const rec of pts) {
    let p = `<trkpt lat="${r(rec.lat, 7)}" lon="${r(rec.lon, 7)}">`;
    if (rec.alt != null) p += `<ele>${r(rec.alt, 1)}</ele>`;
    p += `<time>${iso(rec.t)}</time>`;
    const tpx =
      (rec.temp != null ? `<gpxtpx:atemp>${r(rec.temp, 1)}</gpxtpx:atemp>` : '') +
      (rec.hr != null ? `<gpxtpx:hr>${rec.hr}</gpxtpx:hr>` : '') +
      (rec.cadence != null ? `<gpxtpx:cad>${rec.cadence}</gpxtpx:cad>` : '');
    if (tpx || rec.power != null) {
      p += '<extensions>';
      if (rec.power != null) p += `<power>${rec.power}</power>`;
      if (tpx) p += `<gpxtpx:TrackPointExtension>${tpx}</gpxtpx:TrackPointExtension>`;
      p += '</extensions>';
    }
    out.push(p + '</trkpt>');
  }
  out.push('</trkseg></trk></gpx>');
  return out.join('\n');
}
