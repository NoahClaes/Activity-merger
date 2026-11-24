import { Profile } from '@garmin/fitsdk';

// Devices/apps the output file can claim to come from. Garmin devices get their
// exact FIT product id (Garmin Connect and Strava show the device name from it);
// other brands and apps are identified by manufacturer only.

const GARMIN_POPULAR = [
  ['fr965', 'Forerunner 965'],
  ['fr955', 'Forerunner 955 / 955 Solar'],
  ['fr970', 'Forerunner 970'],
  ['fr570Large', 'Forerunner 570 (47 mm)'],
  ['fr265Large', 'Forerunner 265'],
  ['fr265Small', 'Forerunner 265S'],
  ['fr255', 'Forerunner 255'],
  ['fr255Music', 'Forerunner 255 Music'],
  ['fr945', 'Forerunner 945'],
  ['fr745', 'Forerunner 745'],
  ['fr165', 'Forerunner 165'],
  ['fenix8', 'Fenix 8 (AMOLED 47 mm)'],
  ['fenix8Solar', 'Fenix 8 Solar (47 mm)'],
  ['fenix8Pro', 'Fenix 8 Pro'],
  ['fenix7', 'Fenix 7 / 7 Solar'],
  ['fenix7ProSolar', 'Fenix 7 Pro Solar'],
  ['fenix7x', 'Fenix 7X'],
  ['fenix7xProSolar', 'Fenix 7X Pro Solar'],
  ['fenix6', 'Fenix 6'],
  ['epixGen2', 'Epix (Gen 2)'],
  ['epixGen2Pro47', 'Epix Pro (47 mm)'],
  ['enduro3', 'Enduro 3'],
  ['enduro2', 'Enduro 2'],
  ['instinct3Solar45mm', 'Instinct 3 Solar (45 mm)'],
  ['instinct2', 'Instinct 2'],
  ['venu3', 'Venu 3'],
  ['vivoactive5', 'Vivoactive 5'],
  ['edge1050', 'Edge 1050'],
  ['edge1040', 'Edge 1040'],
  ['edge1030Plus', 'Edge 1030 Plus'],
  ['edge840', 'Edge 840'],
  ['edge830', 'Edge 830'],
  ['edge540', 'Edge 540'],
  ['edge530', 'Edge 530'],
  ['edge130Plus', 'Edge 130 Plus'],
  ['edgeExplore2', 'Edge Explore 2'],
  ['connectiq', 'Garmin Connect IQ app'],
];

const APPS = [
  ['zwift', 'Zwift'],
  ['mywhoosh', 'MyWhoosh'],
  ['trainerRoad', 'TrainerRoad'],
  ['virtualtraining', 'ROUVY (VirtualTraining)'],
  ['tacx', 'Tacx'],
  ['wahooFitness', 'Wahoo (ELEMNT / SYSTM)'],
  ['hammerhead', 'Hammerhead Karoo'],
  ['bryton', 'Bryton'],
  ['coros', 'COROS'],
  ['polarElectro', 'Polar'],
  ['suunto', 'Suunto'],
  ['strava', 'Strava'],
  ['peloton', 'Peloton'],
  ['bkool', 'BKOOL'],
  ['elite', 'Elite'],
  ['rGTCycling', 'RGT Cycling'],
  ['stagesCycling', 'Stages Cycling'],
  ['sram', 'SRAM'],
  ['magene', 'Magene'],
  ['igpsport', 'iGPSPORT'],
  ['lezyne', 'Lezyne'],
  ['onelap', 'Onelap'],
  ['zepp', 'Zepp (Amazfit)'],
  ['saris', 'Saris'],
];

const REGIONAL = /(Asia|Apac|Japan|Korea|China|Taiwan|Sea|India|Jpn|Kor|Chn|Twn)$/;
const PREFIXES = [
  [/^fr(?=\d)/, 'Forerunner '],
  [/^vivoActive/i, 'Vivoactive '],
  [/^vivoMove/i, 'Vivomove '],
  [/^vivoSmart/i, 'Vivosmart '],
  [/^vivoFit/i, 'Vivofit '],
  [/^vivoKi/i, 'Vivoki '],
];

export function prettyProduct(key) {
  let s = key;
  for (const [re, rep] of PREFIXES) s = s.replace(re, rep);
  s = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-z]{2,})(\d)/g, '$1 $2')
    .replace(/(\d)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettyManufacturer(key) {
  return prettyProduct(key).replace(/\bByte$/, '').trim();
}

let cache;
/** @returns {{ popular: Device[], apps: Device[], garmin: Device[], other: Device[] }} */
export function deviceCatalog() {
  if (cache) return cache;
  const gp = Profile.types.garminProduct;
  const idOf = Object.fromEntries(Object.entries(gp).map(([id, name]) => [name, Number(id)]));
  const mfr = Profile.types.manufacturer;
  const mfrNames = new Set(Object.values(mfr));

  const popular = GARMIN_POPULAR.filter(([k]) => idOf[k] != null).map(([k, label]) => ({
    id: `garmin:${idOf[k]}`,
    label: `Garmin ${label}`,
    manufacturer: 'garmin',
    product: idOf[k],
  }));
  const apps = APPS.filter(([k]) => mfrNames.has(k)).map(([k, label]) => ({ id: `mfr:${k}`, label, manufacturer: k, product: 0 }));

  const garmin = Object.entries(gp)
    .filter(([, name]) => !REGIONAL.test(name))
    .map(([id, name]) => ({ id: `garmin:${id}`, label: `Garmin ${prettyProduct(name)}`, manufacturer: 'garmin', product: Number(id) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

  const shown = new Set(apps.map((a) => a.manufacturer).concat(['garmin', 'development', 'invalid']));
  const other = Object.values(mfr)
    .filter((k) => typeof k === 'string' && !shown.has(k))
    .map((k) => ({ id: `mfr:${k}`, label: prettyManufacturer(k), manufacturer: k, product: 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));

  cache = { popular, apps, garmin, other };
  return cache;
}

export function findDevice(id) {
  const c = deviceCatalog();
  return [...c.popular, ...c.apps, ...c.garmin, ...c.other].find((d) => d.id === id) ?? null;
}
