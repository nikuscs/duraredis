import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { parseAggregator, parseReducer, reduceValues } from "../timeseries/aggregate";
import type { AggOpts, Aggregator, BucketTimestampMode, Sample } from "../timeseries/aggregate";
import { matchSeries, parseFilters } from "../timeseries/filter";
import {
  formatLabelsReply,
  formatSamplesReply,
  parseIntStrict,
  parseNonNegInt,
  parsePosInt,
  parseRangeTimestamp,
  parseSampleTimestamp,
  parseTsFloat,
  TS_ERR,
  tsValueReply,
} from "../timeseries/format";
import type { RangeBound } from "../timeseries/format";
import {
  addSample,
  alterSeries,
  createRule,
  createSeries,
  deleteRule,
  deleteSamples,
  getDistinctLabelNames,
  getDistinctLabelValues,
  getIncomingRule,
  getLabels,
  getLastRawSample,
  getLatestSample,
  getMeta,
  getOutgoingRules,
  getSeriesStats,
  getTsKey,
  incrSample,
  parseDupPolicyName,
  querySeriesSamples,
  readSince,
  requireTsKey,
  WRONGTYPE,
} from "../timeseries/store";
import type { DupPolicy, SampleFilter, SeriesOpts } from "../timeseries/store";
import { ERR, opt } from "./args";
import { block } from "./blocking";
import { keyless, spec } from "./types";
import type { Ctx, Outcome, Table } from "./types";

const RANGE_STOP_TOKENS = new Set([
  "LATEST", "FILTER_BY_TS", "FILTER_BY_VALUE", "COUNT", "ALIGN", "AGGREGATION",
  "BUCKETTIMESTAMP", "EMPTY", "WITHLABELS", "SELECTED_LABELS", "EXCLUDEEMPTY", "FILTER", "GROUPBY",
]);

function parseDupPolicy(b: Uint8Array): DupPolicy {
  const found = parseDupPolicyName(opt(b).toLowerCase());
  if (!found) throw new RedisError(TS_ERR.badDupPolicy);
  return found;
}

interface ParsedSeriesArgs {
  opts: SeriesOpts;
  onDuplicate?: DupPolicy;
  timestamp?: number;
}

function parseSeriesArgs(
  args: Array<Uint8Array>,
  start: number,
  now: number,
  flags: { encoding?: boolean; onDuplicate?: boolean; timestamp?: boolean },
): ParsedSeriesArgs {
  const opts: SeriesOpts = {};
  let onDuplicate: DupPolicy | undefined;
  let timestamp: number | undefined;
  let i = start;
  while (i < args.length) {
    const tok = opt(args[i]);
    if (tok === "RETENTION") {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badRetention);
      opts.retention = parseNonNegInt(args[i + 1], TS_ERR.badRetention);
      i += 2;
    } else if (tok === "ENCODING" && flags.encoding) {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badEncoding);
      const enc = opt(args[i + 1]);
      if (enc === "COMPRESSED") opts.compressed = true;
      else if (enc === "UNCOMPRESSED") opts.compressed = false;
      else throw new RedisError(TS_ERR.badEncoding);
      i += 2;
    } else if ((tok === "COMPRESSED" || tok === "UNCOMPRESSED") && flags.encoding) {
      opts.compressed = tok === "COMPRESSED";
      i += 1;
    } else if (tok === "CHUNK_SIZE") {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badChunkSize);
      const n = parseIntStrict(args[i + 1], TS_ERR.badChunkSize);
      if (n < 48 || n > 1_048_576 || n % 8 !== 0) throw new RedisError(TS_ERR.badChunkSize);
      opts.chunkSize = n;
      i += 2;
    } else if (tok === "DUPLICATE_POLICY") {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badDupPolicy);
      opts.dupPolicy = parseDupPolicy(args[i + 1]);
      i += 2;
    } else if (tok === "ON_DUPLICATE" && flags.onDuplicate) {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badDupPolicy);
      onDuplicate = parseDupPolicy(args[i + 1]);
      i += 2;
    } else if (tok === "TIMESTAMP" && flags.timestamp) {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badTimestamp);
      timestamp = parseSampleTimestamp(args[i + 1], now);
      i += 2;
    } else if (tok === "IGNORE") {
      if (i + 2 >= args.length) throw new RedisError(TS_ERR.badIgnoreParse);
      const t = parseIntStrict(args[i + 1], TS_ERR.badIgnoreParse);
      const v = parseTsFloat(args[i + 2], TS_ERR.badIgnoreParse);
      if (Number.isNaN(v)) throw new RedisError(TS_ERR.badIgnoreParse);
      if (t < 0 || v < 0) throw new RedisError(TS_ERR.badIgnoreNeg);
      opts.ignoreTime = t;
      opts.ignoreVal = v;
      i += 3;
    } else if (tok === "LABELS") {
      const labels: Array<[Uint8Array, Uint8Array]> = [];
      for (let j = i + 1; j + 1 < args.length; j += 2) {
        if (!args[j].length || !args[j + 1].length) throw new RedisError(TS_ERR.badLabels);
        labels.push([args[j], args[j + 1]]);
      }
      opts.labels = labels;
      break;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  return { opts, onDuplicate, timestamp };
}

function tsCreate(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const { opts } = parseSeriesArgs(args, 2, ctx.now, { encoding: true });
  if (ctx.ks.exists(key)) throw new RedisError(TS_ERR.keyExists);
  createSeries(ctx, key, opts);
  return r.ok;
}

function tsAlter(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const { opts } = parseSeriesArgs(args, 2, ctx.now, {});
  const row = requireTsKey(ctx, key);
  alterSeries(ctx, key, row.id, opts);
  return r.ok;
}

function tsAdd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const ts = parseSampleTimestamp(args[2], ctx.now);
  const val = parseTsFloat(args[3]);
  const { opts, onDuplicate } = parseSeriesArgs(args, 4, ctx.now, { encoding: true, onDuplicate: true });
  return r.int(addSample(ctx, key, ts, val, opts, onDuplicate));
}

function tsMadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if ((args.length - 1) % 3 !== 0) throw new RedisError("ERR wrong number of arguments for 'ts.madd' command");
  const out: Array<Reply> = [];
  for (let i = 1; i < args.length; i += 3) {
    const key = args[i];
    try {
      const row = ctx.ks.get(key);
      if (!row || row.type !== TYPE.timeseries) throw new RedisError(TS_ERR.notTsKey);
      const ts = parseSampleTimestamp(args[i + 1], ctx.now);
      const val = parseTsFloat(args[i + 2]);
      out.push(r.int(addSample(ctx, key, ts, val, {})));
    } catch (error) {
      if (error instanceof RedisError) out.push(r.error(error.message));
      else throw error;
    }
  }
  return r.array(out);
}

function tsIncrDecr(ctx: Ctx, args: Array<Uint8Array>, sign: 1 | -1): Reply {
  const key = args[1];
  const delta = parseTsFloat(args[2]) * sign;
  const { opts, timestamp } = parseSeriesArgs(args, 3, ctx.now, { encoding: true, timestamp: true });
  const ts = timestamp ?? ctx.now;
  return r.int(incrSample(ctx, key, delta, ts, opts));
}

function tsDel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = requireTsKey(ctx, args[1]);
  const from = parseRangeTimestamp(args[2], TS_ERR.badFromTs).value;
  const to = parseRangeTimestamp(args[3], TS_ERR.badToTs).value;
  return r.int(deleteSamples(ctx, args[1], row.id, from, to));
}

function tsGet(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) throw new RedisError("ERR wrong number of arguments for 'ts.get' command");
  let latest = false;
  if (args.length === 3) {
    if (opt(args[2]) !== "LATEST") throw new RedisError(ERR.syntax);
    latest = true;
  }
  const row = requireTsKey(ctx, args[1]);
  const sample = getLatestSample(ctx, row.id, latest);
  if (!sample) return r.array([]);
  return r.array([r.int(sample.ts), tsValueReply(ctx.session.proto, sample.val)]);
}

function selectLabels(
  seriesLabels: Array<[Uint8Array, Uint8Array]>,
  withLabels: boolean,
  selected: Array<Uint8Array> | undefined,
): Array<[Uint8Array, Uint8Array | null]> {
  if (withLabels) return seriesLabels;
  if (!selected) return [];
  const map = new Map<string, Uint8Array>();
  for (const [k, v] of seriesLabels) {
    const ks = text(k);
    if (!map.has(ks)) map.set(ks, v);
  }
  return selected.map((name) => [name, map.get(text(name)) ?? null]);
}

function tsMget(ctx: Ctx, args: Array<Uint8Array>): Reply {
  let latest = false;
  let withLabels = false;
  let selectedLabels: Array<Uint8Array> | undefined;
  let filterArgs: Array<Uint8Array> | undefined;
  let i = 1;
  while (i < args.length) {
    const tok = opt(args[i]);
    if (tok === "LATEST") {
      latest = true;
      i += 1;
    } else if (tok === "WITHLABELS") {
      withLabels = true;
      i += 1;
    } else if (tok === "SELECTED_LABELS") {
      selectedLabels = [];
      i += 1;
      while (i < args.length && !["FILTER", "WITHLABELS", "LATEST"].includes(opt(args[i]))) {
        selectedLabels.push(args[i++]);
      }
    } else if (tok === "FILTER") {
      filterArgs = args.slice(i + 1);
      break;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  if (withLabels && selectedLabels) throw new RedisError(TS_ERR.withAndSelected);
  if (!filterArgs) throw new RedisError("ERR wrong number of arguments for 'ts.mget' command");
  const series = matchSeries(ctx, parseFilters(filterArgs));
  const proto = ctx.session.proto;
  if (proto === 3) {
    const entries: Array<[Reply, Reply]> = series.map((s) => {
      const lbls = formatLabelsReply(proto, selectLabels(getLabels(ctx, s.id), withLabels, selectedLabels));
      const sample = getLatestSample(ctx, s.id, latest);
      const sampleReply = sample ? r.array([r.int(sample.ts), tsValueReply(proto, sample.val)]) : r.array([]);
      return [r.bulk(s.key), r.array([lbls, sampleReply])];
    });
    return r.map(entries);
  }
  return r.array(
    series.map((s) => {
      const lbls = formatLabelsReply(proto, selectLabels(getLabels(ctx, s.id), withLabels, selectedLabels));
      const sample = getLatestSample(ctx, s.id, latest);
      const sampleReply = sample ? r.array([r.int(sample.ts), tsValueReply(proto, sample.val)]) : r.array([]);
      return r.array([r.bulk(s.key), lbls, sampleReply]);
    }),
  );
}

interface ParsedRangeOpts {
  latest: boolean;
  filter: SampleFilter;
  count?: number;
  aggs: Array<Aggregator>;
  aggOpts?: Omit<AggOpts, "agg">;
  withLabels: boolean;
  selectedLabels?: Array<Uint8Array>;
  excludeEmpty: boolean;
  filterArgs?: Array<Uint8Array>;
  groupLabel?: Uint8Array;
  reducer?: Aggregator;
}

function parseBucketTimestamp(b: Uint8Array): BucketTimestampMode {
  const s = text(b).toLowerCase();
  if (s === "-" || s === "start") return "start";
  if (s === "+" || s === "end") return "end";
  if (s === "~" || s === "mid") return "mid";
  throw new RedisError(TS_ERR.badAggParse);
}

function parseRangeOpts(
  args: Array<Uint8Array>,
  start: number,
  from: RangeBound,
  to: RangeBound,
  multi: boolean,
  aggCount: number,
  nrange = false,
): ParsedRangeOpts {
  let latest = false;
  const filter: SampleFilter = {};
  let count: number | undefined;
  let alignTok: Uint8Array | undefined;
  let aggs: Array<Aggregator> = [];
  let bucketDuration: number | undefined;
  let bucketTs: BucketTimestampMode | undefined;
  let empty = false;
  let withLabels = false;
  let selectedLabels: Array<Uint8Array> | undefined;
  let excludeEmpty = false;
  let filterArgs: Array<Uint8Array> | undefined;
  let groupLabel: Uint8Array | undefined;
  let reducer: Aggregator | undefined;

  let i = start;
  while (i < args.length) {
    const tok = opt(args[i]);
    if (tok === "LATEST") {
      latest = true;
      i += 1;
    } else if (tok === "FILTER_BY_TS") {
      const set = new Set<number>();
      i += 1;
      while (i < args.length && !RANGE_STOP_TOKENS.has(opt(args[i]))) {
        set.add(parseNonNegInt(args[i++], TS_ERR.badTimestamp, TS_ERR.negTimestamp));
      }
      filter.filterTs = set;
    } else if (tok === "FILTER_BY_VALUE") {
      if (i + 2 >= args.length) throw new RedisError(ERR.syntax);
      filter.minVal = parseTsFloat(args[i + 1]);
      filter.maxVal = parseTsFloat(args[i + 2]);
      i += 3;
    } else if (tok === "COUNT") {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badCount);
      count = parsePosInt(args[i + 1], TS_ERR.badCount);
      i += 2;
    } else if (tok === "ALIGN") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      alignTok = args[i + 1];
      i += 2;
    } else if (tok === "AGGREGATION") {
      if (!nrange) {
        if (i + 2 >= args.length) throw new RedisError(TS_ERR.badAggParse);
        aggs = [parseAggregator(args[i + 1])];
        bucketDuration = parsePosInt(args[i + 2], TS_ERR.badBucketDuration);
        i += 3;
      } else {
        i += 1;
        const aggTokens: Array<Uint8Array> = [];
        while (i < args.length && !RANGE_STOP_TOKENS.has(opt(args[i]))) aggTokens.push(args[i++]);
        const durTok = aggTokens.pop();
        if (!durTok || aggTokens.length < aggCount) throw new RedisError(TS_ERR.nrangeAggCount);
        if (aggTokens.length > aggCount) throw new RedisError(TS_ERR.badAggParse);
        aggs = aggTokens.map((t) => parseAggregator(t));
        bucketDuration = parsePosInt(durTok, TS_ERR.badBucketDuration);
      }
    } else if (tok === "BUCKETTIMESTAMP") {
      if (i + 1 >= args.length) throw new RedisError(TS_ERR.badAggParse);
      bucketTs = parseBucketTimestamp(args[i + 1]);
      i += 2;
    } else if (tok === "EMPTY") {
      empty = true;
      i += 1;
    } else if (multi && tok === "WITHLABELS") {
      withLabels = true;
      i += 1;
    } else if (multi && tok === "SELECTED_LABELS") {
      selectedLabels = [];
      i += 1;
      while (i < args.length && !RANGE_STOP_TOKENS.has(opt(args[i]))) selectedLabels.push(args[i++]);
    } else if (multi && tok === "EXCLUDEEMPTY") {
      excludeEmpty = true;
      i += 1;
    } else if (multi && tok === "FILTER") {
      i += 1;
      filterArgs = [];
      while (i < args.length && opt(args[i]) !== "GROUPBY") filterArgs.push(args[i++]);
    } else if (multi && tok === "GROUPBY") {
      if (i + 3 >= args.length || opt(args[i + 2]) !== "REDUCE") throw new RedisError(ERR.syntax);
      groupLabel = args[i + 1];
      reducer = parseReducer(args[i + 3]);
      i += 4;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }

  if (alignTok !== undefined && bucketDuration === undefined) throw new RedisError(TS_ERR.alignNeedsAgg);
  if ((bucketTs !== undefined || empty) && bucketDuration === undefined) throw new RedisError(TS_ERR.badAggParse);
  if (withLabels && selectedLabels) throw new RedisError(TS_ERR.withAndSelected);
  if (excludeEmpty && groupLabel !== undefined) throw new RedisError(TS_ERR.excludeWithGroupby);

  let align = 0;
  if (alignTok !== undefined) {
    const s = text(alignTok).toLowerCase();
    if (s === "-" || s === "start") {
      if (!from.explicit) throw new RedisError(TS_ERR.alignStartExplicit);
      align = from.value;
    } else if (s === "+" || s === "end") {
      if (!to.explicit) throw new RedisError(TS_ERR.alignEndExplicit);
      align = to.value;
    } else {
      align = parseNonNegInt(alignTok, TS_ERR.badTimestamp, TS_ERR.negTimestamp);
    }
  }

  const defaultBt: BucketTimestampMode = "start";
  const aggOpts =
    bucketDuration !== undefined
      ? { bucketDuration, align, bucketTs: bucketTs ?? defaultBt, empty }
      : undefined;

  return { latest, filter, count, aggs, aggOpts, withLabels, selectedLabels, excludeEmpty, filterArgs, groupLabel, reducer };
}

function finalizeSamples(samples: Array<Sample>, rev: boolean, count?: number): Array<Sample> {
  const ordered = rev ? samples.toReversed() : samples;
  return count !== undefined ? ordered.slice(0, count) : ordered;
}

function tsRangeCmd(ctx: Ctx, args: Array<Uint8Array>, rev: boolean): Reply {
  const from = parseRangeTimestamp(args[2], TS_ERR.badFromTs);
  const to = parseRangeTimestamp(args[3], TS_ERR.badToTs);
  const opts = parseRangeOpts(args, 4, from, to, false, 1);
  const row = requireTsKey(ctx, args[1]);
  const aggOpts: AggOpts | undefined = opts.aggOpts ? { ...opts.aggOpts, agg: opts.aggs[0] } : undefined;
  const samples = finalizeSamples(querySeriesSamples(ctx, row.id, from.value, to.value, opts.latest, opts.filter, aggOpts), rev, opts.count);
  return formatSamplesReply(ctx.session.proto, samples);
}

function groupLabelsReply(
  proto: 2 | 3,
  groupLabel: Uint8Array,
  groupVal: Uint8Array,
  reducer: Aggregator,
  sourceKeys: Array<Uint8Array>,
  withLabels: boolean,
  selected: Array<Uint8Array> | undefined,
): Reply {
  if (withLabels) {
    if (proto === 3) return formatLabelsReply(proto, [[groupLabel, groupVal]]);
    return formatLabelsReply(proto, [
      [groupLabel, groupVal],
      [bytes("__reducer__"), bytes(reducer)],
      [bytes("__source__"), bytes(sourceKeys.map(text).join(","))],
    ]);
  }
  if (!selected) return formatLabelsReply(proto, []);
  const map = new Map<string, Uint8Array>([
    [text(groupLabel), groupVal],
    ["__reducer__", bytes(reducer)],
    ["__source__", bytes(sourceKeys.map(text).join(","))],
  ]);
  return formatLabelsReply(proto, selected.map((name) => [name, map.get(text(name)) ?? null]));
}

function tsMrangeGroupBy(
  ctx: Ctx,
  series: Array<{ id: number; key: Uint8Array }>,
  from: number,
  to: number,
  opts: ParsedRangeOpts,
  rev: boolean,
): Reply {
  const proto = ctx.session.proto;
  const groupLabel = opts.groupLabel ?? bytes("");
  const groupLabelStr = text(groupLabel);
  const reducer = opts.reducer ?? "avg";
  const aggOpts: AggOpts | undefined = opts.aggOpts ? { ...opts.aggOpts, agg: opts.aggs[0] } : undefined;

  const groups = new Map<string, { val: Uint8Array; keys: Array<Uint8Array>; buckets: Map<number, Array<number>> }>();
  for (const s of series) {
    const labels = getLabels(ctx, s.id);
    const matched = labels.find(([k]) => text(k) === groupLabelStr);
    if (!matched) continue;
    const gValStr = text(matched[1]);
    let grp = groups.get(gValStr);
    if (!grp) {
      grp = { val: matched[1], keys: [], buckets: new Map() };
      groups.set(gValStr, grp);
    }
    grp.keys.push(s.key);
    for (const sample of querySeriesSamples(ctx, s.id, from, to, opts.latest, opts.filter, aggOpts)) {
      const list = grp.buckets.get(sample.ts);
      if (list) list.push(sample.val);
      else grp.buckets.set(sample.ts, [sample.val]);
    }
  }

  const orderedGroups = [...groups.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const mapEntries: Array<[Reply, Reply]> = [];
  const arrayEntries: Array<Reply> = [];
  for (const [valStr, grp] of orderedGroups) {
    const timestamps = [...grp.buckets.keys()].toSorted((a, b) => (rev ? b - a : a - b));
    const samples: Array<Sample> = [];
    for (const ts of timestamps) {
      const val = reduceValues(reducer, grp.buckets.get(ts) ?? []);
      if (val !== undefined) samples.push({ ts, val });
      if (opts.count !== undefined && samples.length >= opts.count) break;
    }
    const gKey = bytes(`${groupLabelStr}=${valStr}`);
    const lbls = groupLabelsReply(proto, groupLabel, grp.val, reducer, grp.keys, opts.withLabels, opts.selectedLabels);
    const samplesReply = formatSamplesReply(proto, samples);
    if (proto === 3) {
      mapEntries.push([
        r.bulk(gKey),
        r.array([
          lbls,
          r.map([[r.bulk("reducers"), r.array([r.bulk(reducer)])]]),
          r.map([[r.bulk("sources"), r.bulks(grp.keys)]]),
          samplesReply,
        ]),
      ]);
    } else {
      arrayEntries.push(r.array([r.bulk(gKey), lbls, samplesReply]));
    }
  }
  return proto === 3 ? r.map(mapEntries) : r.array(arrayEntries);
}

function tsMrangeCmd(ctx: Ctx, args: Array<Uint8Array>, rev: boolean): Reply {
  const from = parseRangeTimestamp(args[1], TS_ERR.badFromTs);
  const to = parseRangeTimestamp(args[2], TS_ERR.badToTs);
  const opts = parseRangeOpts(args, 3, from, to, true, 1);
  if (!opts.filterArgs) throw new RedisError(`ERR wrong number of arguments for '${rev ? "ts.mrevrange" : "ts.mrange"}' command`);
  const series = matchSeries(ctx, parseFilters(opts.filterArgs));
  if (opts.groupLabel !== undefined) return tsMrangeGroupBy(ctx, series, from.value, to.value, opts, rev);

  const proto = ctx.session.proto;
  const aggOpts: AggOpts | undefined = opts.aggOpts ? { ...opts.aggOpts, agg: opts.aggs[0] } : undefined;
  const aggList = aggOpts ? [r.bulk(aggOpts.agg)] : [];
  const rows: Array<[Uint8Array, Reply, Reply]> = [];
  for (const s of series) {
    const samples = finalizeSamples(querySeriesSamples(ctx, s.id, from.value, to.value, opts.latest, opts.filter, aggOpts), rev, opts.count);
    if (opts.excludeEmpty && !samples.length) continue;
    const lbls = formatLabelsReply(proto, selectLabels(getLabels(ctx, s.id), opts.withLabels, opts.selectedLabels));
    rows.push([s.key, lbls, formatSamplesReply(proto, samples)]);
  }
  if (proto === 3) {
    return r.map(rows.map(([k, lbls, s]) => [r.bulk(k), r.array([lbls, r.map([[r.bulk("aggregators"), r.array(aggList)]]), s])]));
  }
  return r.array(rows.map(([k, lbls, s]) => r.array([r.bulk(k), lbls, s])));
}

function tsNrangeCmd(ctx: Ctx, args: Array<Uint8Array>, rev: boolean): Reply {
  const numkeys = parsePosInt(args[1], TS_ERR.nrangeNumkeys);
  if (args.length < 4 + numkeys) throw new RedisError(`ERR wrong number of arguments for '${rev ? "ts.nrevrange" : "ts.nrange"}' command`);
  const keys = args.slice(2, 2 + numkeys);
  const from = parseRangeTimestamp(args[2 + numkeys], TS_ERR.badFromTs);
  const to = parseRangeTimestamp(args[3 + numkeys], TS_ERR.badToTs);
  const opts = parseRangeOpts(args, 4 + numkeys, from, to, false, numkeys, true);
  const rows = keys.map((k) => requireTsKey(ctx, k));
  const maps: Array<Map<number, number>> = [];
  const allTs = new Set<number>();
  for (let j = 0; j < numkeys; j++) {
    const aggOpts: AggOpts | undefined = opts.aggOpts ? { ...opts.aggOpts, agg: opts.aggs[j] } : undefined;
    const m = new Map<number, number>();
    for (const s of querySeriesSamples(ctx, rows[j].id, from.value, to.value, opts.latest, opts.filter, aggOpts)) {
      m.set(s.ts, s.val);
      allTs.add(s.ts);
    }
    maps.push(m);
  }
  let timestamps = [...allTs].toSorted((a, b) => (rev ? b - a : a - b));
  if (opts.count !== undefined) timestamps = timestamps.slice(0, opts.count);
  const proto = ctx.session.proto;
  return r.array(
    timestamps.map((ts) =>
      r.array([
        r.int(ts),
        r.array(maps.map((m) => tsValueReply(proto, m.get(ts) ?? Number.NaN))),
      ]),
    ),
  );
}

function tsCreateRule(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (opt(args[3]) !== "AGGREGATION") throw new RedisError(ERR.syntax);
  if (args.length > 7) throw new RedisError("ERR wrong number of arguments for 'ts.createrule' command");
  const agg = parseAggregator(args[4]);
  const bucketDuration = parsePosInt(args[5], TS_ERR.badBucketDuration);
  const alignTs = args[6] ? parseNonNegInt(args[6], TS_ERR.badTimestamp, TS_ERR.negTimestamp) : 0;
  createRule(ctx, args[1], args[2], agg, bucketDuration, alignTs);
  return r.ok;
}

function tsDeleteRule(ctx: Ctx, [, src, dst]: Array<Uint8Array>): Reply {
  deleteRule(ctx, src, dst);
  return r.ok;
}

function tsInfo(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const debug = args.length >= 3 && opt(args[2]) === "DEBUG";
  const row = requireTsKey(ctx, key);
  const meta = getMeta(ctx, row.id);
  const stats = getSeriesStats(ctx, row.id, meta);
  const labels = getLabels(ctx, row.id);
  const incoming = getIncomingRule(ctx, row.id, meta.uid);
  const outgoing = getOutgoingRules(ctx, row.id, meta.uid);
  const proto = ctx.session.proto;
  const rulesReply =
    proto === 3
      ? r.map(outgoing.map((rule) => [r.bulk(rule.destKey), r.array([r.int(rule.bucketDuration), r.simple(rule.aggregator.toUpperCase()), r.int(rule.alignTs)])]))
      : r.array(outgoing.map((rule) => r.array([r.bulk(rule.destKey), r.int(rule.bucketDuration), r.simple(rule.aggregator.toUpperCase()), r.int(rule.alignTs)])));
  const memoryUsage = 4096 + stats.totalSamples * 16 + labels.length * 64 + outgoing.length * 64;
  const entries: Array<[Reply, Reply]> = [
    [r.simple("totalSamples"), r.int(stats.totalSamples)],
    [r.simple("memoryUsage"), r.int(memoryUsage)],
    [r.simple("firstTimestamp"), r.int(stats.firstTs)],
    [r.simple("lastTimestamp"), r.int(stats.lastTs)],
    [r.simple("retentionTime"), r.int(meta.retention)],
    [r.simple("chunkCount"), r.int(1)],
    [r.simple("chunkSize"), r.int(meta.chunkSize)],
    [r.simple("chunkType"), r.simple(meta.compressed ? "compressed" : "uncompressed")],
    [r.simple("duplicatePolicy"), r.simple(meta.dupPolicy)],
    [r.simple("labels"), formatLabelsReply(proto, labels)],
    [r.simple("sourceKey"), incoming ? r.bulk(incoming.sourceKey) : r.nil],
    [r.simple("rules"), rulesReply],
    [r.simple("ignoreMaxTimeDiff"), r.int(meta.ignoreTime)],
    [r.simple("ignoreMaxValDiff"), r.double(meta.ignoreVal)],
  ];
  if (debug) {
    entries.push(
      [r.simple("keySelfName"), r.bulk(key)],
      [
        r.simple("Chunks"),
        r.array([
          r.map([
            [r.simple("startTimestamp"), r.int(stats.totalSamples ? stats.firstTs : -1)],
            [r.simple("endTimestamp"), r.int(stats.totalSamples ? stats.lastTs : -1)],
            [r.simple("samples"), r.int(stats.totalSamples)],
            [r.simple("size"), r.int(meta.initChunkSize)],
            [r.simple("bytesPerSample"), r.double(stats.totalSamples ? meta.initChunkSize / stats.totalSamples : 0)],
          ]),
        ]),
      ],
    );
  }
  return r.map(entries);
}

function tsQueryIndex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const keys = matchSeries(ctx, parseFilters(args.slice(1))).map((m) => m.key);
  return ctx.session.proto === 3 ? r.set(keys.map((k) => r.bulk(k))) : r.bulks(keys);
}

function tsQueryLabels(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = opt(args[1]);
  let items: Array<Uint8Array>;
  if (sub === "LABELS") {
    let keyIds: Array<number> | undefined;
    if (args.length > 2) {
      if (opt(args[2]) !== "FILTER") throw new RedisError(ERR.syntax);
      if (args.length < 4) throw new RedisError(TS_ERR.queryLabelsNoFilter);
      keyIds = matchSeries(ctx, parseFilters(args.slice(3))).map((m) => m.id);
    }
    items = getDistinctLabelNames(ctx, keyIds);
  } else if (sub === "VALUES") {
    if (args.length < 3) throw new RedisError("ERR wrong number of arguments for 'ts.querylabels' command");
    const label = args[2];
    let keyIds: Array<number> | undefined;
    if (args.length > 3) {
      if (opt(args[3]) !== "FILTER") throw new RedisError(ERR.syntax);
      if (args.length < 5) throw new RedisError(TS_ERR.queryLabelsNoFilter);
      keyIds = matchSeries(ctx, parseFilters(args.slice(4))).map((m) => m.id);
    }
    items = getDistinctLabelValues(ctx, label, keyIds);
  } else {
    throw new RedisError(TS_ERR.queryLabelsSubtype);
  }
  return ctx.session.proto === 3 ? r.set(items.map((x) => r.bulk(x))) : r.bulks(items);
}

function tsRead(ctx: Ctx, args: Array<Uint8Array>): Outcome {
  const key = args[1];
  const tsStr = text(args[2]);
  let blockOpts: { ms: number; minCount: number } | undefined;
  let maxCount: number | undefined;
  let i = 3;
  while (i < args.length) {
    const tok = opt(args[i]);
    if (tok === "BLOCK") {
      if (i + 2 >= args.length) throw new RedisError(ERR.syntax);
      blockOpts = {
        ms: parseNonNegInt(args[i + 1], TS_ERR.readBadBlockMs),
        minCount: parsePosInt(args[i + 2], TS_ERR.readBadMinCount),
      };
      i += 3;
    } else if (tok === "MAX_COUNT") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      maxCount = parsePosInt(args[i + 1], TS_ERR.readBadMaxCount);
      i += 2;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  if (blockOpts && maxCount !== undefined && blockOpts.minCount > maxCount) throw new RedisError(TS_ERR.readMinGtMax);
  if (blockOpts && ctx.mode !== "client") throw new RedisError(TS_ERR.readBlockDenied);
  if (tsStr === "*") throw new RedisError(TS_ERR.readBadTs);

  const row = getTsKey(ctx, key, WRONGTYPE);
  const last = row ? getLastRawSample(ctx, row.id) : undefined;
  const minTs = tsStr === "-" ? 0 : tsStr === "+" ? (last ? last.ts : 0) : parseNonNegInt(args[2], TS_ERR.readBadTs);
  const samples = row ? readSince(ctx, row.id, minTs, maxCount) : [];
  const reply = formatSamplesReply(ctx.session.proto, samples);
  if (!blockOpts || samples.length >= blockOpts.minCount) return reply;
  const retry = tsStr === "+" && last ? [args[0], args[1], bytes(String(last.ts)), ...args.slice(3)] : args;
  return block(ctx, [key], blockOpts.ms, reply, retry);
}

export const timeseries: Table = {
  "ts.create": spec(-2, ["write", "fast"], tsCreate),
  "ts.alter": spec(-2, ["write"], tsAlter),
  "ts.add": spec(-4, ["write"], tsAdd),
  "ts.madd": spec(-4, ["write"], tsMadd, [1, -1, 3]),
  "ts.incrby": spec(-3, ["write"], (ctx, args) => tsIncrDecr(ctx, args, 1)),
  "ts.decrby": spec(-3, ["write"], (ctx, args) => tsIncrDecr(ctx, args, -1)),
  "ts.del": spec(4, ["write"], tsDel),
  "ts.get": spec(-2, ["readonly", "fast"], tsGet),
  "ts.mget": keyless(-3, ["readonly"], tsMget),
  "ts.range": spec(-4, ["readonly"], (ctx, args) => tsRangeCmd(ctx, args, false)),
  "ts.revrange": spec(-4, ["readonly"], (ctx, args) => tsRangeCmd(ctx, args, true)),
  "ts.mrange": keyless(-4, ["readonly"], (ctx, args) => tsMrangeCmd(ctx, args, false)),
  "ts.mrevrange": keyless(-4, ["readonly"], (ctx, args) => tsMrangeCmd(ctx, args, true)),
  "ts.nrange": keyless(-5, ["readonly"], (ctx, args) => tsNrangeCmd(ctx, args, false)),
  "ts.nrevrange": keyless(-5, ["readonly"], (ctx, args) => tsNrangeCmd(ctx, args, true)),
  "ts.createrule": spec(-6, ["write", "fast"], tsCreateRule, [1, 2, 1]),
  "ts.deleterule": spec(3, ["write", "fast"], tsDeleteRule, [1, 2, 1]),
  "ts.info": spec(-2, ["readonly", "fast"], tsInfo),
  "ts.queryindex": keyless(-2, ["readonly"], tsQueryIndex),
  "ts.querylabels": keyless(-2, ["readonly"], tsQueryLabels),
  "ts.read": spec(-3, ["readonly", "blocking"], tsRead),
};
