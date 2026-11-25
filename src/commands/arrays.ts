import { addBigFloat, bigFloatToInt64, cmpBigFloat, formatG17, parseLongDouble } from "../arrays/numeric";
import type { BigFloat } from "../arrays/numeric";
import { compileRegex } from "../arrays/regex";
import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { blob, checkSize, fromBlob, sameBytes } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, INT64_MAX, int64, opt } from "./args";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

const UINT64_MAX = (1n << 64n) - 1n;
const MAX_INDEX = UINT64_MAX - 1n;
const MAX_RANGE_ITEMS = 1_000_000n;
const SLICE_SIZE = 4096n;
const DIR_MAX = 2048n;

const ERR_INDEX = "ERR invalid array index";
const ERR_OVERFLOW = "ERR array index overflow";
const ERR_INSERT_OVERFLOW = "ERR insert index overflow";
const ERR_RANGE_MAX = "ERR range exceeds maximum of 1000000 items";

function encodeU64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, false);
  return b;
}

function decodeU64(v: ArrayBuffer | Uint8Array): bigint {
  const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, false);
}

const replyU64 = (n: bigint): Reply => (n <= INT64_MAX ? r.int(n) : r.bignum(n.toString()));

function parseIndex(b: Uint8Array, allowMax = false): bigint {
  if (b.includes(0)) throw new RedisError(ERR_INDEX);
  const m = /^[ \t\n\r\f\v]*([+-]?)(\d+)$/.exec(text(b));
  if (!m) throw new RedisError(ERR_INDEX);
  const n = BigInt(m[2]);
  if (m[1] === "-" && n !== 0n) throw new RedisError(ERR_INDEX);
  if (n > (allowMax ? UINT64_MAX : MAX_INDEX)) throw new RedisError(ERR_INDEX);
  return n;
}

const arrayRow = (ctx: Ctx, key: Uint8Array): KeyRow | undefined => ctx.ks.getTyped(key, TYPE.array);
const arrayCursor = (row: KeyRow | undefined): bigint => (row?.value ? decodeU64(row.value) : 0n);

function arrayLen(ctx: Ctx, id: number): bigint {
  const row = ctx.ks.sql.exec<{ m: ArrayBuffer | null }>("SELECT max(idx) AS m FROM array_items WHERE key_id = ?", id).one();
  return row.m ? decodeU64(row.m) + 1n : 0n;
}

function ensureKey(ctx: Ctx, key: Uint8Array, row: KeyRow | undefined): number {
  return row ? row.id : ctx.ks.create(key, TYPE.array, encodeU64(0n));
}

function getItem(ctx: Ctx, id: number, idx: bigint): Uint8Array | undefined {
  const row = ctx.ks.sql.exec<{ value: ArrayBuffer }>("SELECT value FROM array_items WHERE key_id = ? AND idx = ?", id, blob(encodeU64(idx))).toArray()[0];
  return row ? fromBlob(row.value) : undefined;
}

function upsertItem(ctx: Ctx, id: number, idx: bigint, value: Uint8Array): boolean {
  const idxBuf = encodeU64(idx);
  checkSize(idxBuf, value);
  const exists = ctx.ks.sql.exec("SELECT 1 FROM array_items WHERE key_id = ? AND idx = ? LIMIT 1", id, blob(idxBuf)).toArray().length > 0;
  ctx.ks.sql.exec("INSERT INTO array_items (key_id, idx, value) VALUES (?, ?, ?) ON CONFLICT (key_id, idx) DO UPDATE SET value = excluded.value",
    id, blob(idxBuf), blob(value));
  return !exists;
}

function validateSizes(values: Array<Uint8Array>) {
  const dummy = new Uint8Array(8);
  for (const v of values) checkSize(dummy, v);
}

function arcount(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  return r.int(ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM array_items WHERE key_id = ?", row.id).one().n);
}

function arlen(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  return replyU64(arrayLen(ctx, row.id));
}

function arnext(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  const cursor = arrayCursor(row);
  return cursor === UINT64_MAX ? r.nil : replyU64(cursor);
}

function arget(ctx: Ctx, [, key, idxArg]: Array<Uint8Array>): Reply {
  const row = arrayRow(ctx, key);
  const idx = parseIndex(idxArg);
  if (!row) return r.nil;
  return r.bulk(getItem(ctx, row.id, idx) ?? null);
}

function armget(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const row = arrayRow(ctx, args[1]);
  const indices = args.slice(2).map((a) => parseIndex(a));
  if (!row) return r.bulks(indices.map(() => null));
  return r.bulks(indices.map((idx) => getItem(ctx, row.id, idx) ?? null));
}

function arset(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const start = parseIndex(args[2]);
  const values = args.slice(3);
  if (start + BigInt(values.length) > UINT64_MAX) throw new RedisError(ERR_OVERFLOW);
  const row = arrayRow(ctx, key);
  validateSizes(values);
  const id = ensureKey(ctx, key, row);
  let created = 0;
  for (let i = 0; i < values.length; i++) {
    if (upsertItem(ctx, id, start + BigInt(i), values[i])) created++;
  }
  ctx.ks.onChange(key);
  return r.int(created);
}

function armset(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length % 2 !== 0) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const pairs: Array<[bigint, Uint8Array]> = [];
  for (let i = 2; i < args.length; i += 2) pairs.push([parseIndex(args[i]), args[i + 1]]);
  const key = args[1];
  const row = arrayRow(ctx, key);
  validateSizes(pairs.map((p) => p[1]));
  const id = ensureKey(ctx, key, row);
  let created = 0;
  for (const [idx, val] of pairs) {
    if (upsertItem(ctx, id, idx, val)) created++;
  }
  ctx.ks.onChange(key);
  return r.int(created);
}

function ardel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const indices = args.slice(2).map((a) => parseIndex(a));
  const key = args[1];
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  let removed = 0;
  for (const idx of indices) {
    removed += ctx.ks.sql.exec("DELETE FROM array_items WHERE key_id = ? AND idx = ? RETURNING 1", row.id, blob(encodeU64(idx))).toArray().length;
  }
  if (!removed) return r.int(0);
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(row.id, key, TYPE.array);
  return r.int(removed);
}

function ardelrange(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length % 2 !== 0) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const ranges: Array<[bigint, bigint]> = [];
  for (let i = 2; i < args.length; i += 2) {
    const a = parseIndex(args[i]);
    const b = parseIndex(args[i + 1]);
    ranges.push(a <= b ? [a, b] : [b, a]);
  }
  const key = args[1];
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  let removed = 0;
  for (const [lo, hi] of ranges) {
    removed += ctx.ks.sql.exec("DELETE FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? RETURNING 1",
      row.id, blob(encodeU64(lo)), blob(encodeU64(hi))).toArray().length;
  }
  if (!removed) return r.int(0);
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(row.id, key, TYPE.array);
  return r.int(removed);
}

function argetrange(ctx: Ctx, [, key, startArg, endArg]: Array<Uint8Array>): Reply {
  const start = parseIndex(startArg);
  const end = parseIndex(endArg);
  const row = arrayRow(ctx, key);
  const reverse = start > end;
  const lo = reverse ? end : start;
  const hi = reverse ? start : end;
  const span = hi - lo + 1n;
  if (span > MAX_RANGE_ITEMS) throw new RedisError(ERR_RANGE_MAX);
  const out = Array.from<Reply>({ length: Number(span) }).fill(r.nil);
  if (!row) return r.array(out);
  const rows = ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
    "SELECT idx, value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ?",
    row.id, blob(encodeU64(lo)), blob(encodeU64(hi))).toArray();
  for (const item of rows) {
    const idx = decodeU64(item.idx);
    out[Number(reverse ? hi - idx : idx - lo)] = r.bulk(fromBlob(item.value));
  }
  return r.array(out);
}

function arinsert(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const values = args.slice(2);
  const row = arrayRow(ctx, key);
  const cursor = arrayCursor(row);
  const count = BigInt(values.length);
  if (cursor === UINT64_MAX || cursor + count > UINT64_MAX) throw new RedisError(ERR_INSERT_OVERFLOW);
  validateSizes(values);
  const id = ensureKey(ctx, key, row);
  for (let i = 0; i < values.length; i++) upsertItem(ctx, id, cursor + BigInt(i), values[i]);
  ctx.ks.updateValue(id, key, encodeU64(cursor + count));
  return replyU64(cursor + count - 1n);
}

function arseek(ctx: Ctx, [, key, targetArg]: Array<Uint8Array>): Reply {
  const target = parseIndex(targetArg, true);
  const row = arrayRow(ctx, key);
  if (!row) return r.int(0);
  ctx.ks.updateValue(row.id, key, encodeU64(target));
  return r.int(1);
}

function arlastitems(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 4) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const count = int64(args[2], "ERR invalid COUNT");
  const rev = args.length === 4;
  if (rev && opt(args[3]) !== "REV") throw new RedisError(ERR.syntax);
  const row = arrayRow(ctx, args[1]);
  if (!row || count <= 0n) return r.array([]);
  const len = arrayLen(ctx, row.id);
  if (len === 0n) return r.array([]);
  const n = count < len ? count : len;
  if (n > MAX_RANGE_ITEMS) throw new RedisError("ERR count exceeds maximum of 1000000 items");
  const cursor = arrayCursor(row);
  const end = cursor === 0n || cursor > len ? len : cursor;
  const map = new Map<bigint, Uint8Array>();
  const load = (lo: bigint, hi: bigint) => {
    const rows = ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
      "SELECT idx, value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ?",
      row.id, blob(encodeU64(lo)), blob(encodeU64(hi))).toArray();
    for (const item of rows) map.set(decodeU64(item.idx), fromBlob(item.value));
  };
  if (n <= end) {
    load(end - n, end - 1n);
  } else {
    if (end > 0n) load(0n, end - 1n);
    load(len - (n - end), len - 1n);
  }
  const out: Array<Reply> = [];
  for (let i = 0n; i < n; i++) {
    const idx = rev ? (end - 1n - i + len) % len : (end - n + i + len) % len;
    out.push(r.bulk(map.get(idx) ?? null));
  }
  return r.array(out);
}

function arring(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const size = int64(args[2], "ERR invalid size");
  if (size <= 0n) throw new RedisError("ERR size must be positive");
  const key = args[1];
  const values = args.slice(3);
  const row = arrayRow(ctx, key);
  validateSizes(values);
  const id = ensureKey(ctx, key, row);
  let cursor = arrayCursor(row);
  const len = row ? arrayLen(ctx, id) : 0n;
  if (len > size || (len > 0n && len < size && cursor > 0n && cursor < len)) {
    const maxKeep = len < size ? len : size;
    const limitNum = Number(maxKeep > 1_000_000_000n ? 1_000_000_000n : maxKeep);
    const pos = cursor % len;
    const startIdx = pos === 0n ? len - 1n : pos - 1n;
    const kept: Array<Uint8Array> = [];
    let expected = startIdx;
    let hitGap = false;
    const q1 = ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
      "SELECT idx, value FROM array_items WHERE key_id = ? AND idx <= ? ORDER BY idx DESC LIMIT ?",
      id, blob(encodeU64(startIdx)), limitNum).toArray();
    for (const item of q1) {
      if (decodeU64(item.idx) !== expected) {
        hitGap = true;
        break;
      }
      kept.push(fromBlob(item.value));
      expected -= 1n;
    }
    if (q1.length === 0) hitGap = true;
    if (!hitGap && expected < 0n && BigInt(kept.length) < maxKeep && startIdx < len - 1n) {
      const rem = Number(maxKeep - BigInt(kept.length));
      const q2 = ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
        "SELECT idx, value FROM array_items WHERE key_id = ? AND idx > ? AND idx < ? ORDER BY idx DESC LIMIT ?",
        id, blob(encodeU64(startIdx)), blob(encodeU64(len)), rem).toArray();
      let exp2 = len - 1n;
      for (const item of q2) {
        if (decodeU64(item.idx) !== exp2) break;
        kept.push(fromBlob(item.value));
        exp2 -= 1n;
      }
    }
    kept.reverse();
    ctx.ks.sql.exec("DELETE FROM array_items WHERE key_id = ?", id);
    for (let i = 0; i < kept.length; i++) upsertItem(ctx, id, BigInt(i), kept[i]);
    cursor = BigInt(kept.length);
  }
  const writes = new Map<bigint, Uint8Array>();
  let lastWritten = 0n;
  for (const val of values) {
    if (cursor >= size) cursor %= size;
    writes.set(cursor, val);
    lastWritten = cursor;
    cursor += 1n;
  }
  for (const [idx, val] of writes) upsertItem(ctx, id, idx, val);
  ctx.ks.updateValue(id, key, encodeU64(cursor));
  return replyU64(lastWritten);
}

function arscan(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 4 && args.length !== 6) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const start = parseIndex(args[2]);
  const end = parseIndex(args[3]);
  let limit: bigint | undefined;
  if (args.length === 6) {
    if (opt(args[4]) !== "LIMIT") throw new RedisError(ERR.syntax);
    limit = int64(args[5]);
    if (limit <= 0n) throw new RedisError("ERR LIMIT must be positive");
  }
  const row = arrayRow(ctx, args[1]);
  if (!row) return r.array([]);
  const reverse = start > end;
  const lo = reverse ? end : start;
  const hi = reverse ? start : end;
  const order = reverse ? "DESC" : "ASC";
  const rows = limit === undefined
    ? ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
      `SELECT idx, value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? ORDER BY idx ${order}`,
      row.id, blob(encodeU64(lo)), blob(encodeU64(hi))).toArray()
    : ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
      `SELECT idx, value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? ORDER BY idx ${order} LIMIT ?`,
      row.id, blob(encodeU64(lo)), blob(encodeU64(hi)), Number(limit > 1_000_000_000n ? 1_000_000_000n : limit)).toArray();
  return r.array(rows.map((item) => r.array([replyU64(decodeU64(item.idx)), r.bulk(fromBlob(item.value))])));
}

const AROP_OPS = new Set(["SUM", "MIN", "MAX", "AND", "OR", "XOR", "USED"]);

function arop(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const start = parseIndex(args[2]);
  const end = parseIndex(args[3]);
  const op = opt(args[4]);
  if (op === "MATCH") {
    if (args.length !== 6) throw new RedisError("ERR MATCH requires a value argument");
  } else if (AROP_OPS.has(op)) {
    if (args.length !== 5) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  } else {
    throw new RedisError("ERR unknown operation");
  }
  const row = arrayRow(ctx, args[1]);
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  if (!row) return op === "USED" || op === "MATCH" ? r.int(0) : r.nil;
  const loBlob = blob(encodeU64(lo));
  const hiBlob = blob(encodeU64(hi));
  if (op === "USED") {
    return r.int(ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ?", row.id, loBlob, hiBlob).one().n);
  }
  if (op === "MATCH") {
    return r.int(ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? AND value = ?",
      row.id, loBlob, hiBlob, blob(args[5])).one().n);
  }
  const rows = ctx.ks.sql.exec<{ value: ArrayBuffer }>(
    "SELECT value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? ORDER BY idx ASC", row.id, loBlob, hiBlob).toArray();
  if (op === "SUM" || op === "MIN" || op === "MAX") {
    let acc: BigFloat | undefined;
    for (const item of rows) {
      const v = parseLongDouble(fromBlob(item.value));
      if (!v) continue;
      if (!acc) acc = v;
      else if (op === "SUM") acc = addBigFloat(acc, v);
      else if ((op === "MIN" && cmpBigFloat(v, acc) < 0) || (op === "MAX" && cmpBigFloat(v, acc) > 0)) acc = v;
    }
    return acc ? r.bulk(formatG17(acc)) : r.nil;
  }
  let acc: bigint | undefined;
  for (const item of rows) {
    const ld = parseLongDouble(fromBlob(item.value));
    const n = ld ? bigFloatToInt64(ld) : undefined;
    if (n === undefined) continue;
    if (acc === undefined) acc = n;
    else if (op === "AND") acc &= n;
    else if (op === "OR") acc |= n;
    else acc ^= n;
  }
  return acc === undefined ? r.nil : r.int(BigInt.asIntN(64, acc));
}

type GrepBound = "min" | "max" | bigint;
type PredKind = "EXACT" | "MATCH" | "GLOB" | "RE";

function parseGrepBound(b: Uint8Array): GrepBound {
  if (b.length === 1 && b[0] === 0x2d) return "min";
  if (b.length === 1 && b[0] === 0x2b) return "max";
  return parseIndex(b);
}

function asciiLower(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    out[i] = c >= 65 && c <= 90 ? c + 32 : c;
  }
  return out;
}

function bytesIncludes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  const end = haystack.length - needle.length;
  for (let i = 0; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function compilePredicate(kind: PredKind, pattern: Uint8Array, nocase: boolean): (val: Uint8Array) => boolean {
  if (kind === "RE") return compileRegex(pattern, nocase);
  if (kind === "GLOB") return (val) => (val.length === 0 ? pattern.length === 0 : globMatch(pattern, val, nocase));
  const pat = nocase ? asciiLower(pattern) : pattern;
  if (kind === "EXACT") return (val) => sameBytes(nocase ? asciiLower(val) : val, pat);
  return (val) => bytesIncludes(nocase ? asciiLower(val) : val, pat);
}

function argrep(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const startBound = parseGrepBound(args[2]);
  const endBound = parseGrepBound(args[3]);
  const rawPreds: Array<{ kind: PredKind; pattern: Uint8Array }> = [];
  let mode: "AND" | "OR" = "AND";
  let nocase = false;
  let withValues = false;
  let limit: bigint | undefined;

  for (let i = 4; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "EXACT" || o === "MATCH" || o === "GLOB" || o === "RE") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      rawPreds.push({ kind: o, pattern: args[++i] });
    } else if (o === "AND" || o === "OR") {
      mode = o;
    } else if (o === "NOCASE") {
      nocase = true;
    } else if (o === "WITHVALUES") {
      withValues = true;
    } else if (o === "LIMIT") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      limit = int64(args[++i]);
      if (limit <= 0n) throw new RedisError("ERR LIMIT must be positive");
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  if (rawPreds.length === 0) throw new RedisError(ERR.syntax);
  const preds = rawPreds.map((p) => compilePredicate(p.kind, p.pattern, nocase));
  const row = arrayRow(ctx, args[1]);
  if (!row) return r.array([]);
  const len = arrayLen(ctx, row.id);
  if (len === 0n) return r.array([]);
  const maxIdx = len - 1n;
  const start = startBound === "min" ? 0n : startBound === "max" ? maxIdx : startBound;
  const end = endBound === "min" ? 0n : endBound === "max" ? maxIdx : endBound;
  const reverse = start > end;
  const lo = reverse ? end : start;
  const hi = reverse ? start : end;
  const rows = ctx.ks.sql.exec<{ idx: ArrayBuffer; value: ArrayBuffer }>(
    `SELECT idx, value FROM array_items WHERE key_id = ? AND idx >= ? AND idx <= ? ORDER BY idx ${reverse ? "DESC" : "ASC"}`,
    row.id, blob(encodeU64(lo)), blob(encodeU64(hi))).toArray();
  const out: Array<Reply> = [];
  for (const item of rows) {
    const val = fromBlob(item.value);
    const matched = mode === "AND" ? preds.every((fn) => fn(val)) : preds.some((fn) => fn(val));
    if (!matched) continue;
    const idx = decodeU64(item.idx);
    out.push(withValues ? r.array([replyU64(idx), r.bulk(val)]) : replyU64(idx));
    if (limit !== undefined && BigInt(out.length) >= limit) break;
  }
  return r.array(out);
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function arinfo(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3 || (args.length === 3 && opt(args[2]) !== "FULL")) throw new RedisError(ERR.syntax);
  const full = args.length === 3;
  const row = arrayRow(ctx, args[1]);
  if (!row) throw new RedisError("ERR no such key");
  const rows = ctx.ks.sql.exec<{ idx: ArrayBuffer }>("SELECT idx FROM array_items WHERE key_id = ? ORDER BY idx ASC", row.id).toArray();
  const count = rows.length;
  const maxIdx = count > 0 ? decodeU64(rows[count - 1].idx) : 0n;
  const len = count > 0 ? maxIdx + 1n : 0n;
  const cursor = arrayCursor(row);
  const nextInsert = cursor === UINT64_MAX ? 0n : cursor;
  const sliceMap = new Map<bigint, { count: number; minOff: number; maxOff: number }>();
  for (const item of rows) {
    const idx = decodeU64(item.idx);
    const sliceId = idx >> 12n;
    const off = Number(idx & 4095n);
    const cur = sliceMap.get(sliceId);
    if (!cur) {
      sliceMap.set(sliceId, { count: 1, minOff: off, maxOff: off });
    } else {
      cur.count++;
      if (off < cur.minOff) cur.minOff = off;
      if (off > cur.maxOff) cur.maxOff = off;
    }
  }
  const maxSlice = maxIdx >> 12n;
  let superDirEntries = 0;
  let directorySize: number;
  if (maxSlice < DIR_MAX) {
    directorySize = nextPow2(Number(maxSlice) + 1);
  } else {
    superDirEntries = new Set([...sliceMap.keys()].map((s) => s >> 11n)).size;
    directorySize = Math.max(4, nextPow2(superDirEntries));
  }
  const entries: Array<[Reply, Reply]> = [
    [r.bulk("count"), r.int(count)],
    [r.bulk("len"), replyU64(len)],
    [r.bulk("next-insert-index"), replyU64(nextInsert)],
    [r.bulk("slices"), r.int(sliceMap.size)],
    [r.bulk("directory-size"), r.int(directorySize)],
    [r.bulk("super-dir-entries"), r.int(superDirEntries)],
    [r.bulk("slice-size"), r.int(SLICE_SIZE)],
  ];
  if (!full) return r.map(entries);
  let denseSlices = 0;
  let sparseSlices = 0;
  let denseSizeSum = 0;
  let denseFillSum = 0;
  let sparseSizeSum = 0;
  for (const s of sliceMap.values()) {
    if (s.count <= 10) {
      sparseSlices++;
      sparseSizeSum += s.count <= 4 ? 4 : s.count <= 8 ? 8 : 10;
    } else {
      denseSlices++;
      const size = Math.min(4096, nextPow2(Math.max(16, s.maxOff - s.minOff + 1)));
      denseSizeSum += size;
      denseFillSum += s.count / size;
    }
  }
  entries.push(
    [r.bulk("dense-slices"), r.int(denseSlices)],
    [r.bulk("sparse-slices"), r.int(sparseSlices)],
    [r.bulk("avg-dense-size"), r.double(denseSlices > 0 ? denseSizeSum / denseSlices : 0)],
    [r.bulk("avg-dense-fill"), r.double(denseSlices > 0 ? denseFillSum / denseSlices : 0)],
    [r.bulk("avg-sparse-size"), r.double(sparseSlices > 0 ? sparseSizeSum / sparseSlices : 0)],
  );
  return r.map(entries);
}

export const arrays: Table = {
  arcount: spec(2, ["readonly", "fast"], arcount),
  ardel: spec(-3, ["write", "fast"], ardel),
  ardelrange: spec(-4, ["write"], ardelrange),
  arget: spec(3, ["readonly", "fast"], arget),
  argetrange: spec(4, ["readonly"], argetrange),
  argrep: spec(-6, ["readonly"], argrep),
  arinfo: spec(-2, ["readonly"], arinfo),
  arinsert: spec(-3, ["write", "fast"], arinsert),
  arlastitems: spec(-3, ["readonly"], arlastitems),
  arlen: spec(2, ["readonly", "fast"], arlen),
  armget: spec(-3, ["readonly", "fast"], armget),
  armset: spec(-4, ["write", "fast"], armset),
  arnext: spec(2, ["readonly", "fast"], arnext),
  arop: spec(-5, ["readonly"], arop),
  arring: spec(-4, ["write"], arring),
  arscan: spec(-4, ["readonly"], arscan),
  arseek: spec(3, ["write", "fast"], arseek),
  arset: spec(-4, ["write", "fast"], arset),
};
