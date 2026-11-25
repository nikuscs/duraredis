import { RedisError, text } from "../resp/reply";
import { TS_ERR } from "./format";

export type Aggregator =
  | "avg"
  | "sum"
  | "min"
  | "max"
  | "range"
  | "count"
  | "first"
  | "last"
  | "std.p"
  | "std.s"
  | "var.p"
  | "var.s"
  | "twa"
  | "countnan"
  | "countall";

export type BucketTimestampMode = "start" | "end" | "mid";

export interface Sample {
  ts: number;
  val: number;
}

export interface AggOpts {
  agg: Aggregator;
  bucketDuration: number;
  align: number;
  bucketTs: BucketTimestampMode;
  empty: boolean;
}

const AGG_MAP = new Map<string, Aggregator>([
  ["avg", "avg"], ["sum", "sum"], ["min", "min"], ["max", "max"], ["range", "range"],
  ["count", "count"], ["first", "first"], ["last", "last"],
  ["std.p", "std.p"], ["std.s", "std.s"], ["var.p", "var.p"], ["var.s", "var.s"],
  ["twa", "twa"], ["countnan", "countnan"], ["countall", "countall"],
]);

const REDUCER_MAP = new Map<string, Aggregator>([
  ["avg", "avg"], ["sum", "sum"], ["min", "min"], ["max", "max"], ["range", "range"],
  ["count", "count"], ["std.p", "std.p"], ["std.s", "std.s"], ["var.p", "var.p"], ["var.s", "var.s"],
  ["countnan", "countnan"], ["countall", "countall"],
]);

export function parseAggregator(b: Uint8Array, error: string = TS_ERR.badAggType): Aggregator {
  const found = AGG_MAP.get(text(b).toLowerCase());
  if (!found) throw new RedisError(error);
  return found;
}

export function aggregatorByName(s: string): Aggregator {
  return AGG_MAP.get(s) ?? "avg";
}

export function parseReducer(b: Uint8Array): Aggregator {
  const found = REDUCER_MAP.get(text(b).toLowerCase());
  if (!found) throw new RedisError(TS_ERR.badReducer);
  return found;
}

export function rawBucketStart(ts: number, align: number, bucketDuration: number): number {
  const rem = ((ts - align) % bucketDuration + bucketDuration) % bucketDuration;
  return ts - rem;
}

export function bucketTimestamp(rawStart: number, bucketDuration: number, mode: BucketTimestampMode): number {
  const start = Math.max(0, rawStart);
  if (mode === "start") return start;
  if (mode === "end") return rawStart + bucketDuration;
  return start + Math.floor((rawStart + bucketDuration - start) / 2);
}

function variance(vals: Array<number>, sample: boolean): number {
  if (vals.length <= 1) return 0;
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let sq = 0;
  for (const v of vals) sq += (v - mean) * (v - mean);
  return sq / (sample ? vals.length - 1 : vals.length);
}

function lerp(a: Sample, b: Sample, t: number): number {
  if (b.ts === a.ts) return a.val;
  return a.val + ((b.val - a.val) * (t - a.ts)) / (b.ts - a.ts);
}

function computeTwa(valid: Array<Sample>, bStart: number, bEnd: number, prev: Sample | undefined, next: Sample | undefined): number {
  if (!valid.length) {
    if (!prev || !next) return Number.NaN;
    return (lerp(prev, next, bStart) + lerp(prev, next, bEnd)) / 2;
  }
  const pts: Array<{ t: number; v: number }> = [];
  if (prev && valid[0].ts > bStart) pts.push({ t: bStart, v: lerp(prev, valid[0], bStart) });
  for (const s of valid) pts.push({ t: s.ts, v: s.val });
  const lastValid = valid.at(-1);
  if (next && lastValid && lastValid.ts < bEnd) pts.push({ t: bEnd, v: lerp(lastValid, next, bEnd) });
  if (pts.length === 1) return pts[0].v;
  const lastPt = pts.at(-1);
  if (!lastPt) return pts[0].v;
  const span = lastPt.t - pts[0].t;
  if (span <= 0) return pts[0].v;
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += ((pts[i].v + pts[i + 1].v) * (pts[i + 1].t - pts[i].t)) / 2;
  }
  return area / span;
}

export function reduceValues(agg: Aggregator, values: Array<number>): number | undefined {
  let nanCount = 0;
  const valid: Array<number> = [];
  for (const v of values) {
    if (Number.isNaN(v)) nanCount++;
    else valid.push(v);
  }
  if (agg === "countnan") return values.length > 0 ? nanCount : undefined;
  if (agg === "countall") return values.length > 0 ? values.length : undefined;
  if (!valid.length) return undefined;
  return aggregateValid(agg, valid);
}

function aggregateValid(agg: Aggregator, valid: Array<number>): number {
  switch (agg) {
    case "count":
      return valid.length;
    case "first":
      return valid[0];
    case "last":
      return valid.at(-1) ?? Number.NaN;
    case "sum": {
      let s = 0;
      for (const v of valid) s += v;
      return s;
    }
    case "avg": {
      let s = 0;
      for (const v of valid) s += v;
      return s / valid.length;
    }
    case "min": {
      let m = valid[0];
      for (let i = 1; i < valid.length; i++) if (valid[i] < m) m = valid[i];
      return m;
    }
    case "max": {
      let m = valid[0];
      for (let i = 1; i < valid.length; i++) if (valid[i] > m) m = valid[i];
      return m;
    }
    case "range": {
      let lo = valid[0];
      let hi = valid[0];
      for (let i = 1; i < valid.length; i++) {
        if (valid[i] < lo) lo = valid[i];
        if (valid[i] > hi) hi = valid[i];
      }
      return hi - lo;
    }
    case "var.p":
      return variance(valid, false);
    case "var.s":
      return variance(valid, true);
    case "std.p":
      return Math.sqrt(variance(valid, false));
    case "std.s":
      return Math.sqrt(variance(valid, true));
    case "twa":
    case "countnan":
    case "countall":
      return Number.NaN;
  }
}

export function aggregateBucket(
  agg: Aggregator,
  bucketSamples: Array<Sample>,
  bStart: number,
  bEnd: number,
  prevValid: Sample | undefined,
  nextValid: Sample | undefined,
  includeZeroNan = false,
): number | undefined {
  let nanCount = 0;
  const valid: Array<Sample> = [];
  for (const s of bucketSamples) {
    if (Number.isNaN(s.val)) nanCount++;
    else valid.push(s);
  }
  if (agg === "countnan") return nanCount > 0 || (includeZeroNan && bucketSamples.length > 0) ? nanCount : undefined;
  if (agg === "countall") return bucketSamples.length > 0 ? bucketSamples.length : undefined;
  if (!valid.length) return undefined;
  if (agg === "twa") return computeTwa(valid, bStart, bEnd, prevValid, nextValid);
  return aggregateValid(agg, valid.map((s) => s.val));
}

function emptyBucketValue(
  agg: Aggregator,
  bStart: number,
  bEnd: number,
  lastNonEmpty: number | undefined,
  prevValid: Sample | undefined,
  nextValid: Sample | undefined,
): number {
  if (agg === "sum" || agg === "count" || agg === "countnan" || agg === "countall") return 0;
  if (agg === "last") return lastNonEmpty ?? Number.NaN;
  if (agg === "twa") return computeTwa([], bStart, bEnd, prevValid, nextValid);
  return Number.NaN;
}

export function aggregateSamples(samples: Array<Sample>, twaPool: Array<Sample>, opts: AggOpts): Array<Sample> {
  if (!samples.length) return [];
  const { agg, bucketDuration, align, bucketTs, empty } = opts;
  const validPool = agg === "twa" ? twaPool.filter((s) => !Number.isNaN(s.val)) : [];
  const groups = new Map<number, Array<Sample>>();
  for (const s of samples) {
    const raw = rawBucketStart(s.ts, align, bucketDuration);
    const list = groups.get(raw);
    if (list) list.push(s);
    else groups.set(raw, [s]);
  }
  const rawKeys = [...groups.keys()].toSorted((a, b) => a - b);
  const nonEmpty: Array<{ raw: number; val: number; lastValid: number | undefined }> = [];
  let pIdx = 0;
  for (const raw of rawKeys) {
    const bStart = Math.max(0, raw);
    const bEnd = raw + bucketDuration;
    while (pIdx < validPool.length && validPool[pIdx].ts < bStart) pIdx++;
    const prevValid = pIdx > 0 ? validPool[pIdx - 1] : undefined;
    let nIdx = pIdx;
    while (nIdx < validPool.length && validPool[nIdx].ts < bEnd) nIdx++;
    const nextValid = nIdx < validPool.length ? validPool[nIdx] : undefined;
    const bucket = groups.get(raw) ?? [];
    const val = aggregateBucket(agg, bucket, bStart, bEnd, prevValid, nextValid, empty);
    if (val === undefined) continue;
    let lastValid: number | undefined;
    for (let i = bucket.length - 1; i >= 0; i--) {
      if (!Number.isNaN(bucket[i].val)) {
        lastValid = bucket[i].val;
        break;
      }
    }
    nonEmpty.push({ raw, val, lastValid });
  }
  const firstItem = nonEmpty[0];
  const lastItem = nonEmpty.at(-1);
  if (!firstItem || !lastItem) return [];
  if (!empty) return nonEmpty.map((e) => ({ ts: bucketTimestamp(e.raw, bucketDuration, bucketTs), val: e.val }));

  const firstRaw = firstItem.raw;
  const lastRaw = lastItem.raw;
  const out: Array<Sample> = [];
  let neIdx = 0;
  let lastValidVal: number | undefined;
  let tvIdx = 0;
  for (let raw = firstRaw; raw <= lastRaw; raw += bucketDuration) {
    const ts = bucketTimestamp(raw, bucketDuration, bucketTs);
    if (neIdx < nonEmpty.length && nonEmpty[neIdx].raw === raw) {
      const item = nonEmpty[neIdx++];
      if (item.lastValid !== undefined) lastValidVal = item.lastValid;
      out.push({ ts, val: item.val });
      continue;
    }
    const bStart = Math.max(0, raw);
    const bEnd = raw + bucketDuration;
    while (tvIdx < validPool.length && validPool[tvIdx].ts < bStart) tvIdx++;
    const prevValid = tvIdx > 0 ? validPool[tvIdx - 1] : undefined;
    const nextValid = tvIdx < validPool.length ? validPool[tvIdx] : undefined;
    out.push({ ts, val: emptyBucketValue(agg, bStart, bEnd, lastValidVal, prevValid, nextValid) });
  }
  return out;
}
