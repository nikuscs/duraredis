import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { fromBlob } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, int, opt, toFloat } from "./args";
import { setOrder } from "./sets";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

interface SortOptions {
  by: Uint8Array | undefined;
  offset: number;
  count: number;
  limited: boolean;
  gets: Array<Uint8Array>;
  desc: boolean;
  alpha: boolean;
  store: Uint8Array | undefined;
}

interface Item {
  value: Uint8Array;
  score: number;
  weight: Uint8Array | null;
}

const STAR = 42;
const SCORE_ERROR = "ERR One or more scores can't be converted into double";

function sortOptions(args: Array<Uint8Array>, readOnly: boolean): SortOptions {
  const o: SortOptions = { by: undefined, offset: 0, count: -1, limited: false, gets: [], desc: false, alpha: false, store: undefined };
  for (let i = 2; i < args.length; i++) {
    const word = opt(args[i]);
    const left = args.length - i - 1;
    if (word === "ASC") o.desc = false;
    else if (word === "DESC") o.desc = true;
    else if (word === "ALPHA") o.alpha = true;
    else if (word === "LIMIT" && left >= 2) {
      o.offset = int(args[++i]);
      o.count = int(args[++i]);
      o.limited = true;
    } else if (word === "STORE" && left >= 1 && !readOnly) o.store = args[++i];
    else if (word === "BY" && left >= 1) o.by = args[++i];
    else if (word === "GET" && left >= 1) o.gets.push(args[++i]);
    else throw new RedisError(ERR.syntax);
  }
  return o;
}

function elements(ctx: Ctx, row: KeyRow): Array<Uint8Array> {
  if (row.type === TYPE.list) {
    return ctx.ks.sql.exec<{ value: ArrayBuffer }>("SELECT value FROM list_items WHERE key_id = ? ORDER BY pos", row.id).toArray().map((x) => fromBlob(x.value));
  }
  if (row.type === TYPE.set) {
    return setOrder(ctx.ks.sql.exec<{ member: ArrayBuffer }>("SELECT member FROM set_members WHERE key_id = ? ORDER BY id", row.id).toArray().map((x) => fromBlob(x.member)));
  }
  return ctx.ks.sql.exec<{ member: ArrayBuffer }>("SELECT member FROM zset_members WHERE key_id = ? ORDER BY score, member", row.id).toArray().map((x) => fromBlob(x.member));
}

function concat(...parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function lookup(ctx: Ctx, pattern: Uint8Array, element: Uint8Array): Uint8Array | null {
  if (pattern.length === 1 && pattern[0] === 35) return element;
  const star = pattern.indexOf(STAR);
  if (star < 0) return null;
  const rest = pattern.subarray(star + 1);
  const arrow = text(rest).indexOf("->");
  const fieldAt = arrow >= 0 ? bytes(text(rest).slice(0, arrow)).length : -1;
  const hasField = fieldAt >= 0 && fieldAt + 2 < rest.length;
  const key = concat(pattern.subarray(0, star), element, hasField ? rest.subarray(0, fieldAt) : rest);
  const row = ctx.ks.get(key);
  if (!row) return null;
  if (!hasField) return row.type === TYPE.string ? (row.value ?? new Uint8Array(0)) : null;
  if (row.type !== TYPE.hash) return null;
  const field = rest.subarray(fieldAt + 2);
  const found = ctx.ks.sql.exec<{ value: ArrayBuffer }>("SELECT value FROM hash_fields WHERE key_id = ? AND field = ?", row.id, field.slice().buffer).toArray()[0];
  return found ? fromBlob(found.value) : null;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function numeric(b: Uint8Array): number {
  const n = toFloat(b);
  if (n === undefined) throw new RedisError(SCORE_ERROR);
  return n;
}

function compare(o: SortOptions) {
  return (x: Item, y: Item): number => {
    const cmp = !o.alpha
      ? (x.score > y.score ? 1 : x.score < y.score ? -1 : compareBytes(x.value, y.value))
      : o.by
        ? (x.weight === null || y.weight === null ? (x.weight === y.weight ? 0 : x.weight === null ? -1 : 1) : compareBytes(x.weight, y.weight))
        : compareBytes(x.value, y.value);
    return o.desc ? -cmp : cmp;
  };
}

function sort(ctx: Ctx, args: Array<Uint8Array>, readOnly: boolean): Reply {
  const o = sortOptions(args, readOnly);
  const row = ctx.ks.get(args[1]);
  if (row && row.type !== TYPE.list && row.type !== TYPE.set && row.type !== TYPE.zset) {
    throw new RedisError("WRONGTYPE Operation against a key holding the wrong kind of value");
  }
  let dontSort = !!o.by && !o.by.includes(STAR);
  if (dontSort && row?.type === TYPE.set && o.store) {
    dontSort = false;
    o.alpha = true;
    o.by = undefined;
  }
  const values = row ? elements(ctx, row) : [];
  const items: Array<Item> = values.map((value) => {
    const weight = o.by && !dontSort ? lookup(ctx, o.by, value) : null;
    const numericSource = o.by ? weight : value;
    const score = !o.alpha && !dontSort && numericSource ? numeric(numericSource) : 0;
    return { value, score, weight };
  });
  const ordered = row?.type !== TYPE.set && o.desc ? items.toReversed() : items;
  const sorted = dontSort ? ordered : items.toSorted(compare(o));
  const start = Math.max(o.offset, 0);
  const end = o.limited && o.count >= 0 ? start + o.count : sorted.length;
  const page = o.limited ? sorted.slice(start, end) : sorted;
  const output = o.gets.length ? page.flatMap((item) => o.gets.map((g) => lookup(ctx, g, item.value))) : page.map((item) => item.value);
  if (!o.store) return r.bulks(output);
  ctx.ks.delete(o.store);
  if (!output.length) return r.int(0);
  const id = ctx.ks.create(o.store, TYPE.list);
  output.forEach((v, pos) => ctx.ks.sql.exec("INSERT INTO list_items (key_id, pos, value) VALUES (?, ?, ?)", id, pos, (v ?? new Uint8Array(0)).slice().buffer));
  return r.int(output.length);
}

export const sorting: Table = {
  sort: spec(-2, ["write"], (ctx, args) => sort(ctx, args, false)),
  sort_ro: spec(-2, ["readonly"], (ctx, args) => sort(ctx, args, true)),
};
