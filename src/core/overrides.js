// User overrides: data cleanup applied to the merged records, and summary values
// that replace the calculated ones in the exported file.
//
// ov (all optional, SI units):
//   maxHr, maxPower                       discard values above these
//   powerAdjust: { value, mode: 'percent'|'watts' }
//   totalCalories, totalDistance (m), totalAscent (m), totalDescent (m)
//   aerobicTE, anaerobicTE, trainingLoad, np, tss, if, ftp
//   totalCycles, totalGrit, avgFlow, jumps, avgHr, avgCadence, avgPower

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function adjustRecords(records, ov = {}) {
  const maxHr = isNum(ov.maxHr) ? ov.maxHr : null;
  const maxPower = isNum(ov.maxPower) ? ov.maxPower : null;
  const adj = ov.powerAdjust && isNum(ov.powerAdjust.value) && ov.powerAdjust.value !== 0 ? ov.powerAdjust : null;
  if (maxHr == null && maxPower == null && !adj) return records;
  return records.map((r) => {
    const out = { ...r };
    if (maxHr != null && out.hr != null && out.hr > maxHr) out.hr = null;
    if (maxPower != null && out.power != null && out.power > maxPower) out.power = null;
    if (adj && out.power != null && out.power > 0) {
      const p = adj.mode === 'watts' ? out.power + adj.value : out.power * (1 + adj.value / 100);
      out.power = Math.max(0, Math.round(p));
    }
    return out;
  });
}

/**
 * Final summary for the whole activity: calculated stats with overrides on top.
 * Returns plain numbers (or null) in SI units, plus `edited` listing overridden keys.
 */
export function buildSummary(stats, ov = {}) {
  const s = {
    elapsed: stats.elapsed,
    distance: stats.distance,
    calories: stats.calories ?? null,
    ascent: stats.ascent,
    descent: stats.descent,
    avgHr: stats.hr?.avg ?? null,
    maxHr: stats.hr?.max ?? null,
    avgPower: stats.power?.avg ?? null,
    maxPower: stats.power?.max ?? null,
    np: stats.np ?? null,
    work: stats.work ?? null,
    avgCadence: stats.cadence?.avg ?? null,
    maxCadence: stats.cadence?.max ?? null,
    avgSpeed: stats.speed?.avg ?? null,
    maxSpeed: stats.speed?.max ?? null,
    avgTemp: stats.temp?.avg ?? null,
    maxTemp: stats.temp?.max ?? null,
    totalCycles: stats.cycles ?? null,
    ftp: null,
    tss: null,
    if: null,
    aerobicTE: null,
    anaerobicTE: null,
    trainingLoad: null,
    totalGrit: null,
    avgFlow: null,
    jumps: null,
    edited: [],
  };
  const map = {
    totalCalories: 'calories',
    totalDistance: 'distance',
    totalAscent: 'ascent',
    totalDescent: 'descent',
    avgHr: 'avgHr',
    avgPower: 'avgPower',
    avgCadence: 'avgCadence',
    np: 'np',
    tss: 'tss',
    if: 'if',
    ftp: 'ftp',
    aerobicTE: 'aerobicTE',
    anaerobicTE: 'anaerobicTE',
    trainingLoad: 'trainingLoad',
    totalCycles: 'totalCycles',
    totalGrit: 'totalGrit',
    avgFlow: 'avgFlow',
    jumps: 'jumps',
  };
  for (const [k, key] of Object.entries(map)) {
    if (isNum(ov[k])) {
      s[key] = ov[k];
      s.edited.push(key);
    }
  }
  // With an FTP and a normalized power, intensity factor and TSS follow.
  if (isNum(s.ftp) && s.ftp > 0 && isNum(s.np)) {
    if (!isNum(ov.if)) s.if = s.np / s.ftp;
    if (!isNum(ov.tss)) s.tss = ((s.elapsed * s.np * s.if) / (s.ftp * 3600)) * 100;
  }
  return s;
}
