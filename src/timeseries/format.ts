import { r, RedisError, text } from "../resp/reply";
import type { Proto, Reply } from "../resp/reply";

export const TS_ERR = {
  wrongType: "ERR WRONGTYPE Operation against a key holding the wrong kind of value",
  noKey: "ERR TSDB: the key does not exist",
  notTsKey: "ERR TSDB: the key is not a TSDB key",
  keyExists: "ERR TSDB: key already exists",
  badRetention: "TSDB: Couldn't parse RETENTION",
  badChunkSize: "ERR TSDB: CHUNK_SIZE value must be a multiple of 8 in the range [48 .. 1048576]",
  badEncoding: "ERR TSDB: unknown ENCODING parameter",
  badDupPolicy: "ERR TSDB: Unknown DUPLICATE_POLICY",
  badIgnoreNeg: "ERR TSDB: IGNORE arguments cannot be negative",
  badIgnoreParse: "ERR TSDB: Couldn't parse IGNORE",
  badLabels: "ERR TSDB: Couldn't parse LABELS",
  badTimestamp: "ERR TSDB: invalid timestamp",
  negTimestamp: "ERR TSDB: invalid timestamp, must be a nonnegative integer",
  badValue: "ERR TSDB: invalid value",
  oldTimestamp: "ERR TSDB: Timestamp is older than retention",
  upsertBlocked: "ERR TSDB: Error at upsert, update is not supported when DUPLICATE_POLICY is set to BLOCK mode, or either current or new value is NaN and DUPLICATE_POLICY is MAX/MIN/SUM",
  incrOldTs: "TSDB: timestamp must be equal to or higher than the maximum existing timestamp",
  incrNan: "ERR TSDB: cannot increment/decrement NaN value",
  badFromTs: "ERR TSDB: wrong fromTimestamp",
  badToTs: "ERR TSDB: wrong toTimestamp",
  badAggType: "ERR TSDB: Unknown aggregation type",
  badBucketDuration: "ERR TSDB: bucketDuration must be greater than zero",
  badCount: "ERR TSDB: Invalid COUNT value",
  alignNeedsAgg: "ERR TSDB: ALIGN parameter can only be used with AGGREGATION",
  alignStartExplicit: "ERR TSDB: start alignment can only be used with explicit start timestamp",
  alignEndExplicit: "ERR TSDB: end alignment can only be used with explicit end timestamp",
  withAndSelected: "ERR TSDB: cannot accept WITHLABELS and SELECT_LABELS together",
  needMatcher: "ERR TSDB: please provide at least one matcher",
  badFilterLabels: "ERR TSDB: failed parsing labels",
  excludeWithGroupby: "ERR TSDB: EXCLUDEEMPTY is not allowed with GROUPBY",
  badReducer: "ERR TSDB: Invalid reducer type",
  sameRuleKeys: "ERR TSDB: the source key and destination key should be different",
  destHasRule: "ERR TSDB: the destination key already has a src rule",
  srcHasRule: "ERR TSDB: the source key already has a source rule",
  noRule: "ERR TSDB: compaction rule does not exist",
  nrangeNumkeys: "ERR TSDB: numkeys must be a positive integer",
  nrangeAggCount: "ERR TSDB: the number of AGGREGATION arguments must be equal to numkeys",
  badAggParse: "ERR TSDB: Couldn't parse AGGREGATION",
  queryLabelsSubtype: "ERR TSDB: unknown subtype, must be one of LABELS|VALUES",
  queryLabelsNoFilter: "ERR TSDB: FILTER given with no filter expressions",
  readBadTs: "TSDB: invalid timestamp",
  readBadMaxCount: "TSDB: MAX_COUNT must be a positive integer",
  readBadBlockMs: "TSDB: BLOCK milliseconds must be a non-negative integer",
  readBadMinCount: "TSDB: BLOCK min_count must be a positive integer",
  readMinGtMax: "TSDB: BLOCK min_count must be <= MAX_COUNT",
  readBlockDenied: "TSDB: blocking TS.READ (with BLOCK) is not allowed inside MULTI, EVAL, or a deny-blocking context",
} as const;

export function formatTsResp2Float(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const sign = n < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(n).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exp);
  const kk = exponent + 1;
  if (kk > 0 && kk <= digits.length) {
    return `${sign}${digits.slice(0, kk)}${kk < digits.length ? `.${digits.slice(kk)}` : ""}`;
  }
  if (digits.length < kk && kk <= 16) return `${sign}${digits}${"0".repeat(kk - digits.length)}`;
  const sci = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${sign}${sci}E${exponent}`;
}

export function tsValueReply(proto: Proto, n: number): Reply {
  return proto === 3 ? r.double(n) : r.simple(formatTsResp2Float(n));
}

export function parseTsFloat(b: Uint8Array, error: string = TS_ERR.badValue): number {
  const s = text(b);
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) throw new RedisError(error);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new RedisError(error);
  return n;
}

export function parseIntStrict(b: Uint8Array, parseErr: string): number {
  const s = text(b);
  if (!/^-?\d+$/.test(s)) throw new RedisError(parseErr);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new RedisError(parseErr);
  return n;
}

export function parseNonNegInt(b: Uint8Array, parseErr: string, negErr: string = parseErr): number {
  const n = parseIntStrict(b, parseErr);
  if (n < 0) throw new RedisError(negErr);
  return n;
}

export function parsePosInt(b: Uint8Array, parseErr: string, nonPosErr: string = parseErr): number {
  const n = parseIntStrict(b, parseErr);
  if (n <= 0) throw new RedisError(nonPosErr);
  return n;
}

export function parseSampleTimestamp(b: Uint8Array, now: number): number {
  const s = text(b);
  if (s === "*") return now;
  return parseNonNegInt(b, TS_ERR.badTimestamp, TS_ERR.negTimestamp);
}

export interface RangeBound {
  value: number;
  explicit: boolean;
}

export function parseRangeTimestamp(b: Uint8Array, error: string): RangeBound {
  const s = text(b);
  if (s === "-") return { value: 0, explicit: false };
  if (s === "+") return { value: Number.MAX_SAFE_INTEGER, explicit: false };
  return { value: parseNonNegInt(b, error, error), explicit: true };
}

export function formatLabelsReply(proto: Proto, labels: Array<[Uint8Array, Uint8Array | null]>): Reply {
  if (proto === 3) return r.map(labels.map(([k, v]) => [r.bulk(k), r.bulk(v)]));
  return r.array(labels.map(([k, v]) => r.array([r.bulk(k), r.bulk(v)])));
}

export function formatSamplesReply(proto: Proto, samples: Array<{ ts: number; val: number }>): Reply {
  return r.array(samples.map((s) => r.array([r.int(s.ts), tsValueReply(proto, s.val)])));
}
