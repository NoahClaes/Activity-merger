// Data streams the app knows about. Every parsed activity is normalised to
// records of { t, hr, power, cadence, speed, distance, lat, lon, alt, temp }
// where t is seconds since the Unix epoch (UTC) and units are SI:
// speed m/s, distance m, alt m, temp °C, lat/lon degrees.

export const STREAMS = [
  { key: 'hr', label: 'Heart rate', unit: 'bpm', chart: true },
  { key: 'power', label: 'Power', unit: 'W', chart: true },
  { key: 'cadence', label: 'Cadence', unit: 'rpm', chart: true },
  { key: 'speed', label: 'Speed', unit: 'km/h', chart: true, display: (v) => v * 3.6 },
  { key: 'distance', label: 'Distance', unit: 'km', chart: false, display: (v) => v / 1000 },
  { key: 'position', label: 'GPS position', unit: '', chart: false },
  { key: 'alt', label: 'Elevation', unit: 'm', chart: true },
  { key: 'temp', label: 'Temperature', unit: '°C', chart: true },
];

export const STREAM_KEYS = STREAMS.map((s) => s.key);

export function streamByKey(key) {
  return STREAMS.find((s) => s.key === key);
}

// Value of a stream on a record (position is a pair).
export function recordValue(rec, key) {
  if (key === 'position') {
    return rec.lat != null && rec.lon != null ? [rec.lat, rec.lon] : null;
  }
  const v = rec[key];
  return v == null || Number.isNaN(v) ? null : v;
}

export function hasStream(activity, key) {
  return activity.streamCounts[key] > 0;
}

export function countStreams(records) {
  const counts = Object.fromEntries(STREAM_KEYS.map((k) => [k, 0]));
  for (const r of records) {
    for (const k of STREAM_KEYS) if (recordValue(r, k) != null) counts[k]++;
  }
  return counts;
}
