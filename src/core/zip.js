import { unzipSync } from 'fflate';

const ACTIVITY = /\.(fit|tcx|gpx)$/i;
const isZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Expand .zip files (e.g. Garmin Connect "Export Original") into the activity
 * files inside them. Other files pass through unchanged.
 * @param {{name:string,data:Uint8Array,path?:string}[]} items
 */
export function expandZips(items) {
  const out = [];
  for (const item of items) {
    if (!isZip(item.data)) {
      out.push(item);
      continue;
    }
    const entries = unzipSync(item.data, { filter: (f) => ACTIVITY.test(f.name) && !f.name.startsWith('__MACOSX') });
    const names = Object.keys(entries);
    if (!names.length) throw new Error(`${item.name} contains no FIT, TCX or GPX file`);
    for (const n of names) out.push({ name: n.split('/').pop(), data: entries[n], path: item.path ?? null });
  }
  return out;
}
