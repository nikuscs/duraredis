export const GEO_STEP_MAX = 26;
export const GEO_LAT_MIN = -85.05112878;
export const GEO_LAT_MAX = 85.05112878;
export const GEO_LONG_MIN = -180.0;
export const GEO_LONG_MAX = 180.0;

const WGS84_LAT_MIN = -90.0;
const WGS84_LAT_MAX = 90.0;
const EARTH_RADIUS_IN_METERS = 6_372_797 + 560_856 / 1_000_000;
const MERCATOR_MAX = 20_037_726.37;
const D_R = Math.PI / 180;
const GEOALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface GeoHashBits {
  bits: bigint;
  step: number;
}

export interface GeoArea {
  lonMin: number;
  lonMax: number;
  latMin: number;
  latMax: number;
}

function spread(v: number): bigint {
  let x = BigInt(v >>> 0);
  x = (x | (x << 16n)) & 0x00_00_ff_ff_00_00_ff_ffn;
  x = (x | (x << 8n)) & 0x00_ff_00_ff_00_ff_00_ffn;
  x = (x | (x << 4n)) & 0x0f_0f_0f_0f_0f_0f_0f_0fn;
  x = (x | (x << 2n)) & 0x33_33_33_33_33_33_33_33n;
  x = (x | (x << 1n)) & 0x55_55_55_55_55_55_55_55n;
  return x;
}

function compact(v: bigint): number {
  let x = v & 0x55_55_55_55_55_55_55_55n;
  x = (x | (x >> 1n)) & 0x33_33_33_33_33_33_33_33n;
  x = (x | (x >> 2n)) & 0x0f_0f_0f_0f_0f_0f_0f_0fn;
  x = (x | (x >> 4n)) & 0x00_ff_00_ff_00_ff_00_ffn;
  x = (x | (x >> 8n)) & 0x00_00_ff_ff_00_00_ff_ffn;
  x = (x | (x >> 16n)) & 0x00_00_00_00_ff_ff_ff_ffn;
  return Number(x);
}

export function interleave64(latInt: number, lonInt: number): bigint {
  return spread(latInt) | (spread(lonInt) << 1n);
}

export function deinterleave64(bits: bigint): [number, number] {
  return [compact(bits), compact(bits >> 1n)];
}

export function encodeGeohash(lon: number, lat: number, latMin: number, latMax: number, step = GEO_STEP_MAX): bigint {
  const scale = 2 ** step;
  const latOff = Math.trunc(((lat - latMin) / (latMax - latMin)) * scale);
  const lonOff = Math.trunc(((lon - GEO_LONG_MIN) / (GEO_LONG_MAX - GEO_LONG_MIN)) * scale);
  return interleave64(latOff, lonOff);
}

export function encodeMercatorScore(lon: number, lat: number): number {
  return Number(encodeGeohash(lon, lat, GEO_LAT_MIN, GEO_LAT_MAX, GEO_STEP_MAX));
}

export function scoreToBits(score: number): bigint {
  if (!Number.isFinite(score) || score <= 0) return 0n;
  if (score >= 2 ** 64) return 0xff_ff_ff_ff_ff_ff_ff_ffn;
  return BigInt(Math.trunc(score));
}

export function decodeArea(bits: bigint, step = GEO_STEP_MAX): GeoArea {
  const [ilato, ilono] = deinterleave64(bits);
  const scale = 2 ** step;
  const latScale = GEO_LAT_MAX - GEO_LAT_MIN;
  const lonScale = GEO_LONG_MAX - GEO_LONG_MIN;
  return {
    lonMin: GEO_LONG_MIN + (ilono / scale) * lonScale,
    lonMax: GEO_LONG_MIN + ((ilono + 1) / scale) * lonScale,
    latMin: GEO_LAT_MIN + (ilato / scale) * latScale,
    latMax: GEO_LAT_MIN + ((ilato + 1) / scale) * latScale,
  };
}

export function decodeMercator(bits: bigint): [number, number] {
  const area = decodeArea(bits, GEO_STEP_MAX);
  const lon = Math.min(GEO_LONG_MAX, Math.max(GEO_LONG_MIN, (area.lonMin + area.lonMax) / 2));
  const lat = Math.min(GEO_LAT_MAX, Math.max(GEO_LAT_MIN, (area.latMin + area.latMax) / 2));
  return [lon, lat];
}

export function geohashString(lon: number, lat: number): string {
  const b = encodeGeohash(lon, lat, WGS84_LAT_MIN, WGS84_LAT_MAX, GEO_STEP_MAX);
  let s = "";
  for (let i = 0; i < 10; i++) s += GEOALPHABET[Number((b >> BigInt(52 - (i + 1) * 5)) & 0x1fn)];
  return `${s}0`;
}

export function latDistance(lat1: number, lat2: number): number {
  return EARTH_RADIUS_IN_METERS * Math.abs(lat2 * D_R - lat1 * D_R);
}

export function geohashDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const lon1r = lon1 * D_R;
  const lon2r = lon2 * D_R;
  const v = Math.sin((lon2r - lon1r) / 2);
  if (v === 0) return latDistance(lat1, lat2);
  const lat1r = lat1 * D_R;
  const lat2r = lat2 * D_R;
  const u = Math.sin((lat2r - lat1r) / 2);
  return 2 * EARTH_RADIUS_IN_METERS * Math.asin(Math.sqrt(u * u + Math.cos(lat1r) * Math.cos(lat2r) * v * v));
}

export function inRadius(lon1: number, lat1: number, lon2: number, lat2: number, radiusM: number): number | null {
  const d = geohashDistance(lon1, lat1, lon2, lat2);
  return d > radiusM ? null : d;
}

export function inRectangle(widthM: number, heightM: number, lon1: number, lat1: number, lon2: number, lat2: number): number | null {
  if (latDistance(lat2, lat1) > heightM / 2) return null;
  if (geohashDistance(lon2, lat2, lon1, lat2) > widthM / 2) return null;
  return geohashDistance(lon1, lat1, lon2, lat2);
}

function estimateSteps(rangeM: number, lat: number): number {
  if (rangeM === 0) return GEO_STEP_MAX;
  let step = 1;
  let range = rangeM;
  while (range < MERCATOR_MAX) {
    range *= 2;
    step++;
  }
  step -= 2;
  if (lat > 66 || lat < -66) {
    step--;
    if (lat > 80 || lat < -80) step--;
  }
  if (step < 1) return 1;
  if (step > GEO_STEP_MAX) return GEO_STEP_MAX;
  return step;
}

function moveHash(bits: bigint, step: number, dx: number, dy: number): GeoHashBits {
  const [lat, lon] = deinterleave64(bits);
  const mask = (1 << step) - 1;
  return { bits: interleave64((lat + dy) & mask, (lon + dx) & mask), step };
}

function makeNeighbors(bits: bigint, step: number): Array<GeoHashBits | null> {
  return [
    { bits, step },
    moveHash(bits, step, 0, 1),
    moveHash(bits, step, 0, -1),
    moveHash(bits, step, 1, 0),
    moveHash(bits, step, -1, 0),
    moveHash(bits, step, 1, 1),
    moveHash(bits, step, -1, 1),
    moveHash(bits, step, 1, -1),
    moveHash(bits, step, -1, -1),
  ];
}

export function searchRanges(lon: number, lat: number, halfW: number, halfH: number, estRadius: number): Array<[number, number]> {
  if (halfW === 0 || halfH === 0) return [];
  let steps = estimateSteps(estRadius, lat);
  let bits = encodeGeohash(lon, lat, GEO_LAT_MIN, GEO_LAT_MAX, steps);
  let area = decodeArea(bits, steps);
  const north = geohashDistance(lon, lat, lon, area.latMax);
  const south = geohashDistance(lon, lat, lon, area.latMin);
  const east = geohashDistance(lon, lat, area.lonMax, lat);
  const west = geohashDistance(lon, lat, area.lonMin, lat);
  if (steps > 1 && (north < halfH || south < halfH || east < halfW || west < halfW)) {
    steps--;
    bits = encodeGeohash(lon, lat, GEO_LAT_MIN, GEO_LAT_MAX, steps);
    area = decodeArea(bits, steps);
  }
  const boxes = makeNeighbors(bits, steps);
  if (steps >= 2) {
    const latDelta = halfH / EARTH_RADIUS_IN_METERS / D_R;
    const lonDelta = halfW / EARTH_RADIUS_IN_METERS / Math.cos(lat * D_R) / D_R;
    const minLat = lat - latDelta;
    const maxLat = lat + latDelta;
    const minLon = lon - lonDelta;
    const maxLon = lon + lonDelta;
    if (area.latMin < minLat) {
      boxes[2] = null;
      boxes[7] = null;
      boxes[8] = null;
    }
    if (area.latMax > maxLat) {
      boxes[1] = null;
      boxes[5] = null;
      boxes[6] = null;
    }
    if (area.lonMin < minLon) {
      boxes[4] = null;
      boxes[6] = null;
      boxes[8] = null;
    }
    if (area.lonMax > maxLon) {
      boxes[3] = null;
      boxes[5] = null;
      boxes[7] = null;
    }
  }
  const seen = new Set<bigint>();
  const ranges: Array<[number, number]> = [];
  for (const box of boxes) {
    if (!box || seen.has(box.bits)) continue;
    seen.add(box.bits);
    const shift = BigInt(52 - box.step * 2);
    ranges.push([Number(box.bits << shift), Number((box.bits + 1n) << shift)]);
  }
  return ranges;
}
