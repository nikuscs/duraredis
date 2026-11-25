import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { sameBytes } from "../store/keyspace";
import { UNCOPYABLE } from "../store/keytypes";
import { TYPE_NAME } from "../store/schema";
import { ERR, int, opt } from "./args";
import { keyless, spec } from "./types";
import type { Ctx, Table } from "./types";

const EXPIRE_FLAGS = new Set(["NX", "XX", "GT", "LT"]);
const MAX_SCAN = 100_000;

function expireFlags(args: Array<Uint8Array>): Set<string> {
  const flags = new Set<string>();
  for (const a of args) {
    const o = opt(a);
    if (!EXPIRE_FLAGS.has(o)) throw new RedisError(`ERR Unsupported option ${text(a)}`);
    flags.add(o);
  }
  if (flags.has("NX") && flags.size > 1) throw new RedisError("ERR NX and XX, GT or LT options at the same time are not compatible");
  if (flags.has("GT") && flags.has("LT")) throw new RedisError("ERR GT and LT options at the same time are not compatible");
  return flags;
}

function skipExpire(flags: Set<string>, current: number | null, at: number): boolean {
  if (flags.has("NX")) return current !== null;
  if (flags.has("XX") && current === null) return true;
  if (flags.has("GT")) return current === null || at <= current;
  if (flags.has("LT")) return current !== null && at >= current;
  return false;
}

function expire(ctx: Ctx, args: Array<Uint8Array>, unitMs: number, absolute: boolean): Reply {
  const [name, key, timeArg] = args;
  const flags = expireFlags(args.slice(3));
  const ms = int(timeArg) * unitMs;
  const at = absolute ? ms : ctx.now + ms;
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(at)) throw new RedisError(`ERR invalid expire time in '${text(name).toLowerCase()}' command`);
  const row = ctx.ks.get(key);
  if (!row || skipExpire(flags, row.expiresAt, at)) return r.int(0);
  if (at <= ctx.now) ctx.ks.delete(key);
  else ctx.ks.setExpiry(row.id, key, at);
  return r.int(1);
}

function ttl(ctx: Ctx, key: Uint8Array, out: (msLeft: number, at: number) => number): Reply {
  const row = ctx.ks.get(key);
  if (!row) return r.int(-2);
  if (row.expiresAt === null) return r.int(-1);
  return r.int(out(Math.max(row.expiresAt - ctx.now, 0), row.expiresAt));
}

function rename(ctx: Ctx, [, from, to]: Array<Uint8Array>, nx: boolean): Reply {
  const row = ctx.ks.get(from);
  if (!row) throw new RedisError("ERR no such key");
  if (sameBytes(from, to)) return nx ? r.int(0) : r.ok;
  if (nx && ctx.ks.exists(to)) return r.int(0);
  ctx.ks.rename(row, from, to);
  return nx ? r.int(1) : r.ok;
}

export function cursorArg(b: Uint8Array): number {
  const s = text(b);
  if (!/^\d{1,20}$/.test(s)) throw new RedisError("ERR invalid cursor");
  return Math.min(Number(s), Number.MAX_SAFE_INTEGER);
}

export interface ScanOptions {
  match: Uint8Array | undefined;
  count: number;
  type: string | undefined;
  noValues: boolean;
}

export function scanOptions(args: Array<Uint8Array>, allow: { type?: boolean; noValues?: boolean } = {}): ScanOptions {
  const options: ScanOptions = { match: undefined, count: 10, type: undefined, noValues: false };
  for (let i = 0; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "NOVALUES" && allow.noValues) {
      options.noValues = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new RedisError(ERR.syntax);
    if (o === "MATCH") options.match = value;
    else if (o === "COUNT") options.count = int(value);
    else if (o === "TYPE" && allow.type) options.type = text(value).toLowerCase();
    else throw new RedisError(ERR.syntax);
    if (options.count < 1) throw new RedisError(ERR.syntax);
  }
  options.count = Math.min(options.count, MAX_SCAN);
  return options;
}

function scan(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const cursor = cursorArg(args[1]);
  const { match, count, type } = scanOptions(args.slice(2), { type: true });
  const page = ctx.ks.scan(cursor, count);
  const found = page.keys.filter((k) => (!match || globMatch(match, k.key)) && (!type || TYPE_NAME[k.type] === type));
  return r.array([r.bulk(String(page.next)), r.bulks(found.map((k) => k.key))]);
}

function copy(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, from, to] = args;
  let replace = false;
  for (let i = 3; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "REPLACE") replace = true;
    else if (o !== "DB" || i + 1 >= args.length) throw new RedisError(ERR.syntax);
    else if (int(args[++i]) !== 0) throw new RedisError("ERR DB index is out of range");
  }
  if (sameBytes(from, to)) throw new RedisError("ERR source and destination objects are the same");
  const row = ctx.ks.get(from);
  if (!row) return r.int(0);
  if (UNCOPYABLE.has(row.type)) throw new RedisError("ERR not supported for this module key");
  if (ctx.ks.exists(to) && !replace) return r.int(0);
  ctx.ks.delete(to);
  ctx.ks.copy(row, to);
  return r.int(1);
}

function persist(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.get(key);
  if (!row || row.expiresAt === null) return r.int(0);
  ctx.ks.setExpiry(row.id, key, null);
  return r.int(1);
}

function flush(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.slice(1).some((a) => opt(a) !== "ASYNC" && opt(a) !== "SYNC")) throw new RedisError(ERR.syntax);
  ctx.ks.flush();
  return r.ok;
}

const deleteKeys = (ctx: Ctx, args: Array<Uint8Array>) => r.int(args.slice(1).filter((k) => ctx.ks.delete(k)).length);
const countKeys = (ctx: Ctx, args: Array<Uint8Array>) => r.int(args.slice(1).filter((k) => ctx.ks.exists(k)).length);

export const keys: Table = {
  del: spec(-2, ["write"], deleteKeys, [1, -1, 1]),
  unlink: spec(-2, ["write", "fast"], deleteKeys, [1, -1, 1]),
  exists: spec(-2, ["readonly", "fast"], countKeys, [1, -1, 1]),
  touch: spec(-2, ["readonly", "fast"], countKeys, [1, -1, 1]),
  type: spec(2, ["readonly", "fast"], (ctx, [, key]) => r.simple(ctx.ks.typeName(ctx.ks.get(key)))),
  keys: keyless(2, ["readonly"], (ctx, [, pattern]) => r.bulks(ctx.ks.all().filter((k) => globMatch(pattern, k)))),
  scan: keyless(-2, ["readonly"], scan),
  randomkey: keyless(1, ["readonly"], (ctx) => r.bulk(ctx.ks.random() ?? null)),
  rename: spec(3, ["write"], (ctx, args) => rename(ctx, args, false), [1, 2, 1]),
  renamenx: spec(3, ["write", "fast"], (ctx, args) => rename(ctx, args, true), [1, 2, 1]),
  copy: spec(-3, ["write"], copy, [1, 2, 1]),
  expire: spec(-3, ["write", "fast"], (ctx, args) => expire(ctx, args, 1000, false)),
  pexpire: spec(-3, ["write", "fast"], (ctx, args) => expire(ctx, args, 1, false)),
  expireat: spec(-3, ["write", "fast"], (ctx, args) => expire(ctx, args, 1000, true)),
  pexpireat: spec(-3, ["write", "fast"], (ctx, args) => expire(ctx, args, 1, true)),
  ttl: spec(2, ["readonly", "fast"], (ctx, [, key]) => ttl(ctx, key, (ms) => Math.floor((ms + 500) / 1000))),
  pttl: spec(2, ["readonly", "fast"], (ctx, [, key]) => ttl(ctx, key, (ms) => ms)),
  expiretime: spec(2, ["readonly", "fast"], (ctx, [, key]) => ttl(ctx, key, (_, at) => Math.floor(at / 1000))),
  pexpiretime: spec(2, ["readonly", "fast"], (ctx, [, key]) => ttl(ctx, key, (_, at) => at)),
  persist: spec(2, ["write", "fast"], persist),
  dbsize: keyless(1, ["readonly", "fast"], (ctx) => r.int(ctx.ks.size())),
  flushdb: keyless(-1, ["write"], flush),
  flushall: keyless(-1, ["write"], flush),
};
