import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob, checkSize, fromBlob, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, int, opt } from "./args";
import { block, timeoutArg } from "./blocking";
import { keyless, spec } from "./types";
import type { Ctx, Outcome, Table } from "./types";

export type End = "left" | "right";

export interface ListRef {
  id: number;
  key: Uint8Array;
}

export const list = (ctx: Ctx, key: Uint8Array): ListRef | undefined => {
  const row = ctx.ks.getTyped(key, TYPE.list);
  return row ? { id: row.id, key } : undefined;
};

export const listOrCreate = (ctx: Ctx, key: Uint8Array): ListRef => list(ctx, key) ?? { id: ctx.ks.create(key, TYPE.list), key };

export function length(ctx: Ctx, l: ListRef): number {
  return ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM list_items WHERE key_id = ?", l.id).one().n;
}

function edgePos(ctx: Ctx, l: ListRef, end: End): number | null {
  const fn = end === "left" ? "min" : "max";
  return ctx.ks.sql.exec<{ p: number | null }>(`SELECT ${fn}(pos) AS p FROM list_items WHERE key_id = ?`, l.id).one().p;
}

export function pushItems(ctx: Ctx, l: ListRef, end: End, values: Array<Uint8Array>) {
  let pos = edgePos(ctx, l, end);
  for (const v of values) {
    checkSize(l.key, v);
    pos = pos === null ? 0 : end === "left" ? pos - 1 : pos + 1;
    ctx.ks.sql.exec("INSERT INTO list_items (key_id, pos, value) VALUES (?, ?, ?)", l.id, pos, blob(v));
  }
  ctx.ks.onChange(l.key);
}

export function popItems(ctx: Ctx, l: ListRef, end: End, count: number): Array<Uint8Array> {
  const order = end === "left" ? "ASC" : "DESC";
  const rows = ctx.ks.sql.exec<{ id: number; value: ArrayBuffer }>(
    `SELECT id, value FROM list_items WHERE key_id = ? ORDER BY pos ${order} LIMIT ?`, l.id, count).toArray();
  for (const row of rows) ctx.ks.sql.exec("DELETE FROM list_items WHERE id = ?", row.id);
  if (rows.length) {
    ctx.ks.onChange(l.key);
    ctx.ks.deleteIfEmpty(l.id, l.key, TYPE.list);
  }
  return rows.map((row) => fromBlob(row.value));
}

function items(ctx: Ctx, l: ListRef, offset = 0, limit = -1): Array<{ id: number; pos: number; value: Uint8Array }> {
  return ctx.ks.sql.exec<{ id: number; pos: number; value: ArrayBuffer }>(
    "SELECT id, pos, value FROM list_items WHERE key_id = ? ORDER BY pos LIMIT ? OFFSET ?", l.id, limit, offset).toArray()
    .map((row) => ({ id: row.id, pos: row.pos, value: fromBlob(row.value) }));
}

export function endArg(b: Uint8Array): End {
  const o = opt(b);
  if (o === "LEFT") return "left";
  if (o === "RIGHT") return "right";
  throw new RedisError(ERR.syntax);
}

function push(ctx: Ctx, args: Array<Uint8Array>, end: End, onlyExisting: boolean): Reply {
  const key = args[1];
  const existing = list(ctx, key);
  if (onlyExisting && !existing) return r.int(0);
  const l = existing ?? listOrCreate(ctx, key);
  pushItems(ctx, l, end, args.slice(2));
  return r.int(length(ctx, l));
}

function pop(ctx: Ctx, args: Array<Uint8Array>, end: End): Reply {
  if (args.length > 3) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const count = args.length === 3 ? int(args[2], "ERR value is out of range, must be positive") : undefined;
  if (count !== undefined && count < 0) throw new RedisError("ERR value is out of range, must be positive");
  const l = list(ctx, args[1]);
  if (!l) return count === undefined ? r.nil : r.nilArray;
  if (count === undefined) return r.bulk(popItems(ctx, l, end, 1)[0] ?? null);
  return r.bulks(popItems(ctx, l, end, count));
}

function range(len: number, from: number, to: number): [number, number] | undefined {
  let start = from;
  let stop = to;
  if (start < 0) start = Math.max(len + start, 0);
  if (stop < 0) stop = len + stop;
  if (stop >= len) stop = len - 1;
  if (start > stop || start >= len) return undefined;
  return [start, stop];
}

function move(ctx: Ctx, source: Uint8Array, destination: Uint8Array, from: End, to: End): Uint8Array | undefined {
  const src = list(ctx, source);
  if (!src) return undefined;
  ctx.ks.getTyped(destination, TYPE.list);
  const [value] = popItems(ctx, src, from, 1);
  pushItems(ctx, listOrCreate(ctx, destination), to, [value]);
  return value;
}

interface MpopArgs {
  keys: Array<Uint8Array>;
  end: End;
  count: number;
}

function mpopArgs(args: Array<Uint8Array>, first: number): MpopArgs {
  const numkeys = int(args[first], "ERR numkeys should be greater than 0");
  if (numkeys <= 0) throw new RedisError("ERR numkeys should be greater than 0");
  const keys = args.slice(first + 1, first + 1 + numkeys);
  let i = first + 1 + numkeys;
  if (keys.length < numkeys || i >= args.length) throw new RedisError(ERR.syntax);
  const end = endArg(args[i++]);
  let count = 1;
  let counted = false;
  while (i < args.length) {
    if (opt(args[i]) !== "COUNT" || counted || i + 1 >= args.length) throw new RedisError(ERR.syntax);
    count = int(args[i + 1], "ERR count should be greater than 0");
    if (count <= 0) throw new RedisError("ERR count should be greater than 0");
    counted = true;
    i += 2;
  }
  return { keys, end, count };
}

function mpop(ctx: Ctx, keys: Array<Uint8Array>, end: End, count: number): Reply | undefined {
  for (const key of keys) {
    const l = list(ctx, key);
    if (l) return r.array([r.bulk(key), r.bulks(popItems(ctx, l, end, count))]);
  }
  return undefined;
}

function bpop(ctx: Ctx, args: Array<Uint8Array>, end: End): Outcome {
  const keys = args.slice(1, -1);
  const [timeoutBytes] = args.slice(-1);
  const timeout = timeoutArg(timeoutBytes);
  for (const key of keys) {
    const l = list(ctx, key);
    if (l) return r.array([r.bulk(key), r.bulk(popItems(ctx, l, end, 1)[0])]);
  }
  return block(ctx, keys, timeout, r.nilArray);
}

function lpos(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, element] = args;
  let rank = 1;
  let count: number | undefined;
  let maxlen = 0;
  for (let i = 3; i < args.length; i += 2) {
    const o = opt(args[i]);
    if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
    if (o === "RANK") {
      rank = int(args[i + 1]);
      if (rank === 0) throw new RedisError("ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list");
    } else if (o === "COUNT") {
      count = int(args[i + 1]);
      if (count < 0) throw new RedisError("ERR COUNT can't be negative");
    } else if (o === "MAXLEN") {
      maxlen = int(args[i + 1]);
      if (maxlen < 0) throw new RedisError("ERR MAXLEN can't be negative");
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  const l = list(ctx, key);
  if (!l) return count === undefined ? r.nil : r.array([]);
  const all = items(ctx, l);
  const order = rank > 0 ? all.map((_, i) => i) : all.map((_, i) => all.length - 1 - i);
  const scan = maxlen ? order.slice(0, maxlen) : order;
  const wanted = count === undefined ? 1 : count === 0 ? Infinity : count;
  let skip = Math.abs(rank) - 1;
  const found: Array<number> = [];
  for (const i of scan) {
    if (found.length >= wanted) break;
    if (!sameBytes(all[i].value, element)) continue;
    if (skip > 0) {
      skip--;
      continue;
    }
    found.push(i);
  }
  if (count === undefined) return found.length ? r.int(found[0]) : r.nil;
  return r.array(found.map((i) => r.int(i)));
}

function linsert(ctx: Ctx, [, key, where, pivot, value]: Array<Uint8Array>): Reply {
  const o = opt(where);
  if (o !== "BEFORE" && o !== "AFTER") throw new RedisError(ERR.syntax);
  const l = list(ctx, key);
  if (!l) return r.int(0);
  const target = items(ctx, l).find((item) => sameBytes(item.value, pivot));
  if (!target) return r.int(-1);
  checkSize(key, value);
  const pos = o === "BEFORE" ? target.pos - 1 : target.pos + 1;
  const shift = o === "BEFORE" ? "pos = pos - 1 WHERE key_id = ? AND pos < ?" : "pos = pos + 1 WHERE key_id = ? AND pos > ?";
  ctx.ks.sql.exec(`UPDATE list_items SET ${shift}`, l.id, target.pos);
  ctx.ks.sql.exec("INSERT INTO list_items (key_id, pos, value) VALUES (?, ?, ?)", l.id, pos, blob(value));
  ctx.ks.onChange(key);
  return r.int(length(ctx, l));
}

function lrem(ctx: Ctx, [, key, countArg, element]: Array<Uint8Array>): Reply {
  const count = int(countArg);
  const l = list(ctx, key);
  if (!l) return r.int(0);
  const all = items(ctx, l);
  const ordered = count < 0 ? all.toReversed() : all;
  const limit = count === 0 ? Infinity : Math.abs(count);
  const doomed = ordered.filter((item) => sameBytes(item.value, element)).slice(0, limit);
  for (const item of doomed) ctx.ks.sql.exec("DELETE FROM list_items WHERE id = ?", item.id);
  if (!doomed.length) return r.int(0);
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(l.id, key, TYPE.list);
  return r.int(doomed.length);
}

function ltrim(ctx: Ctx, [, key, startArg, stopArg]: Array<Uint8Array>): Reply {
  const start = int(startArg);
  const stop = int(stopArg);
  const l = list(ctx, key);
  if (!l) return r.ok;
  const all = items(ctx, l);
  const span = range(all.length, start, stop);
  const keep = new Set(span ? all.slice(span[0], span[1] + 1).map((item) => item.id) : []);
  const doomed = all.filter((item) => !keep.has(item.id));
  for (const item of doomed) ctx.ks.sql.exec("DELETE FROM list_items WHERE id = ?", item.id);
  if (!doomed.length) return r.ok;
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(l.id, key, TYPE.list);
  return r.ok;
}

function lset(ctx: Ctx, [, key, indexArg, value]: Array<Uint8Array>): Reply {
  const index = int(indexArg);
  const l = list(ctx, key);
  if (!l) throw new RedisError("ERR no such key");
  const len = length(ctx, l);
  const i = index < 0 ? len + index : index;
  if (i < 0 || i >= len) throw new RedisError("ERR index out of range");
  checkSize(key, value);
  const [item] = items(ctx, l, i, 1);
  ctx.ks.sql.exec("UPDATE list_items SET value = ? WHERE id = ?", blob(value), item.id);
  ctx.ks.onChange(key);
  return r.ok;
}

function lindex(ctx: Ctx, [, key, indexArg]: Array<Uint8Array>): Reply {
  const index = int(indexArg);
  const l = list(ctx, key);
  if (!l) return r.nil;
  const i = index < 0 ? length(ctx, l) + index : index;
  if (i < 0) return r.nil;
  return r.bulk(items(ctx, l, i, 1)[0]?.value ?? null);
}

function lrange(ctx: Ctx, [, key, startArg, stopArg]: Array<Uint8Array>): Reply {
  const start = int(startArg);
  const stop = int(stopArg);
  const l = list(ctx, key);
  if (!l) return r.array([]);
  const span = range(length(ctx, l), start, stop);
  if (!span) return r.array([]);
  return r.bulks(items(ctx, l, span[0], span[1] - span[0] + 1).map((item) => item.value));
}

function llen(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const l = list(ctx, key);
  return r.int(l ? length(ctx, l) : 0);
}

function lmpop(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const { keys, end, count } = mpopArgs(args, 1);
  return mpop(ctx, keys, end, count) ?? r.nilArray;
}

function blmpop(ctx: Ctx, args: Array<Uint8Array>): Outcome {
  const timeout = timeoutArg(args[1]);
  const { keys, end, count } = mpopArgs(args, 2);
  return mpop(ctx, keys, end, count) ?? block(ctx, keys, timeout, r.nilArray);
}

function blockingMove(ctx: Ctx, source: Uint8Array, destination: Uint8Array, from: End, to: End, timeoutBytes: Uint8Array): Outcome {
  const timeout = timeoutArg(timeoutBytes);
  const value = move(ctx, source, destination, from, to);
  return value ? r.bulk(value) : block(ctx, [source], timeout, r.nil);
}

export const lists: Table = {
  lpush: spec(-3, ["write", "fast"], (ctx, args) => push(ctx, args, "left", false)),
  rpush: spec(-3, ["write", "fast"], (ctx, args) => push(ctx, args, "right", false)),
  lpushx: spec(-3, ["write", "fast"], (ctx, args) => push(ctx, args, "left", true)),
  rpushx: spec(-3, ["write", "fast"], (ctx, args) => push(ctx, args, "right", true)),
  lpop: spec(-2, ["write", "fast"], (ctx, args) => pop(ctx, args, "left")),
  rpop: spec(-2, ["write", "fast"], (ctx, args) => pop(ctx, args, "right")),
  llen: spec(2, ["readonly", "fast"], llen),
  lrange: spec(4, ["readonly"], lrange),
  lindex: spec(3, ["readonly"], lindex),
  lset: spec(4, ["write"], lset),
  linsert: spec(5, ["write"], linsert),
  lrem: spec(4, ["write"], lrem),
  ltrim: spec(4, ["write"], ltrim),
  lpos: spec(-3, ["readonly"], lpos),
  lmove: spec(5, ["write"], (ctx, [, source, destination, from, to]) => r.bulk(move(ctx, source, destination, endArg(from), endArg(to)) ?? null), [1, 2, 1]),
  rpoplpush: spec(3, ["write"], (ctx, [, source, destination]) => r.bulk(move(ctx, source, destination, "right", "left") ?? null), [1, 2, 1]),
  lmpop: keyless(-4, ["write"], lmpop),
  blpop: spec(-3, ["write", "blocking"], (ctx, args) => bpop(ctx, args, "left"), [1, -2, 1]),
  brpop: spec(-3, ["write", "blocking"], (ctx, args) => bpop(ctx, args, "right"), [1, -2, 1]),
  blmove: spec(6, ["write", "blocking"], (ctx, [, source, destination, from, to, timeout]) => blockingMove(ctx, source, destination, endArg(from), endArg(to), timeout), [1, 2, 1]),
  brpoplpush: spec(4, ["write", "blocking"], (ctx, [, source, destination, timeout]) => blockingMove(ctx, source, destination, "right", "left", timeout), [1, 2, 1]),
  blmpop: keyless(-5, ["write", "blocking"], blmpop),
};
