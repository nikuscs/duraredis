import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { xxh3Hex } from "../store/xxh3";
import { ERR, int, INT64_MAX, INT64_MIN, opt, toFloat, toInt64 } from "./args";
import { addFloats } from "./numbers";
import { conditionArg, EXPIRY_UNITS, expireAt, holds, VALUE_CONDITIONS } from "./strings";
import { keyless, spec } from "./types";
import type { Ctx, Table } from "./types";

const STRING_ONLY = "ERR Key should be of string type if conditions are specified";

function digest(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.getTyped(key, TYPE.string);
  return r.bulk(row ? xxh3Hex(row.value ?? new Uint8Array(0)) : null);
}

function delex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 2 && args.length !== 4) throw new RedisError("ERR wrong number of arguments for 'delex' command");
  const key = args[1];
  const row = ctx.ks.get(key);
  if (!row) return r.int(0);
  if (args.length === 2) return r.int(ctx.ks.delete(key) ? 1 : 0);
  if (row.type !== TYPE.string) throw new RedisError(STRING_ONLY);
  const kind = opt(args[2]);
  if (!VALUE_CONDITIONS.has(kind)) throw new RedisError("ERR Invalid condition. Use IFEQ, IFNE, IFDEQ, or IFDNE");
  if (!holds(conditionArg(kind, args[3]), row)) return r.int(0);
  ctx.ks.delete(key);
  return r.int(1);
}

function msetex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const raw = text(args[1]);
  const numkeys = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (numkeys <= 0) throw new RedisError("ERR invalid numkeys value");
  if (args.length < 2 + numkeys * 2) throw new RedisError("ERR wrong number of key-value pairs");
  let condition: string | undefined;
  let expiry: string | undefined;
  let at: number | null = null;
  for (let i = 2 + numkeys * 2; i < args.length; i++) {
    const o = opt(args[i]);
    const unit = EXPIRY_UNITS.get(o);
    if ((o === "NX" || o === "XX") && (!condition || condition === o)) condition = o;
    else if (o === "KEEPTTL" && (!expiry || expiry === o)) expiry = o;
    else if (unit && (!expiry || expiry === o) && i + 1 < args.length) {
      at = expireAt(ctx, unit, args[++i], "msetex");
      expiry = o;
    } else throw new RedisError(ERR.syntax);
  }
  const pairs = Array.from({ length: numkeys }, (_, i) => [args[2 + i * 2], args[3 + i * 2]] as const);
  if (condition === "NX" && pairs.some(([k]) => ctx.ks.exists(k))) return r.int(0);
  if (condition === "XX" && pairs.some(([k]) => !ctx.ks.exists(k))) return r.int(0);
  for (const [k, v] of pairs) ctx.ks.setString(k, v, at, expiry === "KEEPTTL");
  return r.int(1);
}

interface IncrexOptions {
  float: boolean;
  by: string;
  saturate: boolean;
  lower: string | undefined;
  upper: string | undefined;
  expiry: { kind: "at"; at: number } | { kind: "persist" } | undefined;
  enx: boolean;
}

function numberArg(b: Uint8Array, float: boolean, name: string): string {
  if (float && toFloat(b) !== undefined) return text(b);
  if (!float && toInt64(b) !== undefined) return text(b);
  throw new RedisError(float ? `ERR ${name} is not a valid float` : `ERR ${name} is not an integer or out of range`);
}

interface RawBounds {
  by?: Uint8Array;
  lower?: Uint8Array;
  upper?: Uint8Array;
}

function increxOptions(ctx: Ctx, args: Array<Uint8Array>): IncrexOptions {
  const options: IncrexOptions = { float: false, by: "1", saturate: false, lower: undefined, upper: undefined, expiry: undefined, enx: false };
  const raw: RawBounds = {};
  for (let i = 2; i < args.length; i++) {
    const o = opt(args[i]);
    const unit = EXPIRY_UNITS.get(o);
    const value = args[i + 1];
    if ((o === "BYINT" || o === "BYFLOAT") && !raw.by && value) {
      options.float = o === "BYFLOAT";
      raw.by = args[++i];
    } else if (o === "SATURATE") options.saturate = true;
    else if (o === "LBOUND" && value) raw.lower = args[++i];
    else if (o === "UBOUND" && value) raw.upper = args[++i];
    else if (o === "ENX") options.enx = true;
    else if (o === "PERSIST" && !options.expiry) options.expiry = { kind: "persist" };
    else if (unit && !options.expiry && value) options.expiry = { kind: "at", at: expireAt(ctx, unit, args[++i], "increx") };
    else throw new RedisError(ERR.syntax);
  }
  if (options.enx && options.expiry?.kind === "persist") throw new RedisError(ERR.syntax);
  if (options.enx && !options.expiry) throw new RedisError("ERR ENX flag requires an expiration");
  if (raw.by) options.by = numberArg(raw.by, options.float, "Increment");
  if (raw.lower) options.lower = numberArg(raw.lower, options.float, "LBOUND");
  if (raw.upper) options.upper = numberArg(raw.upper, options.float, "UBOUND");
  if (options.lower !== undefined && options.upper !== undefined && Number(options.lower) > Number(options.upper)) {
    throw new RedisError("ERR LBOUND can't be greater than UBOUND");
  }
  return options;
}

const negate = (s: string) => (s.startsWith("-") ? s.slice(1) : `-${s}`);

function nextInt(current: string, o: IncrexOptions): [string, boolean] {
  const lower = o.lower === undefined ? INT64_MIN : BigInt(o.lower);
  const upper = o.upper === undefined ? INT64_MAX : BigInt(o.upper);
  const next = BigInt(current) + BigInt(o.by);
  if (next >= lower && next <= upper) return [String(next), true];
  if (!o.saturate) return [current, false];
  return [String(next < lower ? lower : upper), true];
}

function nextFloat(current: string, o: IncrexOptions): [string, boolean] {
  const next = addFloats(current, o.by);
  const value = Number(next);
  if (o.lower !== undefined && value < Number(o.lower)) return o.saturate ? [addFloats(o.lower, "0"), true] : [current, false];
  if (o.upper !== undefined && value > Number(o.upper)) return o.saturate ? [addFloats(o.upper, "0"), true] : [current, false];
  return [next, true];
}

function increx(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const o = increxOptions(ctx, args);
  const row = ctx.ks.getTyped(key, TYPE.string);
  const stored = row ? text(row.value ?? new Uint8Array(0)) : "0";
  if (!o.float && toInt64(bytes(stored)) === undefined) throw new RedisError(ERR.int);
  if (o.float && toFloat(bytes(stored)) === undefined) throw new RedisError(ERR.float);
  const current = o.float ? addFloats(stored, "0") : stored;
  const [next, applied] = o.float ? nextFloat(current, o) : nextInt(current, o);
  const reply = (value: string, delta: string): Reply => (o.float ? r.array([r.double(Number(value)), r.double(Number(delta))]) : r.array([r.int(BigInt(value)), r.int(BigInt(delta))]));
  if (!applied) return reply(current, "0");
  const delta = o.float ? addFloats(next, negate(current)) : String(BigInt(next) - BigInt(current));
  const keepExpiry = !o.expiry || (o.enx && !!row && row.expiresAt !== null);
  const expiresAt = o.expiry?.kind === "at" ? o.expiry.at : null;
  ctx.ks.setString(key, bytes(next), keepExpiry ? null : expiresAt, keepExpiry);
  return reply(next, delta);
}

const LCS_MAX_CELLS = 8_000_000;

interface LcsOptions {
  idx: boolean;
  len: boolean;
  withLen: boolean;
  minLen: number;
}

function lcsOptions(args: Array<Uint8Array>): LcsOptions {
  const o: LcsOptions = { idx: false, len: false, withLen: false, minLen: 0 };
  for (let i = 3; i < args.length; i++) {
    const word = opt(args[i]);
    if (word === "IDX") o.idx = true;
    else if (word === "LEN") o.len = true;
    else if (word === "WITHMATCHLEN") o.withLen = true;
    else if (word === "MINMATCHLEN" && i + 1 < args.length) o.minLen = Math.max(int(args[++i]), 0);
    else throw new RedisError(ERR.syntax);
  }
  if (o.idx && o.len) throw new RedisError("ERR If you want both the length and indexes, please just use IDX.");
  return o;
}

function lcsValue(ctx: Ctx, key: Uint8Array): Uint8Array {
  const row = ctx.ks.get(key);
  if (row && row.type !== TYPE.string) throw new RedisError("ERR The specified keys must contain string values");
  return row?.value ?? new Uint8Array(0);
}

function lcs(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const a = lcsValue(ctx, args[1]);
  const b = lcsValue(ctx, args[2]);
  const o = lcsOptions(args);
  const width = b.length + 1;
  if ((a.length + 1) * width > LCS_MAX_CELLS) throw new RedisError("ERR Insufficient memory, transient memory for LCS exceeds proto-max-bulk-len");
  const dp = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => dp[i * width + j];
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * width + j] = a[i - 1] === b[j - 1] ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1));
    }
  }
  const total = at(a.length, b.length);
  if (o.len) return r.int(total);
  const result = new Uint8Array(total);
  const matches: Array<Reply> = [];
  let [i, j, k] = [a.length, b.length, total];
  let [aStart, aEnd, bStart, bEnd] = [a.length, 0, 0, 0];
  while (i > 0 && j > 0) {
    let emit = false;
    if (a[i - 1] === b[j - 1]) {
      result[k - 1] = a[i - 1];
      if (aStart === a.length) [aStart, aEnd, bStart, bEnd] = [i - 1, i - 1, j - 1, j - 1];
      else if (aStart === i && bStart === j) [aStart, bStart] = [aStart - 1, bStart - 1];
      else emit = true;
      if (aStart === 0 || bStart === 0) emit = true;
      [i, j, k] = [i - 1, j - 1, k - 1];
    } else {
      if (at(i - 1, j) > at(i, j - 1)) i--;
      else j--;
      if (aStart !== a.length) emit = true;
    }
    if (!emit) continue;
    const length = aEnd - aStart + 1;
    if (o.idx && length >= o.minLen) {
      const range = [r.array([r.int(aStart), r.int(aEnd)]), r.array([r.int(bStart), r.int(bEnd)])];
      matches.push(r.array(o.withLen ? [...range, r.int(length)] : range));
    }
    aStart = a.length;
  }
  if (!o.idx) return r.bulk(result);
  return r.map([[r.bulk("matches"), r.array(matches)], [r.bulk("len"), r.int(total)]]);
}

export const stringExtensions: Table = {
  digest: spec(2, ["readonly", "fast"], digest),
  delex: spec(-2, ["write", "fast"], delex),
  msetex: keyless(-4, ["write"], msetex),
  increx: spec(-2, ["write", "fast"], increx),
  lcs: spec(-3, ["readonly"], lcs, [1, 2, 1]),
};
