import { Decoder, Stream } from '@garmin/fitsdk';
import { XMLParser } from 'fast-xml-parser';
import { countStreams } from './streams.js';

const SEMI_TO_DEG = 180 / 2 ** 31;

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'object' ? Number(v['#text']) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toSec = (d) => (d instanceof Date ? d.getTime() : Date.parse(d)) / 1000;

export function detectFormat(name, bytes) {
  if (bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54) {
    return 'fit';
  }
  const head = new TextDecoder().decode(bytes.slice(0, 2000)).toLowerCase();
  if (head.includes('<trainingcenterdatabase')) return 'tcx';
  if (head.includes('<gpx')) return 'gpx';
  const ext = name.toLowerCase().split('.').pop();
  if (['fit', 'tcx', 'gpx'].includes(ext)) return ext;
  throw new Error('Unrecognised file type (expected FIT, TCX or GPX)');
}

/**
 * Parse a FIT/TCX/GPX file into a normalised activity.
 * @param {string} name file name
 * @param {Uint8Array} bytes file contents
 */
export function parseActivity(name, bytes) {
  const format = detectFormat(name, bytes);
  const result =
    format === 'fit' ? parseFit(bytes) : format === 'tcx' ? parseTcx(bytes) : parseGpx(bytes);

  const records = cleanRecords(result.records);
  if (records.length === 0) throw new Error('No data points with timestamps found in this file');

  return {
    name,
    format,
    sport: result.sport ?? null,
    subSport: result.subSport ?? null,
    device: result.device ?? null,
    manufacturer: result.manufacturer ?? null,
    product: result.product ?? null,
    laps: result.laps ?? [],
    warnings: result.warnings ?? [],
    records,
    start: records[0].t,
    end: records[records.length - 1].t,
    streamCounts: countStreams(records),
  };
}

// Sort, drop duplicate timestamps (merging their fields), drop impossible values.
function cleanRecords(records) {
  const sorted = records.filter((r) => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const r of sorted) {
    if (r.hr != null && (r.hr <= 0 || r.hr > 250)) r.hr = null;
    if (r.cadence != null && (r.cadence < 0 || r.cadence > 250)) r.cadence = null;
    if (r.power != null && (r.power < 0 || r.power > 3000)) r.power = null;
    if (r.speed != null && (r.speed < 0 || r.speed > 60)) r.speed = null;
    if (r.lat != null && (Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180 || (r.lat === 0 && r.lon === 0))) {
      r.lat = r.lon = null;
    }
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - r.t) < 0.001) {
      for (const [k, v] of Object.entries(r)) if (v != null && prev[k] == null) prev[k] = v;
    } else {
      out.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------- FIT
function parseFit(bytes) {
  const decoder = new Decoder(Stream.fromByteArray(bytes));
  if (!decoder.isFIT()) throw new Error('Not a valid FIT file');
  const warnings = [];
  if (!decoder.checkIntegrity()) warnings.push('File checksum is invalid; data may be incomplete.');

  const { messages, errors } = decoder.read({ mergeHeartRates: true });
  if (errors.length && !messages.recordMesgs?.length) throw new Error(errors[0].message);
  if (errors.length) warnings.push(`Partially read: ${errors[0].message}`);

  const records = (messages.recordMesgs ?? [])
    .filter((m) => m.timestamp)
    .map((m) => ({
      t: toSec(m.timestamp),
      hr: m.heartRate ?? null,
      power: m.power ?? null,
      cadence: m.cadence ?? null,
      speed: m.enhancedSpeed ?? m.speed ?? null,
      distance: m.distance ?? null,
      lat: m.positionLat != null ? m.positionLat * SEMI_TO_DEG : null,
      lon: m.positionLong != null ? m.positionLong * SEMI_TO_DEG : null,
      alt: m.enhancedAltitude ?? m.altitude ?? null,
      temp: m.temperature ?? null,
    }));

  const session = messages.sessionMesgs?.[0] ?? {};
  const fileId = messages.fileIdMesgs?.[0] ?? {};
  const laps = (messages.lapMesgs ?? [])
    .filter((l) => l.startTime)
    .map((l) => ({
      start: toSec(l.startTime),
      end: l.timestamp ? toSec(l.timestamp) : null,
    }));

  const manufacturer = typeof fileId.manufacturer === 'string' ? fileId.manufacturer : null;
  const product =
    (typeof fileId.garminProduct === 'string' ? fileId.garminProduct : null) ??
    fileId.productName ??
    (manufacturer === 'garmin' && fileId.product ? fileId.product : null);
  const device = [manufacturer, product].filter((x) => x != null).map(prettyName).join(' ') || null;

  return {
    records,
    laps,
    warnings,
    sport: typeof session.sport === 'string' ? session.sport : null,
    subSport: typeof session.subSport === 'string' ? session.subSport : null,
    manufacturer,
    product: typeof fileId.product === 'number' ? fileId.product : null,
    device,
  };
}

function prettyName(s) {
  if (typeof s !== 'string') return String(s);
  return s.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- XML
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['Activity', 'Lap', 'Track', 'Trackpoint', 'trk', 'trkseg', 'trkpt'].includes(name),
});

function parseTcx(bytes) {
  const doc = xml.parse(new TextDecoder().decode(bytes));
  const act = doc?.TrainingCenterDatabase?.Activities?.Activity?.[0];
  if (!act) throw new Error('TCX file contains no activity');
  const records = [];
  const laps = [];
  for (const lap of act.Lap ?? []) {
    if (lap['@StartTime']) laps.push({ start: toSec(lap['@StartTime']), end: null });
    for (const track of lap.Track ?? []) {
      for (const tp of track.Trackpoint ?? []) {
        if (!tp.Time) continue;
        const tpx = tp.Extensions?.TPX ?? {};
        records.push({
          t: toSec(tp.Time),
          hr: num(tp.HeartRateBpm?.Value),
          power: num(tpx.Watts),
          cadence: num(tp.Cadence) ?? num(tpx.RunCadence),
          speed: num(tpx.Speed),
          distance: num(tp.DistanceMeters),
          lat: num(tp.Position?.LatitudeDegrees),
          lon: num(tp.Position?.LongitudeDegrees),
          alt: num(tp.AltitudeMeters),
          temp: null,
        });
      }
    }
  }
  const sportMap = { Biking: 'cycling', Running: 'running' };
  return {
    records,
    laps,
    sport: sportMap[act['@Sport']] ?? null,
    device: typeof act.Creator?.Name === 'string' ? act.Creator.Name : null,
  };
}

function parseGpx(bytes) {
  const doc = xml.parse(new TextDecoder().decode(bytes));
  const gpx = doc?.gpx;
  if (!gpx) throw new Error('Invalid GPX file');
  const records = [];
  for (const trk of gpx.trk ?? []) {
    for (const seg of trk.trkseg ?? []) {
      for (const p of seg.trkpt ?? []) {
        if (!p.time) continue;
        const ext = p.extensions ?? {};
        const tpe = ext.TrackPointExtension ?? {};
        records.push({
          t: toSec(p.time),
          hr: num(tpe.hr) ?? num(ext.hr) ?? num(ext.heartrate),
          power: num(ext.power) ?? num(ext.PowerInWatts) ?? num(tpe.power),
          cadence: num(tpe.cad) ?? num(ext.cad) ?? num(ext.cadence),
          speed: num(tpe.speed),
          distance: null,
          lat: num(p['@lat']),
          lon: num(p['@lon']),
          alt: num(p.ele),
          temp: num(tpe.atemp) ?? num(ext.atemp),
        });
      }
    }
  }
  // GPX has no distance; derive it (and speed when missing) from the positions.
  records.sort((a, b) => a.t - b.t);
  let dist = 0;
  let prev = null;
  for (const r of records) {
    if (r.lat == null) continue;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, r.lat, r.lon);
      const dt = r.t - prev.t;
      dist += d;
      if (r.speed == null && dt > 0 && dt <= 10) r.speed = d / dt;
    }
    r.distance = dist;
    prev = r;
  }
  const creator = gpx['@creator'];
  const type = String(gpx.trk?.[0]?.type ?? '').toLowerCase();
  return {
    records,
    laps: [],
    sport: /cycl|bik|ride/.test(type) ? 'cycling' : /run/.test(type) ? 'running' : null,
    device: typeof creator === 'string' ? creator : null,
  };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
