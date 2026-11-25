import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { sameBytes, WRONGTYPE } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { xxh3Hex } from "../store/xxh3";
import { TYPE } from "../store/schema";
import { ERR, float, INT64_MAX, INT64_MIN, int, int64, opt, toInt64 } from "./args";
import { addFloats } from "./numbers";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

const MAX_STRING = 512 * 1024 * 1024;
const TOO_BIG = "ERR string exceeds maximum allowed size (proto-max-bulk-len)";
export const EXPIRY_UNITS = new Map(Object.entries({
  EX: { ms: 1000, absolute: false },
  PX: { ms: 1, absolute: false },
  EXAT: { ms: 1000, absolute: true },
  PXAT: { ms: 1, absolute: true },
}));

const str = (ctx: Ctx, key: Uint8Array) => ctx.ks.getTyped(key, TYPE.string);
const valueOf = (row: KeyRow | undefined) => row?.value ?? new Uint8Array(0);

export function expireAt(ctx: Ctx, unit: { ms: number; absolute: boolean }, arg: Uint8Array, command: string): number {
  const { ms, absolute } = unit;
  const n = int(arg);
  const at = absolute ? n * ms : ctx.now + n * ms;
  if (n <= 0 || !Number.isSafeInteger(at)) throw new RedisError(`ERR invalid expire time in '${command}' command`);
  return at;
}

function write(ctx: Ctx, key: Uint8Array, row: KeyRow | undefined, value: Uint8Array) {
  if (row) ctx.ks.updateValue(row.id, key, value);
  else ctx.ks.create(key, TYPE.string, value);
}

interface Condition {
  kind: string;
  value: Uint8Array;
}

export const VALUE_CONDITIONS = new Set(["IFEQ", "IFNE", "IFDEQ", "IFDNE"]);

export function digestArg(b: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{16}$/i.test(text(b))) throw new RedisError("ERR must be exactly 16 hexadecimal characters");
  return bytes(text(b).toLowerCase());
}

export function conditionArg(kind: string, value: Uint8Array): Condition {
  return { kind, value: kind === "IFDEQ" || kind === "IFDNE" ? digestArg(value) : value };
}

export function holds(condition: Condition | undefined, old: KeyRow | undefined): boolean {
  if (!condition) return true;
  if (condition.kind === "NX") return !old;
  if (condition.kind === "XX") return !!old;
  if (old && old.type !== TYPE.string) throw new RedisError(WRONGTYPE);
  const current = old ? valueOf(old) : undefined;
  const equal = (target: Uint8Array) => !!current && sameBytes(current, target);
  const digestEqual = (target: Uint8Array) => !!current && text(target) === xxh3Hex(current);
  if (condition.kind === "IFEQ") return equal(condition.value);
  if (condition.kind === "IFNE") return !equal(condition.value);
  if (condition.kind === "IFDEQ") return digestEqual(condition.value);
  return !digestEqual(condition.value);
}

function set(ctx: Ctx, args: Array<Uint8Array>, command = "set"): Reply {
  const [, key, value] = args;
  let condition: Condition | undefined;
  let get = false;
  let keepTtl = false;
  let expiry = false;
  let at: number | null = null;
  for (let i = 3; i < args.length; i++) {
    const o = opt(args[i]);
    const unit = EXPIRY_UNITS.get(o);
    if ((o === "NX" || o === "XX") && !condition) condition = { kind: o, value: new Uint8Array(0) };
    else if (VALUE_CONDITIONS.has(o) && !condition && i + 1 < args.length) condition = conditionArg(o, args[++i]);
    else if (o === "GET") get = true;
    else if (o === "KEEPTTL" && !expiry) keepTtl = expiry = true;
    else if (unit && !expiry && i + 1 < args.length) {
      at = expireAt(ctx, unit, args[++i], command);
      expiry = true;
    } else throw new RedisError(ERR.syntax);
  }
  const old = get ? str(ctx, key) : ctx.ks.get(key);
  const previous = get ? r.bulk(old?.value ?? null) : undefined;
  if (!holds(condition, old)) return previous ?? r.nil;
  ctx.ks.setString(key, value, at, keepTtl);
  return previous ?? r.ok;
}

function getex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  let persist = false;
  let at: number | null = null;
  for (let i = 2; i < args.length; i++) {
    const o = opt(args[i]);
    const unit = EXPIRY_UNITS.get(o);
    const chosen = persist || at !== null;
    if (o === "PERSIST" && !chosen) persist = true;
    else if (unit && !chosen && i + 1 < args.length) at = expireAt(ctx, unit, args[++i], "getex");
    else throw new RedisError(ERR.syntax);
  }
  const row = str(ctx, key);
  if (!row) return r.nil;
  if (persist && row.expiresAt !== null) ctx.ks.setExpiry(row.id, key, null);
  if (at !== null && at <= ctx.now) ctx.ks.delete(key);
  if (at !== null && at > ctx.now) ctx.ks.setExpiry(row.id, key, at);
  return r.bulk(row.value);
}

function getRange(ctx: Ctx, [, key, startArg, endArg]: Array<Uint8Array>): Reply {
  let start = int(startArg);
  let end = int(endArg);
  const v = valueOf(str(ctx, key));
  if (start < 0 && end < 0 && start > end) return r.bulk("");
  if (start < 0) start = Math.max(v.length + start, 0);
  if (end < 0) end = Math.max(v.length + end, 0);
  end = Math.min(end, v.length - 1);
  if (start > end || !v.length) return r.bulk("");
  return r.bulk(v.subarray(start, end + 1));
}

function incrBy(ctx: Ctx, key: Uint8Array, by: bigint): Reply {
  const row = str(ctx, key);
  const current = row ? toInt64(valueOf(row)) : 0n;
  if (current === undefined) throw new RedisError(ERR.int);
  const next = current + by;
  if (next > INT64_MAX || next < INT64_MIN) throw new RedisError(ERR.overflow);
  write(ctx, key, row, bytes(String(next)));
  return r.int(next);
}

function incrByFloat(ctx: Ctx, [, key, by]: Array<Uint8Array>): Reply {
  const row = str(ctx, key);
  const current = row ? valueOf(row) : bytes("0");
  float(current);
  if (!Number.isFinite(float(by))) throw new RedisError(ERR.nanInf);
  const value = bytes(addFloats(text(current), text(by)));
  write(ctx, key, row, value);
  return r.bulk(value);
}

function mset(ctx: Ctx, args: Array<Uint8Array>, nx: boolean): Reply {
  if (args.length % 2 === 0) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const pairs = Array.from({ length: (args.length - 1) / 2 }, (_, i) => [args[1 + i * 2], args[2 + i * 2]] as const);
  if (nx && pairs.some(([k]) => ctx.ks.exists(k))) return r.int(0);
  for (const [k, v] of pairs) ctx.ks.setString(k, v);
  return nx ? r.int(1) : r.ok;
}

function append(ctx: Ctx, [, key, value]: Array<Uint8Array>): Reply {
  const row = str(ctx, key);
  const old = valueOf(row);
  if (old.length + value.length > MAX_STRING) throw new RedisError(TOO_BIG);
  const next = new Uint8Array(old.length + value.length);
  next.set(old);
  next.set(value, old.length);
  write(ctx, key, row, next);
  return r.int(next.length);
}

function setRange(ctx: Ctx, [, key, offsetArg, value]: Array<Uint8Array>): Reply {
  const offset = int(offsetArg);
  if (offset < 0) throw new RedisError("ERR offset is out of range");
  const row = str(ctx, key);
  const old = valueOf(row);
  if (!value.length) return r.int(old.length);
  if (offset + value.length > MAX_STRING) throw new RedisError(TOO_BIG);
  const next = new Uint8Array(Math.max(old.length, offset + value.length));
  next.set(old);
  next.set(value, offset);
  write(ctx, key, row, next);
  return r.int(next.length);
}

function getdel(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = str(ctx, key);
  if (!row) return r.nil;
  ctx.ks.delete(key);
  return r.bulk(row.value);
}

function setnx(ctx: Ctx, [, key, value]: Array<Uint8Array>): Reply {
  if (ctx.ks.exists(key)) return r.int(0);
  ctx.ks.setString(key, value);
  return r.int(1);
}

function decrBy(ctx: Ctx, [, key, by]: Array<Uint8Array>): Reply {
  const n = int64(by);
  if (n === INT64_MIN) throw new RedisError("ERR decrement would overflow");
  return incrBy(ctx, key, -n);
}

function mget(ctx: Ctx, args: Array<Uint8Array>): Reply {
  return r.bulks(args.slice(1).map((k) => {
    const row = ctx.ks.get(k);
    return row?.type === TYPE.string ? row.value : null;
  }));
}

export const strings: Table = {
  get: spec(2, ["readonly", "fast"], (ctx, [, key]) => r.bulk(str(ctx, key)?.value ?? null)),
  set: spec(-3, ["write"], (ctx, args) => set(ctx, args)),
  setnx: spec(3, ["write", "fast"], setnx),
  setex: spec(4, ["write"], (ctx, [, key, s, value]) => set(ctx, [bytes("set"), key, value, bytes("EX"), s], "setex")),
  psetex: spec(4, ["write"], (ctx, [, key, ms, value]) => set(ctx, [bytes("set"), key, value, bytes("PX"), ms], "psetex")),
  getset: spec(3, ["write", "fast"], (ctx, [, key, value]) => set(ctx, [bytes("set"), key, value, bytes("GET")])),
  getdel: spec(2, ["write", "fast"], getdel),
  getex: spec(-2, ["write", "fast"], getex),
  mget: spec(-2, ["readonly", "fast"], mget, [1, -1, 1]),
  mset: spec(-3, ["write"], (ctx, args) => mset(ctx, args, false), [1, -1, 2]),
  msetnx: spec(-3, ["write"], (ctx, args) => mset(ctx, args, true), [1, -1, 2]),
  append: spec(3, ["write", "fast"], append),
  strlen: spec(2, ["readonly", "fast"], (ctx, [, key]) => r.int(valueOf(str(ctx, key)).length)),
  incr: spec(2, ["write", "fast"], (ctx, [, key]) => incrBy(ctx, key, 1n)),
  decr: spec(2, ["write", "fast"], (ctx, [, key]) => incrBy(ctx, key, -1n)),
  incrby: spec(3, ["write", "fast"], (ctx, [, key, by]) => incrBy(ctx, key, int64(by))),
  decrby: spec(3, ["write", "fast"], decrBy),
  incrbyfloat: spec(3, ["write", "fast"], incrByFloat),
  getrange: spec(4, ["readonly"], getRange),
  substr: spec(4, ["readonly"], getRange),
  setrange: spec(4, ["write"], setRange),
};
