import { bytes, formatDouble, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { blob, checkSize, fromBlob, keyString } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, int, opt, toFloat } from "./args";
import { block, timeoutArg } from "./blocking";
import { cursorArg, scanOptions } from "./keys";
import { sample } from "./random";
import { keyless, spec } from "./types";
import type { Ctx, Outcome, Spec, Table } from "./types";

export interface Entry {
  member: Uint8Array;
  score: number;
}

export interface Bound {
  value: number;
  exclusive: boolean;
}

export interface LexBound {
  value: Uint8Array | null;
  exclusive: boolean;
  infinite: "min" | "max" | null;
}

export type Query =
  | { by: "rank"; start: number; stop: number; rev: boolean }
  | { by: "score"; min: Bound; max: Bound; rev: boolean; offset: number; count: number }
  | { by: "lex"; min: LexBound; max: LexBound; rev: boolean; offset: number; count: number };

type Aggregate = "sum" | "min" | "max" | "count";

const AGGREGATES = new Map<string, Aggregate>([["SUM", "sum"], ["MIN", "min"], ["MAX", "max"], ["COUNT", "count"]]);

export const zsetId = (ctx: Ctx, key: Uint8Array): number | undefined => ctx.ks.getTyped(key, TYPE.zset)?.id;

const toEntry = (row: { member: ArrayBuffer; score: number }): Entry => ({ member: fromBlob(row.member), score: row.score });

function card(ctx: Ctx, id: number): number {
  return ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM zset_members WHERE key_id = ?", id).one().n;
}

export function score(ctx: Ctx, id: number, member: Uint8Array): number | undefined {
  return ctx.ks.sql.exec<{ score: number }>("SELECT score FROM zset_members WHERE key_id = ? AND member = ?", id, blob(member)).toArray()[0]?.score;
}

export function put(ctx: Ctx, key: Uint8Array, id: number, member: Uint8Array, value: number) {
  checkSize(key, member);
  ctx.ks.sql.exec("INSERT INTO zset_members (key_id, member, score) VALUES (?, ?, ?) ON CONFLICT (key_id, member) DO UPDATE SET score = excluded.score",
    id, blob(member), value);
}

export function remove(ctx: Ctx, key: Uint8Array, id: number, members: Array<Uint8Array>): number {
  let removed = 0;
  for (const m of members) removed += ctx.ks.sql.exec("DELETE FROM zset_members WHERE key_id = ? AND member = ? RETURNING id", id, blob(m)).toArray().length;
  if (!removed) return 0;
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(id, key, TYPE.zset);
  return removed;
}

function all(ctx: Ctx, id: number): Array<Entry> {
  return ctx.ks.sql.exec<{ member: ArrayBuffer; score: number }>("SELECT member, score FROM zset_members WHERE key_id = ? ORDER BY score, member", id)
    .toArray().map(toEntry);
}

function scoreArg(b: Uint8Array): number {
  const n = toFloat(b);
  if (n === undefined) throw new RedisError(ERR.float);
  return n;
}

export function boundArg(b: Uint8Array): Bound {
  const s = text(b);
  const exclusive = s.startsWith("(");
  const n = toFloat(bytes(exclusive ? s.slice(1) : s));
  if (n === undefined) throw new RedisError("ERR min or max is not a float");
  return { value: n, exclusive };
}

function lexArg(b: Uint8Array): LexBound {
  if (b.length === 1 && b[0] === 0x2d) return { value: null, exclusive: false, infinite: "min" };
  if (b.length === 1 && b[0] === 0x2b) return { value: null, exclusive: false, infinite: "max" };
  if (b[0] === 0x28) return { value: b.subarray(1), exclusive: true, infinite: null };
  if (b[0] === 0x5b) return { value: b.subarray(1), exclusive: false, infinite: null };
  throw new RedisError("ERR min or max not valid string range item");
}

function scoreWhere(min: Bound, max: Bound): [string, Array<number>] {
  return [`score ${min.exclusive ? ">" : ">="} ? AND score ${max.exclusive ? "<" : "<="} ?`, [min.value, max.value]];
}

function lexWhere(min: LexBound, max: LexBound): [string, Array<ArrayBuffer>] | undefined {
  if (min.infinite === "max" || max.infinite === "min") return undefined;
  const parts: Array<string> = [];
  const params: Array<ArrayBuffer> = [];
  if (min.value) {
    parts.push(`member ${min.exclusive ? ">" : ">="} ?`);
    params.push(blob(min.value));
  }
  if (max.value) {
    parts.push(`member ${max.exclusive ? "<" : "<="} ?`);
    params.push(blob(max.value));
  }
  return [parts.length ? parts.join(" AND ") : "1", params];
}

export function select(ctx: Ctx, id: number, q: Query): Array<Entry> {
  const dir = q.rev ? "DESC" : "ASC";
  const order = `ORDER BY score ${dir}, member ${dir}`;
  if (q.by === "rank") {
    const n = card(ctx, id);
    let start = q.start < 0 ? Math.max(n + q.start, 0) : q.start;
    let stop = q.stop < 0 ? n + q.stop : q.stop;
    if (stop >= n) stop = n - 1;
    if (start > stop || start >= n) return [];
    start = Math.max(start, 0);
    return ctx.ks.sql.exec<{ member: ArrayBuffer; score: number }>(
      `SELECT member, score FROM zset_members WHERE key_id = ? ${order} LIMIT ? OFFSET ?`, id, stop - start + 1, start).toArray().map(toEntry);
  }
  if (q.offset < 0) return [];
  const where = q.by === "score" ? scoreWhere(q.min, q.max) : lexWhere(q.min, q.max);
  if (!where) return [];
  return ctx.ks.sql.exec<{ member: ArrayBuffer; score: number }>(
    `SELECT member, score FROM zset_members WHERE key_id = ? AND ${where[0]} ${order} LIMIT ? OFFSET ?`, id, ...where[1], q.count, q.offset)
    .toArray().map(toEntry);
}

export function scored(ctx: Ctx, entries: Array<Entry>, withScores: boolean): Reply {
  if (!withScores) return r.bulks(entries.map((e) => e.member));
  if (ctx.session.proto === 3) return r.array(entries.map((e) => r.array([r.bulk(e.member), r.double(e.score)])));
  return r.array(entries.flatMap((e) => [r.bulk(e.member), r.double(e.score)]));
}

interface RangeArgs {
  query: Query;
  withScores: boolean;
}

function rangeArgs(args: Array<Uint8Array>, first: number, style: "zrange" | "byscore" | "bylex" | "rank", reverse: boolean): RangeArgs {
  let by: "rank" | "score" | "lex" = style === "byscore" ? "score" : style === "bylex" ? "lex" : "rank";
  let rev = reverse;
  let withScores = false;
  let limit: [number, number] | undefined;
  for (let i = first + 2; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "WITHSCORES" && style !== "bylex") withScores = true;
    else if (o === "BYSCORE" && style === "zrange") by = "score";
    else if (o === "BYLEX" && style === "zrange") by = "lex";
    else if (o === "REV" && style === "zrange") rev = true;
    else if (o === "LIMIT" && style !== "rank" && i + 2 < args.length) {
      limit = [int(args[i + 1]), int(args[i + 2])];
      i += 2;
    } else throw new RedisError(ERR.syntax);
  }
  if (limit && by === "rank") throw new RedisError("ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX");
  if (withScores && by === "lex") throw new RedisError("ERR syntax error, WITHSCORES not supported in combination with BYLEX");
  const [lowArg, highArg] = rev && by !== "rank" ? [args[first + 1], args[first]] : [args[first], args[first + 1]];
  const [offset, count] = limit ?? [0, -1];
  if (by === "rank") return { query: { by, start: int(args[first]), stop: int(args[first + 1]), rev }, withScores };
  if (by === "score") return { query: { by, min: boundArg(lowArg), max: boundArg(highArg), rev, offset, count }, withScores };
  return { query: { by, min: lexArg(lowArg), max: lexArg(highArg), rev, offset, count }, withScores };
}

function range(style: "zrange" | "byscore" | "bylex" | "rank", reverse: boolean): Spec["run"] {
  return (ctx, args) => {
    const { query, withScores } = rangeArgs(args, 2, style, reverse);
    const id = zsetId(ctx, args[1]);
    return scored(ctx, id === undefined ? [] : select(ctx, id, query), withScores);
  };
}

function zrangestore(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const { query } = rangeArgs(args, 3, "zrange", false);
  const id = zsetId(ctx, args[2]);
  return store(ctx, args[1], id === undefined ? [] : select(ctx, id, query));
}

export function store(ctx: Ctx, destination: Uint8Array, entries: Array<Entry>): Reply {
  ctx.ks.delete(destination);
  if (!entries.length) return r.int(0);
  const id = ctx.ks.create(destination, TYPE.zset);
  for (const e of entries) put(ctx, destination, id, e.member, e.score);
  return r.int(entries.length);
}

function zadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const flags = new Set<string>();
  let i = 2;
  for (; i < args.length; i++) {
    const o = opt(args[i]);
    if (!["NX", "XX", "GT", "LT", "CH", "INCR"].includes(o)) break;
    flags.add(o);
  }
  const pairs = args.slice(i);
  if (!pairs.length || pairs.length % 2) throw new RedisError(ERR.syntax);
  if (flags.has("NX") && flags.has("XX")) throw new RedisError("ERR XX and NX options at the same time are not compatible");
  if ((flags.has("GT") && flags.has("LT")) || (flags.has("NX") && (flags.has("GT") || flags.has("LT")))) {
    throw new RedisError("ERR GT, LT, and/or NX options at the same time are not compatible");
  }
  if (flags.has("INCR") && pairs.length > 2) throw new RedisError("ERR INCR option supports a single increment-element pair");
  const updates = Array.from({ length: pairs.length / 2 }, (_, j) => ({ score: scoreArg(pairs[j * 2]), member: pairs[j * 2 + 1] }));
  const existing = zsetId(ctx, key);
  if (existing === undefined && flags.has("XX")) return flags.has("INCR") ? r.nil : r.int(0);
  const id = existing ?? ctx.ks.create(key, TYPE.zset);
  let added = 0;
  let changed = 0;
  let result: number | undefined;
  for (const u of updates) {
    const current = score(ctx, id, u.member);
    if (current === undefined ? flags.has("XX") : flags.has("NX")) continue;
    const next = flags.has("INCR") ? (current ?? 0) + u.score : u.score;
    if (Number.isNaN(next)) throw new RedisError("ERR resulting score is not a number (NaN)");
    if (current !== undefined && flags.has("GT") && next <= current) continue;
    if (current !== undefined && flags.has("LT") && next >= current) continue;
    result = next;
    if (current === next) continue;
    put(ctx, key, id, u.member, next);
    if (current === undefined) added++;
    else changed++;
  }
  if (added || changed) ctx.ks.onChange(key);
  if (flags.has("INCR")) return result === undefined ? r.nil : r.double(result);
  return r.int(flags.has("CH") ? added + changed : added);
}

function rank(ctx: Ctx, args: Array<Uint8Array>, rev: boolean): Reply {
  const [, key, member, extra] = args;
  if (args.length > 4 || (extra && opt(extra) !== "WITHSCORE")) throw new RedisError(ERR.syntax);
  const id = zsetId(ctx, key);
  const s = id === undefined ? undefined : score(ctx, id, member);
  if (id === undefined || s === undefined) return extra ? r.nilArray : r.nil;
  const cmp = rev ? "score > ? OR (score = ? AND member > ?)" : "score < ? OR (score = ? AND member < ?)";
  const n = ctx.ks.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM zset_members WHERE key_id = ? AND (${cmp})`, id, s, s, blob(member)).one().n;
  return extra ? r.array([r.int(n), r.double(s)]) : r.int(n);
}

function popEntries(ctx: Ctx, key: Uint8Array, id: number, max: boolean, count: number): Array<Entry> {
  const entries = select(ctx, id, { by: "rank", start: 0, stop: count - 1, rev: max });
  remove(ctx, key, id, entries.map((e) => e.member));
  return entries;
}

function zpop(ctx: Ctx, args: Array<Uint8Array>, max: boolean): Reply {
  if (args.length > 3) throw new RedisError(ERR.syntax);
  const count = args.length === 3 ? int(args[2], "ERR value is out of range, must be positive") : undefined;
  if (count !== undefined && count < 0) throw new RedisError("ERR value is out of range, must be positive");
  const id = zsetId(ctx, args[1]);
  if (id === undefined || count === 0) return r.array([]);
  const entries = popEntries(ctx, args[1], id, max, count ?? 1);
  if (count === undefined) return r.array(entries.flatMap((e) => [r.bulk(e.member), r.double(e.score)]));
  return scored(ctx, entries, true);
}

function bzpop(ctx: Ctx, args: Array<Uint8Array>, max: boolean): Outcome {
  const keys = args.slice(1, -1);
  const [timeoutBytes] = args.slice(-1);
  const timeout = timeoutArg(timeoutBytes);
  for (const key of keys) {
    const id = zsetId(ctx, key);
    if (id === undefined) continue;
    const [e] = popEntries(ctx, key, id, max, 1);
    return r.array([r.bulk(key), r.bulk(e.member), r.double(e.score)]);
  }
  return block(ctx, keys, timeout, r.nilArray);
}

interface MpopArgs {
  keys: Array<Uint8Array>;
  max: boolean;
  count: number;
}

function mpopArgs(args: Array<Uint8Array>, first: number): MpopArgs {
  const numkeys = int(args[first], "ERR numkeys should be greater than 0");
  if (numkeys <= 0) throw new RedisError("ERR numkeys should be greater than 0");
  const keys = args.slice(first + 1, first + 1 + numkeys);
  let i = first + 1 + numkeys;
  if (keys.length < numkeys || i >= args.length) throw new RedisError(ERR.syntax);
  const where = opt(args[i++]);
  if (where !== "MIN" && where !== "MAX") throw new RedisError(ERR.syntax);
  let count = 1;
  let counted = false;
  while (i < args.length) {
    if (opt(args[i]) !== "COUNT" || counted || i + 1 >= args.length) throw new RedisError(ERR.syntax);
    count = int(args[i + 1], "ERR count should be greater than 0");
    if (count <= 0) throw new RedisError("ERR count should be greater than 0");
    counted = true;
    i += 2;
  }
  return { keys, max: where === "MAX", count };
}

function zmpop(ctx: Ctx, keys: Array<Uint8Array>, max: boolean, count: number): Reply | undefined {
  for (const key of keys) {
    const id = zsetId(ctx, key);
    if (id === undefined) continue;
    const entries = popEntries(ctx, key, id, max, count);
    return r.array([r.bulk(key), r.array(entries.map((e) => r.array([r.bulk(e.member), r.double(e.score)])))]);
  }
  return undefined;
}

function source(ctx: Ctx, key: Uint8Array): Array<Entry> {
  const row = ctx.ks.get(key);
  if (!row) return [];
  if (row.type === TYPE.zset) return all(ctx, row.id);
  if (row.type !== TYPE.set) throw new RedisError("WRONGTYPE Operation against a key holding the wrong kind of value");
  return ctx.ks.sql.exec<{ member: ArrayBuffer }>("SELECT member FROM set_members WHERE key_id = ? ORDER BY id", row.id)
    .toArray().map((m) => ({ member: fromBlob(m.member), score: 1 }));
}

interface SetOpArgs {
  keys: Array<Uint8Array>;
  weights: Array<number>;
  aggregate: Aggregate;
  withScores: boolean;
  limit: number;
}

function setOpArgs(args: Array<Uint8Array>, first: number, allow: { weights: boolean; withScores: boolean; limit: boolean }): SetOpArgs {
  const numkeys = int(args[first]);
  if (numkeys <= 0) throw new RedisError(`ERR at least 1 input key is needed for '${text(args[0]).toLowerCase()}' command`);
  const keys = args.slice(first + 1, first + 1 + numkeys);
  if (keys.length < numkeys) throw new RedisError(ERR.syntax);
  const parsed: SetOpArgs = { keys, weights: keys.map(() => 1), aggregate: "sum", withScores: false, limit: 0 };
  for (let i = first + 1 + numkeys; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "WEIGHTS" && allow.weights && i + numkeys < args.length) {
      parsed.weights = args.slice(i + 1, i + 1 + numkeys).map((w) => {
        const n = toFloat(w);
        if (n === undefined) throw new RedisError("ERR weight value is not a float");
        return n;
      });
      i += numkeys;
    } else if (o === "AGGREGATE" && allow.weights && i + 1 < args.length) {
      const aggregate = AGGREGATES.get(opt(args[++i]));
      if (!aggregate) throw new RedisError(ERR.syntax);
      parsed.aggregate = aggregate;
    } else if (o === "WITHSCORES" && allow.withScores) {
      parsed.withScores = true;
    } else if (o === "LIMIT" && allow.limit && i + 1 < args.length) {
      parsed.limit = int(args[++i], "ERR LIMIT can't be negative");
      if (parsed.limit < 0) throw new RedisError("ERR LIMIT can't be negative");
    } else throw new RedisError(ERR.syntax);
  }
  return parsed;
}

const finite = (n: number) => (Number.isNaN(n) ? 0 : n);

function combine(op: "union" | "inter" | "diff", inputs: Array<Array<Entry>>, weights: Array<number>, aggregate: Aggregate): Array<Entry> {
  const merge = (a: number, b: number) => (aggregate === "min" ? Math.min(a, b) : aggregate === "max" ? Math.max(a, b) : finite(a + b));
  const weigh = (e: Entry, w: number) => (aggregate === "count" ? w : finite(e.score * w));
  const weighted = inputs.map((entries, i) => new Map(entries.map((e) => [keyString(e.member), { member: e.member, score: weigh(e, weights[i]) }])));
  const [first = new Map<string, Entry>(), ...rest] = weighted;
  const out = new Map<string, Entry>();
  if (op === "diff") {
    for (const [k, e] of first) if (rest.every((m) => !m.has(k))) out.set(k, e);
  } else if (op === "inter") {
    for (const [k, e] of first) {
      if (!rest.every((m) => m.has(k))) continue;
      out.set(k, { member: e.member, score: rest.reduce((acc, m) => merge(acc, m.get(k)?.score ?? 0), e.score) });
    }
  } else {
    for (const m of weighted) {
      for (const [k, e] of m) {
        const prev = out.get(k);
        out.set(k, prev ? { member: e.member, score: merge(prev.score, e.score) } : e);
      }
    }
  }
  return [...out.values()].toSorted(compareEntries);
}

function compareEntries(a: Entry, b: Entry): number {
  if (a.score !== b.score) return a.score < b.score ? -1 : 1;
  const n = Math.min(a.member.length, b.member.length);
  for (let i = 0; i < n; i++) if (a.member[i] !== b.member[i]) return a.member[i] - b.member[i];
  return a.member.length - b.member.length;
}

function setOp(op: "union" | "inter" | "diff", storing: boolean): Spec["run"] {
  return (ctx, args) => {
    const first = storing ? 2 : 1;
    const parsed = setOpArgs(args, first, { weights: op !== "diff", withScores: !storing, limit: false });
    const result = combine(op, parsed.keys.map((k) => source(ctx, k)), parsed.weights, parsed.aggregate);
    if (storing) return store(ctx, args[1], result);
    return scored(ctx, result, parsed.withScores);
  };
}

function removeRange(style: "rank" | "byscore" | "bylex"): Spec["run"] {
  return (ctx, [, key, a, b]) => {
    const query: Query = style === "rank"
      ? { by: "rank", start: int(a), stop: int(b), rev: false }
      : style === "byscore"
        ? { by: "score", min: boundArg(a), max: boundArg(b), rev: false, offset: 0, count: -1 }
        : { by: "lex", min: lexArg(a), max: lexArg(b), rev: false, offset: 0, count: -1 };
    const id = zsetId(ctx, key);
    if (id === undefined) return r.int(0);
    return r.int(remove(ctx, key, id, select(ctx, id, query).map((e) => e.member)));
  };
}

function zrandmember(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, countArg, withArg] = args;
  if (args.length > 4 || (withArg && opt(withArg) !== "WITHSCORES")) throw new RedisError(ERR.syntax);
  const id = zsetId(ctx, key);
  if (countArg === undefined) return r.bulk(id === undefined ? null : (sample(all(ctx, id), 1)[0]?.member ?? null));
  const picked = id === undefined ? [] : sample(all(ctx, id), int(countArg));
  return scored(ctx, picked, withArg !== undefined);
}

function zscan(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const cursor = cursorArg(args[2]);
  const { match, count: limit } = scanOptions(args.slice(3));
  const id = zsetId(ctx, args[1]);
  if (id === undefined) return r.array([r.bulk("0"), r.array([])]);
  const page = ctx.ks.sql.exec<{ id: number; member: ArrayBuffer; score: number }>(
    "SELECT id, member, score FROM zset_members WHERE key_id = ? AND id > ? ORDER BY id LIMIT ?", id, cursor, limit).toArray();
  const next = page.length < limit ? 0 : (page.at(-1)?.id ?? 0);
  const found = page.map(toEntry).filter((e) => !match || globMatch(match, e.member));
  return r.array([r.bulk(String(next)), r.bulks(found.flatMap((e) => [e.member, formatDouble(e.score)]))]);
}

function count(style: "byscore" | "bylex"): Spec["run"] {
  return (ctx, [, key, a, b]) => {
    const id = zsetId(ctx, key);
    if (style === "byscore") {
      const [where, params] = scoreWhere(boundArg(a), boundArg(b));
      if (id === undefined) return r.int(0);
      return r.int(ctx.ks.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM zset_members WHERE key_id = ? AND ${where}`, id, ...params).one().n);
    }
    const lex = lexWhere(lexArg(a), lexArg(b));
    if (id === undefined || !lex) return r.int(0);
    return r.int(ctx.ks.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM zset_members WHERE key_id = ? AND ${lex[0]}`, id, ...lex[1]).one().n);
  };
}

function zincrby(ctx: Ctx, [, key, by, member]: Array<Uint8Array>): Reply {
  return zadd(ctx, [bytes("zadd"), key, bytes("INCR"), by, member]);
}

function zrem(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const id = zsetId(ctx, args[1]);
  return r.int(id === undefined ? 0 : remove(ctx, args[1], id, args.slice(2)));
}

function zcard(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const id = zsetId(ctx, key);
  return r.int(id === undefined ? 0 : card(ctx, id));
}

function scoreReply(ctx: Ctx, id: number | undefined, member: Uint8Array): Reply {
  const s = id === undefined ? undefined : score(ctx, id, member);
  return s === undefined ? r.nil : r.double(s);
}

function zintercard(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const parsed = setOpArgs(args, 1, { weights: false, withScores: false, limit: true });
  const n = combine("inter", parsed.keys.map((k) => source(ctx, k)), parsed.weights, "sum").length;
  return r.int(parsed.limit ? Math.min(n, parsed.limit) : n);
}

function zmpopCommand(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const { keys, max, count: n } = mpopArgs(args, 1);
  return zmpop(ctx, keys, max, n) ?? r.nilArray;
}

function bzmpop(ctx: Ctx, args: Array<Uint8Array>): Outcome {
  const timeout = timeoutArg(args[1]);
  const { keys, max, count: n } = mpopArgs(args, 2);
  return zmpop(ctx, keys, max, n) ?? block(ctx, keys, timeout, r.nilArray);
}

export const zsets: Table = {
  zadd: spec(-4, ["write", "fast"], zadd),
  zincrby: spec(4, ["write", "fast"], zincrby),
  zrem: spec(-3, ["write", "fast"], zrem),
  zcard: spec(2, ["readonly", "fast"], zcard),
  zscore: spec(3, ["readonly", "fast"], (ctx, [, key, member]) => scoreReply(ctx, zsetId(ctx, key), member)),
  zmscore: spec(-3, ["readonly", "fast"], (ctx, args) => {
    const id = zsetId(ctx, args[1]);
    return r.array(args.slice(2).map((m) => scoreReply(ctx, id, m)));
  }),
  zcount: spec(4, ["readonly", "fast"], count("byscore")),
  zlexcount: spec(4, ["readonly", "fast"], count("bylex")),
  zrange: spec(-4, ["readonly"], range("zrange", false)),
  zrevrange: spec(-4, ["readonly"], range("rank", true)),
  zrangebyscore: spec(-4, ["readonly"], range("byscore", false)),
  zrevrangebyscore: spec(-4, ["readonly"], range("byscore", true)),
  zrangebylex: spec(-4, ["readonly"], range("bylex", false)),
  zrevrangebylex: spec(-4, ["readonly"], range("bylex", true)),
  zrangestore: spec(-5, ["write"], zrangestore, [1, 2, 1]),
  zrank: spec(-3, ["readonly", "fast"], (ctx, args) => rank(ctx, args, false)),
  zrevrank: spec(-3, ["readonly", "fast"], (ctx, args) => rank(ctx, args, true)),
  zpopmin: spec(-2, ["write", "fast"], (ctx, args) => zpop(ctx, args, false)),
  zpopmax: spec(-2, ["write", "fast"], (ctx, args) => zpop(ctx, args, true)),
  bzpopmin: spec(-3, ["write", "blocking"], (ctx, args) => bzpop(ctx, args, false), [1, -2, 1]),
  bzpopmax: spec(-3, ["write", "blocking"], (ctx, args) => bzpop(ctx, args, true), [1, -2, 1]),
  zmpop: keyless(-4, ["write"], zmpopCommand),
  bzmpop: keyless(-5, ["write", "blocking"], bzmpop),
  zremrangebyrank: spec(4, ["write"], removeRange("rank")),
  zremrangebyscore: spec(4, ["write"], removeRange("byscore")),
  zremrangebylex: spec(4, ["write"], removeRange("bylex")),
  zunionstore: keyless(-4, ["write"], setOp("union", true)),
  zinterstore: keyless(-4, ["write"], setOp("inter", true)),
  zdiffstore: keyless(-4, ["write"], setOp("diff", true)),
  zunion: keyless(-3, ["readonly"], setOp("union", false)),
  zinter: keyless(-3, ["readonly"], setOp("inter", false)),
  zdiff: keyless(-3, ["readonly"], setOp("diff", false)),
  zintercard: keyless(-3, ["readonly"], zintercard),
  zrandmember: spec(-2, ["readonly"], zrandmember),
  zscan: spec(-3, ["readonly"], zscan),
};
