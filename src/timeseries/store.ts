import type { Ctx } from "../commands/types";
import { RedisError } from "../resp/reply";
import { blob, checkSize, fromBlob, sameBytes, WRONGTYPE } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { aggregateBucket, aggregateSamples, aggregatorByName, rawBucketStart } from "./aggregate";
import type { AggOpts, Aggregator, Sample } from "./aggregate";
import { TS_ERR } from "./format";

export type DupPolicy = "block" | "first" | "last" | "min" | "max" | "sum";

const DUP_MAP = new Map<string, DupPolicy>([
  ["block", "block"], ["first", "first"], ["last", "last"],
  ["min", "min"], ["max", "max"], ["sum", "sum"],
]);

export function parseDupPolicyName(s: string): DupPolicy | undefined {
  return DUP_MAP.get(s);
}

export interface TsMeta {
  uid: number;
  retention: number;
  chunkSize: number;
  initChunkSize: number;
  compressed: number;
  dupPolicy: DupPolicy;
  ignoreTime: number;
  ignoreVal: number;
}

export interface SeriesOpts {
  retention?: number;
  compressed?: boolean;
  chunkSize?: number;
  dupPolicy?: DupPolicy;
  ignoreTime?: number;
  ignoreVal?: number;
  labels?: Array<[Uint8Array, Uint8Array]>;
}

export interface LiveRule {
  id: number;
  sourceKeyId: number;
  sourceUid: number;
  sourceKey: Uint8Array;
  destKeyId: number;
  destUid: number;
  destKey: Uint8Array;
  aggregator: Aggregator;
  bucketDuration: number;
  alignTs: number;
  openBucketTs: number | null;
}

export interface SampleFilter {
  filterTs?: Set<number>;
  minVal?: number;
  maxVal?: number;
}

function randomUid(): number {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  return (buf[0] & 0x1f_ff_ff) * 2 ** 32 + buf[1];
}

function encodeSampleVal(val: number): [number | null, number] {
  if (Number.isNaN(val)) return [null, 0];
  if (Object.is(val, -0)) return [0, 1];
  return [val, 0];
}

function decodeSampleVal(value: number | null, negZero: number): number {
  if (value === null) return Number.NaN;
  return negZero ? -0 : value;
}

export function getTsKey(ctx: Ctx, key: Uint8Array, wrongTypeMsg: string = TS_ERR.wrongType): KeyRow | undefined {
  const row = ctx.ks.get(key);
  if (row && row.type !== TYPE.timeseries) throw new RedisError(wrongTypeMsg);
  return row;
}

export function requireTsKey(ctx: Ctx, key: Uint8Array): KeyRow {
  const row = getTsKey(ctx, key);
  if (!row) throw new RedisError(TS_ERR.noKey);
  return row;
}

export function getMeta(ctx: Ctx, id: number): TsMeta {
  const row = ctx.ks.sql.exec<{
    uid: number;
    retention: number;
    chunk_size: number;
    init_chunk_size: number;
    compressed: number;
    dup_policy: string;
    ignore_time: number;
    ignore_val: number;
  }>("SELECT uid, retention, chunk_size, init_chunk_size, compressed, dup_policy, ignore_time, ignore_val FROM ts_meta WHERE key_id = ?", id).one();
  return {
    uid: row.uid,
    retention: row.retention,
    chunkSize: row.chunk_size,
    initChunkSize: row.init_chunk_size,
    compressed: row.compressed,
    dupPolicy: parseDupPolicyName(row.dup_policy) ?? "block",
    ignoreTime: row.ignore_time,
    ignoreVal: row.ignore_val,
  };
}

export function getLabels(ctx: Ctx, id: number): Array<[Uint8Array, Uint8Array]> {
  return ctx.ks.sql
    .exec<{ label: ArrayBuffer; value: ArrayBuffer }>("SELECT label, value FROM ts_labels WHERE key_id = ? ORDER BY id ASC", id)
    .toArray()
    .map((r) => [fromBlob(r.label), fromBlob(r.value)]);
}

function setLabels(ctx: Ctx, key: Uint8Array, id: number, labels: Array<[Uint8Array, Uint8Array]>) {
  ctx.ks.sql.exec("DELETE FROM ts_labels WHERE key_id = ?", id);
  for (const [label, value] of labels) {
    checkSize(key, label, value);
    ctx.ks.sql.exec("INSERT INTO ts_labels (key_id, label, value) VALUES (?, ?, ?)", id, blob(label), blob(value));
  }
}

export interface CreatedSeries {
  id: number;
  meta: TsMeta;
}

export function createSeries(ctx: Ctx, key: Uint8Array, opts: SeriesOpts): CreatedSeries {
  const retention = opts.retention ?? 0;
  const chunkSize = opts.chunkSize ?? 4096;
  const compressed = opts.compressed === false ? 0 : 1;
  const dupPolicy: DupPolicy = opts.dupPolicy ?? "block";
  const ignoreTime = opts.ignoreTime ?? 0;
  const ignoreVal = opts.ignoreVal ?? 0;
  const uid = randomUid();
  const id = ctx.ks.create(key, TYPE.timeseries);
  ctx.ks.sql.exec(
    "INSERT INTO ts_meta (key_id, uid, retention, chunk_size, init_chunk_size, compressed, dup_policy, ignore_time, ignore_val) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, uid, retention, chunkSize, chunkSize, compressed, dupPolicy, ignoreTime, ignoreVal,
  );
  if (opts.labels?.length) setLabels(ctx, key, id, opts.labels);
  return {
    id,
    meta: { uid, retention, chunkSize, initChunkSize: chunkSize, compressed, dupPolicy, ignoreTime, ignoreVal },
  };
}

export function alterSeries(ctx: Ctx, key: Uint8Array, id: number, opts: SeriesOpts) {
  const meta = getMeta(ctx, id);
  const retention = opts.retention ?? meta.retention;
  const chunkSize = opts.chunkSize ?? meta.chunkSize;
  const dupPolicy = opts.dupPolicy ?? meta.dupPolicy;
  const ignoreTime = opts.ignoreTime ?? meta.ignoreTime;
  const ignoreVal = opts.ignoreVal ?? meta.ignoreVal;
  ctx.ks.sql.exec(
    "UPDATE ts_meta SET retention = ?, chunk_size = ?, dup_policy = ?, ignore_time = ?, ignore_val = ? WHERE key_id = ?",
    retention, chunkSize, dupPolicy, ignoreTime, ignoreVal, id,
  );
  if (opts.labels !== undefined) setLabels(ctx, key, id, opts.labels);
  if (retention > 0) trimRetention(ctx, id, retention);
  ctx.ks.onChange(key);
}

export function getLastRawSample(ctx: Ctx, id: number): Sample | undefined {
  const row = ctx.ks.sql
    .exec<{ timestamp: number; value: number | null; neg_zero: number }>(
      "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? ORDER BY timestamp DESC LIMIT 1",
      id,
    )
    .toArray()[0];
  return row ? { ts: row.timestamp, val: decodeSampleVal(row.value, row.neg_zero) } : undefined;
}

export function retentionCutoff(ctx: Ctx, id: number, meta: TsMeta): number {
  if (meta.retention <= 0) return 0;
  const last = getLastRawSample(ctx, id);
  if (!last || last.ts <= meta.retention) return 0;
  return last.ts - meta.retention;
}

function trimRetention(ctx: Ctx, id: number, retention: number) {
  if (retention <= 0) return;
  const last = getLastRawSample(ctx, id);
  if (!last || last.ts <= retention) return;
  ctx.ks.sql.exec("DELETE FROM ts_samples WHERE key_id = ? AND timestamp < ?", id, last.ts - retention);
}

function mapRuleRow(r: {
  id: number;
  source_key_id: number;
  source_uid: number;
  source_key: ArrayBuffer;
  dest_key_id: number;
  dest_uid: number;
  dest_key: ArrayBuffer;
  aggregator: string;
  bucket_duration: number;
  align_ts: number;
  open_bucket_ts: number | null;
}): LiveRule {
  return {
    id: r.id,
    sourceKeyId: r.source_key_id,
    sourceUid: r.source_uid,
    sourceKey: fromBlob(r.source_key),
    destKeyId: r.dest_key_id,
    destUid: r.dest_uid,
    destKey: fromBlob(r.dest_key),
    aggregator: aggregatorByName(r.aggregator),
    bucketDuration: r.bucket_duration,
    alignTs: r.align_ts,
    openBucketTs: r.open_bucket_ts,
  };
}

const RULE_SELECT = `
  SELECT r.id, r.source_key_id, r.source_uid, sk.key AS source_key,
         r.dest_key_id, r.dest_uid, dk.key AS dest_key,
         r.aggregator, r.bucket_duration, r.align_ts, r.open_bucket_ts
  FROM ts_rules r
  JOIN keys sk ON sk.id = r.source_key_id AND sk.type = ? AND (sk.expires_at IS NULL OR sk.expires_at > ?)
  JOIN ts_meta sm ON sm.key_id = r.source_key_id AND sm.uid = r.source_uid
  JOIN keys dk ON dk.id = r.dest_key_id AND dk.type = ? AND (dk.expires_at IS NULL OR dk.expires_at > ?)
  JOIN ts_meta dm ON dm.key_id = r.dest_key_id AND dm.uid = r.dest_uid
`;

export function getOutgoingRules(ctx: Ctx, id: number, uid: number): Array<LiveRule> {
  return ctx.ks.sql
    .exec<{
      id: number;
      source_key_id: number;
      source_uid: number;
      source_key: ArrayBuffer;
      dest_key_id: number;
      dest_uid: number;
      dest_key: ArrayBuffer;
      aggregator: string;
      bucket_duration: number;
      align_ts: number;
      open_bucket_ts: number | null;
    }>(`${RULE_SELECT} WHERE r.source_key_id = ? AND r.source_uid = ? ORDER BY r.id ASC`, TYPE.timeseries, ctx.now, TYPE.timeseries, ctx.now, id, uid)
    .toArray()
    .map(mapRuleRow);
}

export function getIncomingRule(ctx: Ctx, id: number, uid: number): LiveRule | undefined {
  const row = ctx.ks.sql
    .exec<{
      id: number;
      source_key_id: number;
      source_uid: number;
      source_key: ArrayBuffer;
      dest_key_id: number;
      dest_uid: number;
      dest_key: ArrayBuffer;
      aggregator: string;
      bucket_duration: number;
      align_ts: number;
      open_bucket_ts: number | null;
    }>(`${RULE_SELECT} WHERE r.dest_key_id = ? AND r.dest_uid = ? LIMIT 1`, TYPE.timeseries, ctx.now, TYPE.timeseries, ctx.now, id, uid)
    .toArray()[0];
  return row ? mapRuleRow(row) : undefined;
}

export function pruneDeadRules(ctx: Ctx) {
  ctx.ks.sql.exec(
    `DELETE FROM ts_rules WHERE NOT EXISTS (
      SELECT 1 FROM keys sk JOIN ts_meta sm ON sm.key_id = sk.id
      WHERE sk.id = ts_rules.source_key_id AND sm.uid = ts_rules.source_uid
        AND sk.type = ? AND (sk.expires_at IS NULL OR sk.expires_at > ?)
    ) OR NOT EXISTS (
      SELECT 1 FROM keys dk JOIN ts_meta dm ON dm.key_id = dk.id
      WHERE dk.id = ts_rules.dest_key_id AND dm.uid = ts_rules.dest_uid
        AND dk.type = ? AND (dk.expires_at IS NULL OR dk.expires_at > ?)
    )`,
    TYPE.timeseries, ctx.now, TYPE.timeseries, ctx.now,
  );
}

export function createRule(ctx: Ctx, srcKey: Uint8Array, dstKey: Uint8Array, agg: Aggregator, bucketDuration: number, alignTs: number) {
  if (sameBytes(srcKey, dstKey)) throw new RedisError(TS_ERR.sameRuleKeys);
  const srcRow = requireTsKey(ctx, srcKey);
  const dstRow = requireTsKey(ctx, dstKey);
  const srcMeta = getMeta(ctx, srcRow.id);
  const dstMeta = getMeta(ctx, dstRow.id);
  pruneDeadRules(ctx);
  if (getIncomingRule(ctx, dstRow.id, dstMeta.uid)) throw new RedisError(TS_ERR.destHasRule);
  if (getIncomingRule(ctx, srcRow.id, srcMeta.uid)) throw new RedisError(TS_ERR.srcHasRule);
  ctx.ks.sql.exec(
    "INSERT INTO ts_rules (source_key_id, source_uid, dest_key_id, dest_uid, aggregator, bucket_duration, align_ts, open_bucket_ts) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    srcRow.id, srcMeta.uid, dstRow.id, dstMeta.uid, agg, bucketDuration, alignTs,
  );
  ctx.ks.onChange(srcKey);
  ctx.ks.onChange(dstKey);
}

export function deleteRule(ctx: Ctx, srcKey: Uint8Array, dstKey: Uint8Array) {
  const srcRow = requireTsKey(ctx, srcKey);
  const dstRow = requireTsKey(ctx, dstKey);
  const srcMeta = getMeta(ctx, srcRow.id);
  const dstMeta = getMeta(ctx, dstRow.id);
  const res = ctx.ks.sql
    .exec(
      "DELETE FROM ts_rules WHERE source_key_id = ? AND source_uid = ? AND dest_key_id = ? AND dest_uid = ? RETURNING id",
      srcRow.id, srcMeta.uid, dstRow.id, dstMeta.uid,
    )
    .toArray();
  if (!res.length) throw new RedisError(TS_ERR.noRule);
  ctx.ks.onChange(srcKey);
  ctx.ks.onChange(dstKey);
}

function loadRawSamples(ctx: Ctx, id: number, minTs: number, maxTs: number): Array<Sample> {
  return ctx.ks.sql
    .exec<{ timestamp: number; value: number | null; neg_zero: number }>(
      "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
      id, minTs, maxTs,
    )
    .toArray()
    .map((r) => ({ ts: r.timestamp, val: decodeSampleVal(r.value, r.neg_zero) }));
}

function neighborValid(ctx: Ctx, id: number, cutoff: number, ts: number, before: boolean): Sample | undefined {
  const sql = before
    ? "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp >= ? AND timestamp < ? AND value IS NOT NULL ORDER BY timestamp DESC LIMIT 1"
    : "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp >= ? AND timestamp > ? AND value IS NOT NULL ORDER BY timestamp ASC LIMIT 1";
  const row = ctx.ks.sql.exec<{ timestamp: number; value: number; neg_zero: number }>(sql, id, cutoff, ts).toArray()[0];
  return row ? { ts: row.timestamp, val: decodeSampleVal(row.value, row.neg_zero) } : undefined;
}

function computeRuleBucket(ctx: Ctx, rule: LiveRule, bucketTs: number): number | undefined {
  const srcMeta = getMeta(ctx, rule.sourceKeyId);
  const cutoff = retentionCutoff(ctx, rule.sourceKeyId, srcMeta);
  const raw = rawBucketStart(bucketTs, rule.alignTs, rule.bucketDuration);
  const bStart = Math.max(0, raw);
  const bEnd = raw + rule.bucketDuration;
  const queryStart = Math.max(bStart, cutoff);
  const samples = queryStart < bEnd ? loadRawSamples(ctx, rule.sourceKeyId, queryStart, bEnd - 1) : [];
  if (!samples.length) return undefined;
  let prev: Sample | undefined;
  let next: Sample | undefined;
  if (rule.aggregator === "twa") {
    prev = neighborValid(ctx, rule.sourceKeyId, cutoff, bStart, true);
    next = neighborValid(ctx, rule.sourceKeyId, cutoff, bEnd - 1, false);
  }
  return aggregateBucket(rule.aggregator, samples, bStart, bEnd, prev, next);
}

function upsertDestBucket(ctx: Ctx, rule: LiveRule, bucketTs: number, val: number | undefined) {
  const dstMeta = getMeta(ctx, rule.destKeyId);
  if (val === undefined) {
    const deleted = ctx.ks.sql
      .exec("DELETE FROM ts_samples WHERE key_id = ? AND timestamp = ? RETURNING timestamp", rule.destKeyId, bucketTs)
      .toArray();
    if (deleted.length) ctx.ks.onChange(rule.destKey);
    return;
  }
  const cutoff = retentionCutoff(ctx, rule.destKeyId, dstMeta);
  if (dstMeta.retention > 0 && bucketTs < cutoff) return;
  const [dbVal, negZero] = encodeSampleVal(val);
  ctx.ks.sql.exec(
    "INSERT INTO ts_samples (key_id, timestamp, value, neg_zero) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, timestamp) DO UPDATE SET value = excluded.value, neg_zero = excluded.neg_zero",
    rule.destKeyId, bucketTs, dbVal, negZero,
  );
  trimRetention(ctx, rule.destKeyId, dstMeta.retention);
  ctx.ks.onChange(rule.destKey);
}

function applyCompactionOnWrite(ctx: Ctx, srcId: number, srcUid: number, ts: number) {
  const rules = getOutgoingRules(ctx, srcId, srcUid);
  for (const rule of rules) {
    const b = Math.max(0, rawBucketStart(ts, rule.alignTs, rule.bucketDuration));
    if (rule.openBucketTs === null) {
      ctx.ks.sql.exec("UPDATE ts_rules SET open_bucket_ts = ? WHERE id = ?", b, rule.id);
      continue;
    }
    if (b > rule.openBucketTs) {
      upsertDestBucket(ctx, rule, rule.openBucketTs, computeRuleBucket(ctx, rule, rule.openBucketTs));
      ctx.ks.sql.exec("UPDATE ts_rules SET open_bucket_ts = ? WHERE id = ?", b, rule.id);
      continue;
    }
    if (b < rule.openBucketTs) {
      upsertDestBucket(ctx, rule, b, computeRuleBucket(ctx, rule, b));
    }
  }
}

function resolveDuplicate(policy: DupPolicy, existingVal: number, newVal: number): number {
  switch (policy) {
    case "block":
      throw new RedisError(TS_ERR.upsertBlocked);
    case "first":
      return existingVal;
    case "last":
      if (Number.isNaN(newVal) && !Number.isNaN(existingVal)) return existingVal;
      return newVal;
    case "min":
      if (Number.isNaN(existingVal) || Number.isNaN(newVal)) throw new RedisError(TS_ERR.upsertBlocked);
      return Math.min(existingVal, newVal);
    case "max":
      if (Number.isNaN(existingVal) || Number.isNaN(newVal)) throw new RedisError(TS_ERR.upsertBlocked);
      return Math.max(existingVal, newVal);
    case "sum":
      if (Number.isNaN(existingVal) || Number.isNaN(newVal)) throw new RedisError(TS_ERR.upsertBlocked);
      return existingVal + newVal;
  }
}

export function addSample(
  ctx: Ctx,
  key: Uint8Array,
  ts: number,
  val: number,
  createOpts: SeriesOpts,
  onDuplicate?: DupPolicy,
): number {
  const row = getTsKey(ctx, key);
  const { id, meta } = row ? { id: row.id, meta: getMeta(ctx, row.id) } : createSeries(ctx, key, createOpts);
  const last = getLastRawSample(ctx, id);
  if (meta.retention > 0 && last && ts < last.ts - meta.retention) throw new RedisError(TS_ERR.oldTimestamp);
  const policy = onDuplicate ?? meta.dupPolicy;
  if (
    policy === "last" &&
    last &&
    ts >= last.ts &&
    (meta.ignoreTime > 0 || meta.ignoreVal > 0) &&
    ts - last.ts <= meta.ignoreTime &&
    !Number.isNaN(val) &&
    !Number.isNaN(last.val) &&
    Math.abs(val - last.val) <= meta.ignoreVal
  ) {
    return last.ts;
  }
  const existingRow = ctx.ks.sql
    .exec<{ value: number | null; neg_zero: number }>("SELECT value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp = ?", id, ts)
    .toArray()[0];
  let nextVal = val;
  if (existingRow) {
    const existingVal = decodeSampleVal(existingRow.value, existingRow.neg_zero);
    nextVal = resolveDuplicate(policy, existingVal, val);
    if (policy === "first" || (Object.is(nextVal, existingVal) && !(Number.isNaN(nextVal) && Number.isNaN(existingVal)))) {
      return ts;
    }
  }
  const [dbVal, negZero] = encodeSampleVal(nextVal);
  ctx.ks.sql.exec(
    "INSERT INTO ts_samples (key_id, timestamp, value, neg_zero) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, timestamp) DO UPDATE SET value = excluded.value, neg_zero = excluded.neg_zero",
    id, ts, dbVal, negZero,
  );
  trimRetention(ctx, id, meta.retention);
  ctx.ks.onChange(key);
  applyCompactionOnWrite(ctx, id, meta.uid, ts);
  return ts;
}

export function incrSample(ctx: Ctx, key: Uint8Array, delta: number, ts: number, createOpts: SeriesOpts): number {
  const row = getTsKey(ctx, key);
  const { id, meta } = row ? { id: row.id, meta: getMeta(ctx, row.id) } : createSeries(ctx, key, createOpts);
  const last = getLastRawSample(ctx, id);
  if (last && ts < last.ts) throw new RedisError(TS_ERR.incrOldTs);
  const base = last ? last.val : 0;
  if (Number.isNaN(base)) throw new RedisError(TS_ERR.incrNan);
  const nextVal = base + delta;
  if (!Number.isFinite(nextVal)) throw new RedisError(TS_ERR.badValue);
  const [dbVal, negZero] = encodeSampleVal(nextVal);
  ctx.ks.sql.exec(
    "INSERT INTO ts_samples (key_id, timestamp, value, neg_zero) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, timestamp) DO UPDATE SET value = excluded.value, neg_zero = excluded.neg_zero",
    id, ts, dbVal, negZero,
  );
  trimRetention(ctx, id, meta.retention);
  ctx.ks.onChange(key);
  applyCompactionOnWrite(ctx, id, meta.uid, ts);
  return ts;
}

export function deleteSamples(ctx: Ctx, key: Uint8Array, id: number, from: number, to: number): number {
  if (from > to) return 0;
  const meta = getMeta(ctx, id);
  const cutoff = retentionCutoff(ctx, id, meta);
  const start = Math.max(from, cutoff);
  if (start > to) return 0;
  const deleted = ctx.ks.sql
    .exec<{ timestamp: number }>("DELETE FROM ts_samples WHERE key_id = ? AND timestamp >= ? AND timestamp <= ? RETURNING timestamp", id, start, to)
    .toArray();
  if (!deleted.length) return 0;
  ctx.ks.onChange(key);
  const rules = getOutgoingRules(ctx, id, meta.uid);
  for (const rule of rules) {
    if (rule.openBucketTs === null) continue;
    const closedBuckets = new Set<number>();
    for (const d of deleted) {
      const b = Math.max(0, rawBucketStart(d.timestamp, rule.alignTs, rule.bucketDuration));
      if (b < rule.openBucketTs) closedBuckets.add(b);
    }
    for (const b of closedBuckets) upsertDestBucket(ctx, rule, b, computeRuleBucket(ctx, rule, b));
  }
  return deleted.length;
}

function getLatestOpenSample(ctx: Ctx, id: number, meta: TsMeta): Sample | undefined {
  const rule = getIncomingRule(ctx, id, meta.uid);
  if (!rule || rule.openBucketTs === null) return undefined;
  const cutoff = retentionCutoff(ctx, id, meta);
  if (meta.retention > 0 && rule.openBucketTs < cutoff) return undefined;
  const val = computeRuleBucket(ctx, rule, rule.openBucketTs);
  if (val === undefined) return undefined;
  return { ts: rule.openBucketTs, val };
}

export function getLatestSample(ctx: Ctx, id: number, latest: boolean): Sample | undefined {
  const meta = getMeta(ctx, id);
  const last = getLastRawSample(ctx, id);
  if (!latest) return last;
  const open = getLatestOpenSample(ctx, id, meta);
  if (!open) return last;
  if (!last || open.ts >= last.ts) return open;
  return last;
}

export function querySeriesSamples(
  ctx: Ctx,
  id: number,
  from: number,
  to: number,
  latest: boolean,
  filter: SampleFilter,
  aggOpts?: AggOpts,
): Array<Sample> {
  if (from > to) return [];
  const meta = getMeta(ctx, id);
  const cutoff = retentionCutoff(ctx, id, meta);
  const start = Math.max(from, cutoff);
  if (start > to) return [];
  let samples = loadRawSamples(ctx, id, start, to);
  if (latest) {
    const open = getLatestOpenSample(ctx, id, meta);
    if (open && open.ts >= start && open.ts <= to) {
      const idx = samples.findIndex((s) => s.ts === open.ts);
      if (idx !== -1) samples[idx] = open;
      else {
        samples.push(open);
        samples.sort((a, b) => a.ts - b.ts);
      }
    }
  }
  if (filter.filterTs) {
    const allowed = filter.filterTs;
    samples = samples.filter((s) => allowed.has(s.ts));
  }
  if (filter.minVal !== undefined && filter.maxVal !== undefined) {
    const { minVal, maxVal } = filter;
    samples = samples.filter((s) => !Number.isNaN(s.val) && s.val >= minVal && s.val <= maxVal);
  }
  if (!aggOpts) return samples;
  let twaPool: Array<Sample> = [];
  if (aggOpts.agg === "twa") {
    const prev = neighborValid(ctx, id, cutoff, start, true);
    const next = neighborValid(ctx, id, cutoff, to, false);
    twaPool = [...(prev ? [prev] : []), ...samples, ...(next ? [next] : [])];
  }
  return aggregateSamples(samples, twaPool, aggOpts);
}

export function readSince(ctx: Ctx, id: number, minTs: number, maxCount?: number): Array<Sample> {
  const meta = getMeta(ctx, id);
  const cutoff = retentionCutoff(ctx, id, meta);
  const start = Math.max(minTs, cutoff);
  const sql =
    maxCount !== undefined
      ? "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT ?"
      : "SELECT timestamp, value, neg_zero FROM ts_samples WHERE key_id = ? AND timestamp >= ? ORDER BY timestamp ASC";
  const rows =
    maxCount !== undefined
      ? ctx.ks.sql.exec<{ timestamp: number; value: number | null; neg_zero: number }>(sql, id, start, maxCount).toArray()
      : ctx.ks.sql.exec<{ timestamp: number; value: number | null; neg_zero: number }>(sql, id, start).toArray();
  return rows.map((r) => ({ ts: r.timestamp, val: decodeSampleVal(r.value, r.neg_zero) }));
}

export interface SeriesStats {
  totalSamples: number;
  firstTs: number;
  lastTs: number;
}

export function getSeriesStats(ctx: Ctx, id: number, meta: TsMeta): SeriesStats {
  const cutoff = retentionCutoff(ctx, id, meta);
  const totalSamples = ctx.ks.sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM ts_samples WHERE key_id = ? AND timestamp >= ?", id, cutoff)
    .one().n;
  if (!totalSamples) return { totalSamples: 0, firstTs: 0, lastTs: 0 };
  const firstRow = ctx.ks.sql
    .exec<{ timestamp: number }>("SELECT timestamp FROM ts_samples WHERE key_id = ? AND timestamp >= ? ORDER BY timestamp ASC LIMIT 1", id, cutoff)
    .one();
  const lastRow = ctx.ks.sql
    .exec<{ timestamp: number }>("SELECT timestamp FROM ts_samples WHERE key_id = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 1", id, cutoff)
    .one();
  return { totalSamples, firstTs: firstRow.timestamp, lastTs: lastRow.timestamp };
}

export function getDistinctLabelNames(ctx: Ctx, keyIds?: Array<number>): Array<Uint8Array> {
  const now = ctx.now;
  if (keyIds !== undefined) {
    if (!keyIds.length) return [];
    const ph = keyIds.map(() => "?").join(", ");
    return ctx.ks.sql
      .exec<{ label: ArrayBuffer }>(`SELECT DISTINCT label FROM ts_labels WHERE key_id IN (${ph}) ORDER BY label ASC`, ...keyIds)
      .toArray()
      .map((r) => fromBlob(r.label));
  }
  return ctx.ks.sql
    .exec<{ label: ArrayBuffer }>(
      "SELECT DISTINCT tl.label FROM ts_labels tl JOIN keys k ON k.id = tl.key_id WHERE k.type = ? AND (k.expires_at IS NULL OR k.expires_at > ?) ORDER BY tl.label ASC",
      TYPE.timeseries, now,
    )
    .toArray()
    .map((r) => fromBlob(r.label));
}

export function getDistinctLabelValues(ctx: Ctx, label: Uint8Array, keyIds?: Array<number>): Array<Uint8Array> {
  const now = ctx.now;
  if (keyIds !== undefined) {
    if (!keyIds.length) return [];
    const ph = keyIds.map(() => "?").join(", ");
    return ctx.ks.sql
      .exec<{ value: ArrayBuffer }>(`SELECT DISTINCT value FROM ts_labels WHERE label = ? AND key_id IN (${ph}) ORDER BY value ASC`, blob(label), ...keyIds)
      .toArray()
      .map((r) => fromBlob(r.value));
  }
  return ctx.ks.sql
    .exec<{ value: ArrayBuffer }>(
      "SELECT DISTINCT tl.value FROM ts_labels tl JOIN keys k ON k.id = tl.key_id WHERE tl.label = ? AND k.type = ? AND (k.expires_at IS NULL OR k.expires_at > ?) ORDER BY tl.value ASC",
      blob(label), TYPE.timeseries, now,
    )
    .toArray()
    .map((r) => fromBlob(r.value));
}

export { WRONGTYPE };
