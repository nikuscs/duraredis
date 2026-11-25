import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { blob, checkSize, fromBlob } from "../store/keyspace";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, float, INT64_MAX, INT64_MIN, int, int64, opt, toFloat, toInt64 } from "./args";
import { templateOrder } from "./himport";
import { cursorArg, scanOptions } from "./keys";
import { expireCommand, expiryOption, MEMBER_ORDER, parseMembers, persistCommand, setMemberExpiry, ttlCommand, ttlOutputs } from "./members";
import type { ExpiryOption, MemberTable } from "./members";
import { addFloats } from "./numbers";
import { sample } from "./random";
import { spec } from "./types";
import type { Ctx, Table } from "./types";

interface Field {
  field: Uint8Array;
  value: Uint8Array;
}

const FIELDS: MemberTable = { table: "hash_fields", column: "field", columns: "field, value", type: TYPE.hash, keyword: "FIELDS" };

const hashId = (ctx: Ctx, key: Uint8Array): number | undefined => ctx.ks.getTyped(key, TYPE.hash)?.id;
const hashIdOrCreate = (ctx: Ctx, key: Uint8Array): number => hashId(ctx, key) ?? ctx.ks.create(key, TYPE.hash);
const toField = (row: { field: ArrayBuffer; value: ArrayBuffer }): Field => ({ field: fromBlob(row.field), value: fromBlob(row.value) });

function getField(ctx: Ctx, id: number | undefined, field: Uint8Array): Uint8Array | undefined {
  if (id === undefined) return undefined;
  const row = ctx.ks.sql.exec<{ value: ArrayBuffer }>("SELECT value FROM hash_fields WHERE key_id = ? AND field = ?", id, blob(field)).toArray()[0];
  return row ? fromBlob(row.value) : undefined;
}

function putField(ctx: Ctx, id: number, key: Uint8Array, field: Uint8Array, value: Uint8Array, keepTtl = false): boolean {
  checkSize(key, field, value);
  const added = getField(ctx, id, field) === undefined;
  if (!keepTtl) setMemberExpiry(ctx, FIELDS, id, field, null);
  ctx.ks.sql.exec(`INSERT INTO hash_fields (key_id, field, value) VALUES (?, ?, ?) ON CONFLICT (key_id, field) DO UPDATE SET value = excluded.value${keepTtl ? "" : ", expires_at = NULL"}`,
    id, blob(field), blob(value));
  ctx.ks.onChange(key);
  return added;
}

function fields(ctx: Ctx, row: KeyRow | undefined): Array<Field> {
  if (!row) return [];
  const all = ctx.ks.sql.exec<{ field: ArrayBuffer; value: ArrayBuffer }>(`SELECT field, value FROM hash_fields WHERE key_id = ? ${MEMBER_ORDER}`, row.id).toArray().map(toField);
  return templateOrder(row.value, all);
}

function hset(ctx: Ctx, args: Array<Uint8Array>): number {
  if (args.length % 2) throw new RedisError(`ERR wrong number of arguments for '${text(args[0]).toLowerCase()}' command`);
  const key = args[1];
  const id = hashIdOrCreate(ctx, key);
  let added = 0;
  for (let i = 2; i < args.length; i += 2) if (putField(ctx, id, key, args[i], args[i + 1])) added++;
  return added;
}

function hsetnx(ctx: Ctx, [, key, field, value]: Array<Uint8Array>): Reply {
  if (getField(ctx, hashId(ctx, key), field) !== undefined) return r.int(0);
  putField(ctx, hashIdOrCreate(ctx, key), key, field, value);
  return r.int(1);
}

function hdel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const id = hashId(ctx, key);
  if (id === undefined) return r.int(0);
  let removed = 0;
  for (const f of args.slice(2)) removed += ctx.ks.sql.exec("DELETE FROM hash_fields WHERE key_id = ? AND field = ? RETURNING id", id, blob(f)).toArray().length;
  if (!removed) return r.int(0);
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(id, key, TYPE.hash);
  return r.int(removed);
}

function hlen(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const id = hashId(ctx, key);
  if (id === undefined) return r.int(0);
  return r.int(ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM hash_fields WHERE key_id = ?", id).one().n);
}

function hincrby(ctx: Ctx, [, key, field, byArg]: Array<Uint8Array>): Reply {
  const by = int64(byArg);
  const id = hashIdOrCreate(ctx, key);
  const old = getField(ctx, id, field);
  const current = old === undefined ? 0n : toInt64(old);
  if (current === undefined) throw new RedisError("ERR hash value is not an integer");
  const next = current + by;
  if (next > INT64_MAX || next < INT64_MIN) throw new RedisError(ERR.overflow);
  putField(ctx, id, key, field, bytes(String(next)), true);
  return r.int(next);
}

function hincrbyfloat(ctx: Ctx, [, key, field, byArg]: Array<Uint8Array>): Reply {
  if (!Number.isFinite(float(byArg))) throw new RedisError("ERR value is NaN or Infinity");
  const id = hashIdOrCreate(ctx, key);
  const old = getField(ctx, id, field) ?? bytes("0");
  if (toFloat(old) === undefined) throw new RedisError("ERR hash value is not a float");
  const value = bytes(addFloats(text(old), text(byArg)));
  putField(ctx, id, key, field, value, true);
  return r.bulk(value);
}

function hrandfield(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, countArg, withArg] = args;
  if (args.length > 4 || (withArg && opt(withArg) !== "WITHVALUES")) throw new RedisError(ERR.syntax);
  const row = ctx.ks.getTyped(key, TYPE.hash);
  if (countArg === undefined) return r.bulk(sample(fields(ctx, row), 1)[0]?.field ?? null);
  const count = int(countArg);
  if (withArg && Math.abs(count) > 2 ** 52) throw new RedisError("ERR value is out of range");
  const picked = row ? sample(fields(ctx, row), count) : [];
  if (!withArg) return r.bulks(picked.map((f) => f.field));
  if (ctx.session.proto === 3) return r.array(picked.map((f) => r.bulks([f.field, f.value])));
  return r.bulks(picked.flatMap((f) => [f.field, f.value]));
}

function hscan(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const cursor = cursorArg(args[2]);
  const { match, count, noValues } = scanOptions(args.slice(3), { noValues: true });
  const id = hashId(ctx, args[1]);
  if (id === undefined) return r.array([r.bulk("0"), r.array([])]);
  const page = ctx.ks.sql.exec<{ id: number; field: ArrayBuffer; value: ArrayBuffer }>(
    "SELECT id, field, value FROM hash_fields WHERE key_id = ? AND id > ? ORDER BY id LIMIT ?", id, cursor, count).toArray();
  const next = page.length < count ? 0 : (page.at(-1)?.id ?? 0);
  const found = page.map(toField).filter((f) => !match || globMatch(match, f.field));
  return r.array([r.bulk(String(next)), r.bulks(found.flatMap((f) => (noValues ? [f.field] : [f.field, f.value])))]);
}

function deleteFields(ctx: Ctx, key: Uint8Array, id: number, names: Array<Uint8Array>) {
  for (const f of names) ctx.ks.sql.exec("DELETE FROM hash_fields WHERE key_id = ? AND field = ?", id, blob(f));
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(id, key, TYPE.hash);
}

function hgetdel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const names = parseMembers(args, 2, "FIELDS");
  const key = args[1];
  const id = hashId(ctx, key);
  const values = names.map((f) => getField(ctx, id, f) ?? null);
  if (id !== undefined && values.some((v) => v !== null)) deleteFields(ctx, key, id, names);
  return r.bulks(values);
}

function hgetex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const parsed = args[2] ? expiryOption(ctx, args, 2, "hgetex", "PERSIST") : undefined;
  const at = parsed ? 2 + parsed.used : 2;
  if (parsed && args[at] && expiryOption(ctx, args, at, "hgetex", "PERSIST")) throw new RedisError("ERR Only one of EX, PX, EXAT, PXAT or PERSIST arguments can be specified");
  const names = parseMembers(args, at, "FIELDS");
  const id = hashId(ctx, key);
  const values = names.map((f) => getField(ctx, id, f) ?? null);
  const option = parsed?.option;
  if (id === undefined || !option) return r.bulks(values);
  const present = names.filter((_, i) => values[i] !== null);
  if (option.kind === "at" && option.at <= ctx.now) deleteFields(ctx, key, id, present);
  if (option.kind === "at" && option.at > ctx.now) for (const f of present) setMemberExpiry(ctx, FIELDS, id, f, option.at);
  if (option.kind === "persist") for (const f of present) setMemberExpiry(ctx, FIELDS, id, f, null);
  if (present.length) ctx.ks.onChange(key);
  return r.bulks(values);
}

function hsetex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  let condition: string | undefined;
  let option: ExpiryOption = { kind: "none" };
  let at = 2;
  for (;;) {
    const o = args[at] ? opt(args[at]) : "";
    if (o === "FNX" || o === "FXX") {
      if (condition) throw new RedisError("ERR Only one of FXX or FNX arguments can be specified");
      condition = o;
      at++;
      continue;
    }
    const parsed = args[at] && o !== "FIELDS" ? expiryOption(ctx, args, at, "hsetex", "KEEPTTL") : undefined;
    if (!parsed) break;
    if (option.kind !== "none") throw new RedisError("ERR Only one of EX, PX, EXAT, PXAT or KEEPTTL arguments can be specified");
    option = parsed.option;
    at += parsed.used;
  }
  const pairs = parseMembers(args, at, "FIELDS", 2);
  const names = pairs.filter((_, i) => i % 2 === 0);
  const existing = hashId(ctx, key);
  const present = names.filter((f) => getField(ctx, existing, f) !== undefined).length;
  if (condition === "FNX" && present > 0) return r.int(0);
  if (condition === "FXX" && present < names.length) return r.int(0);
  const id = existing ?? ctx.ks.create(key, TYPE.hash);
  for (let i = 0; i < pairs.length; i += 2) putField(ctx, id, key, pairs[i], pairs[i + 1], option.kind === "keep");
  if (option.kind === "at" && option.at <= ctx.now) deleteFields(ctx, key, id, names);
  if (option.kind === "at" && option.at > ctx.now) for (const f of names) setMemberExpiry(ctx, FIELDS, id, f, option.at);
  return r.int(1);
}

export const hashes: Table = {
  hset: spec(-4, ["write", "fast"], (ctx, args) => r.int(hset(ctx, args))),
  hmset: spec(-4, ["write", "fast"], (ctx, args) => {
    hset(ctx, args);
    return r.ok;
  }),
  hsetnx: spec(4, ["write", "fast"], hsetnx),
  hget: spec(3, ["readonly", "fast"], (ctx, [, key, field]) => r.bulk(getField(ctx, hashId(ctx, key), field) ?? null)),
  hmget: spec(-3, ["readonly", "fast"], (ctx, args) => {
    const id = hashId(ctx, args[1]);
    return r.bulks(args.slice(2).map((f) => getField(ctx, id, f) ?? null));
  }),
  hdel: spec(-3, ["write", "fast"], hdel),
  hexists: spec(3, ["readonly", "fast"], (ctx, [, key, field]) => r.int(getField(ctx, hashId(ctx, key), field) === undefined ? 0 : 1)),
  hlen: spec(2, ["readonly", "fast"], hlen),
  hstrlen: spec(3, ["readonly", "fast"], (ctx, [, key, field]) => r.int(getField(ctx, hashId(ctx, key), field)?.length ?? 0)),
  hkeys: spec(2, ["readonly"], (ctx, [, key]) => r.bulks(fields(ctx, ctx.ks.getTyped(key, TYPE.hash)).map((f) => f.field))),
  hvals: spec(2, ["readonly"], (ctx, [, key]) => r.bulks(fields(ctx, ctx.ks.getTyped(key, TYPE.hash)).map((f) => f.value))),
  hgetall: spec(2, ["readonly"], (ctx, [, key]) => r.map(fields(ctx, ctx.ks.getTyped(key, TYPE.hash)).map((f) => [r.bulk(f.field), r.bulk(f.value)]))),
  hincrby: spec(4, ["write", "fast"], hincrby),
  hincrbyfloat: spec(4, ["write", "fast"], hincrbyfloat),
  hrandfield: spec(-2, ["readonly"], hrandfield),
  hscan: spec(-3, ["readonly"], hscan),
  hexpire: spec(-6, ["write", "fast"], expireCommand(FIELDS, 1000, false)),
  hpexpire: spec(-6, ["write", "fast"], expireCommand(FIELDS, 1, false)),
  hexpireat: spec(-6, ["write", "fast"], expireCommand(FIELDS, 1000, true)),
  hpexpireat: spec(-6, ["write", "fast"], expireCommand(FIELDS, 1, true)),
  httl: spec(-5, ["readonly", "fast"], ttlCommand(FIELDS, ttlOutputs.seconds)),
  hpttl: spec(-5, ["readonly", "fast"], ttlCommand(FIELDS, ttlOutputs.millis)),
  hexpiretime: spec(-5, ["readonly", "fast"], ttlCommand(FIELDS, ttlOutputs.unixSeconds)),
  hpexpiretime: spec(-5, ["readonly", "fast"], ttlCommand(FIELDS, ttlOutputs.unixMillis)),
  hpersist: spec(-5, ["write", "fast"], persistCommand(FIELDS)),
  hgetdel: spec(-5, ["write", "fast"], hgetdel),
  hgetex: spec(-5, ["write", "fast"], hgetex),
  hsetex: spec(-6, ["write", "fast"], hsetex),
};
