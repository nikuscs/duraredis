import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { globMatch } from "../store/glob";
import { blob, checkSize, fromBlob, keyString, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { ERR, int, opt, toInt64 } from "./args";
import { cursorArg, scanOptions } from "./keys";
import { expireCommand, expiryOption, MEMBER_ORDER, memberExpiry, parseMembers, persistCommand, setMemberExpiry, ttlCommand, ttlOutputs } from "./members";
import type { ExpiryOption, MemberTable } from "./members";
import { sample } from "./random";
import { keyless, spec } from "./types";
import type { Ctx, Spec, Table } from "./types";

const INTSET_MAX = 512;

const setId = (ctx: Ctx, key: Uint8Array): number | undefined => ctx.ks.getTyped(key, TYPE.set)?.id;

function members(ctx: Ctx, id: number | undefined): Array<Uint8Array> {
  if (id === undefined) return [];
  return ctx.ks.sql.exec<{ member: ArrayBuffer }>(`SELECT member FROM set_members WHERE key_id = ? ${MEMBER_ORDER}`, id)
    .toArray().map((row) => fromBlob(row.member));
}

function hasMember(ctx: Ctx, id: number | undefined, member: Uint8Array): boolean {
  if (id === undefined) return false;
  return ctx.ks.sql.exec("SELECT 1 FROM set_members WHERE key_id = ? AND member = ?", id, blob(member)).toArray().length > 0;
}

function count(ctx: Ctx, id: number | undefined): number {
  if (id === undefined) return 0;
  return ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM set_members WHERE key_id = ?", id).one().n;
}

function addMembers(ctx: Ctx, key: Uint8Array, values: Array<Uint8Array>): number {
  const id = setId(ctx, key) ?? ctx.ks.create(key, TYPE.set);
  let added = 0;
  for (const v of values) {
    checkSize(key, v);
    added += ctx.ks.sql.exec("INSERT INTO set_members (key_id, member) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id", id, blob(v)).toArray().length;
  }
  if (added) ctx.ks.onChange(key);
  return added;
}

function removeMembers(ctx: Ctx, key: Uint8Array, id: number | undefined, values: Array<Uint8Array>): number {
  if (id === undefined) return 0;
  let removed = 0;
  for (const v of values) removed += ctx.ks.sql.exec("DELETE FROM set_members WHERE key_id = ? AND member = ? RETURNING id", id, blob(v)).toArray().length;
  if (!removed) return 0;
  ctx.ks.onChange(key);
  ctx.ks.deleteIfEmpty(id, key, TYPE.set);
  return removed;
}

export function setOrder(values: Array<Uint8Array>): Array<Uint8Array> {
  if (values.length > INTSET_MAX) return values;
  const numbers = values.map((v) => toInt64(v));
  if (numbers.some((n) => n === undefined)) return values;
  return values.map((v, i) => ({ v, n: numbers[i] ?? 0n })).toSorted((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0)).map((x) => x.v);
}

const setReply = (values: Array<Uint8Array>): Reply => r.set(setOrder(values).map((v) => r.bulk(v)));

const hasExpiringMembers = (ctx: Ctx, id: number) => ctx.ks.sql.exec("SELECT 1 FROM set_members WHERE key_id = ? AND expires_at IS NOT NULL LIMIT 1", id).toArray().length > 0;

function smembers(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const id = setId(ctx, key);
  if (id === undefined || !hasExpiringMembers(ctx, id)) return setReply(members(ctx, id));
  return r.set(members(ctx, id).map((v) => r.bulk(v)));
}

const MEMBERS: MemberTable = { table: "set_members", column: "member", columns: "member", type: TYPE.set, keyword: "MEMBERS" };

function saddex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  let condition: string | undefined;
  let option: ExpiryOption = { kind: "none" };
  let at = 2;
  for (;;) {
    const o = args[at] ? opt(args[at]) : "";
    if (o === "MNX" || o === "MXX") {
      if (condition) throw new RedisError("ERR Only one of MXX or MNX arguments can be specified");
      condition = o;
      at++;
      continue;
    }
    const parsed = args[at] && o !== "MEMBERS" ? expiryOption(ctx, args, at, "saddex", "KEEPTTL") : undefined;
    if (!parsed) break;
    if (option.kind !== "none") throw new RedisError("ERR Only one of EX, PX, EXAT, PXAT or KEEPTTL arguments can be specified");
    option = parsed.option;
    at += parsed.used;
  }
  const values = parseMembers(args, at, "MEMBERS");
  const existing = setId(ctx, key);
  const present = values.filter((v) => hasMember(ctx, existing, v)).length;
  if (condition === "MNX" && present > 0) return r.int(0);
  if (condition === "MXX" && present < values.length) return r.int(0);
  if (option.kind === "at" && option.at <= ctx.now) return r.int(removeMembers(ctx, key, existing, values) ? 1 : 0);
  const target = option.kind === "at" ? option.at : null;
  const before = values.map((v) => memberExpiry(ctx, MEMBERS, existing, v));
  const added = addMembers(ctx, key, values);
  const id = setId(ctx, key);
  if (id === undefined) return r.int(0);
  if (option.kind === "keep") return r.int(added ? 1 : 0);
  const changed = before.some((b) => b !== undefined && b !== target);
  for (const v of values) setMemberExpiry(ctx, MEMBERS, id, v, target);
  if (changed) ctx.ks.onChange(key);
  return r.int(added || changed ? 1 : 0);
}

function cardinality(op: "inter" | "union" | "diff") {
  return (ctx: Ctx, args: Array<Uint8Array>): Reply => {
    const numkeys = /^\d+$/.test(text(args[1])) ? Number(text(args[1])) : 0;
    if (numkeys <= 0) throw new RedisError("ERR numkeys should be greater than 0");
    if (args.length < 2 + numkeys) throw new RedisError("ERR Number of keys can't be greater than number of args");
    let limit = 0;
    for (let i = 2 + numkeys; i < args.length; i += 2) {
      if (opt(args[i]) !== "LIMIT" || i + 1 >= args.length) throw new RedisError(ERR.syntax);
      limit = int(args[i + 1], "ERR LIMIT can't be negative");
      if (limit < 0) throw new RedisError("ERR LIMIT can't be negative");
    }
    const n = combine(op, load(ctx, args.slice(2, 2 + numkeys))).length;
    return r.int(limit ? Math.min(n, limit) : n);
  };
}

function load(ctx: Ctx, keys: Array<Uint8Array>): Array<Array<Uint8Array>> {
  return keys.map((k) => setId(ctx, k)).map((id) => members(ctx, id));
}

function combine(op: "inter" | "union" | "diff", sets: Array<Array<Uint8Array>>): Array<Uint8Array> {
  const [first = [], ...rest] = sets;
  if (op === "union") {
    const seen = new Map<string, Uint8Array>();
    for (const s of sets) for (const v of s) if (!seen.has(keyString(v))) seen.set(keyString(v), v);
    return [...seen.values()];
  }
  const others = rest.map((s) => new Set(s.map(keyString)));
  if (op === "inter") return first.filter((v) => others.every((o) => o.has(keyString(v))));
  return first.filter((v) => others.every((o) => !o.has(keyString(v))));
}

function store(ctx: Ctx, destination: Uint8Array, values: Array<Uint8Array>): Reply {
  ctx.ks.delete(destination);
  if (!values.length) return r.int(0);
  addMembers(ctx, destination, values);
  return r.int(values.length);
}

function spop(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) throw new RedisError(ERR.syntax);
  const key = args[1];
  const n = args.length === 3 ? int(args[2], "ERR value is out of range, must be positive") : undefined;
  if (n !== undefined && n < 0) throw new RedisError("ERR value is out of range, must be positive");
  const id = setId(ctx, key);
  if (id === undefined) return n === undefined ? r.nil : r.set([]);
  const chosen = sample(members(ctx, id), n ?? 1);
  removeMembers(ctx, key, id, chosen);
  if (n === undefined) return r.bulk(chosen[0] ?? null);
  return r.set(chosen.map((v) => r.bulk(v)));
}

function srandmember(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 3) throw new RedisError(ERR.syntax);
  const id = setId(ctx, args[1]);
  const all = members(ctx, id);
  if (args.length === 2) return r.bulk(sample(all, 1)[0] ?? null);
  return r.bulks(sample(all, int(args[2], "ERR value is out of range")));
}


function sscan(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const cursor = cursorArg(args[2]);
  const { match, count: limit } = scanOptions(args.slice(3));
  const id = setId(ctx, args[1]);
  if (id === undefined) return r.array([r.bulk("0"), r.array([])]);
  const page = ctx.ks.sql.exec<{ id: number; member: ArrayBuffer }>(
    "SELECT id, member FROM set_members WHERE key_id = ? AND id > ? ORDER BY id LIMIT ?", id, cursor, limit).toArray();
  const next = page.length < limit ? 0 : (page.at(-1)?.id ?? 0);
  const found = page.map((row) => fromBlob(row.member)).filter((m) => !match || globMatch(match, m));
  return r.array([r.bulk(String(next)), r.bulks(found)]);
}

function smove(ctx: Ctx, [, source, destination, member]: Array<Uint8Array>): Reply {
  const src = setId(ctx, source);
  setId(ctx, destination);
  if (src === undefined || !hasMember(ctx, src, member)) return r.int(0);
  if (sameBytes(source, destination)) return r.int(1);
  removeMembers(ctx, source, src, [member]);
  addMembers(ctx, destination, [member]);
  return r.int(1);
}

const op = (kind: "inter" | "union" | "diff"): Spec => spec(-2, ["readonly"], (ctx, args) => setReply(combine(kind, load(ctx, args.slice(1)))), [1, -1, 1]);

const opStore = (kind: "inter" | "union" | "diff"): Spec => spec(-3, ["write"], (ctx, args) => store(ctx, args[1], combine(kind, load(ctx, args.slice(2)))), [1, -1, 1]);

export const sets: Table = {
  sadd: spec(-3, ["write", "fast"], (ctx, args) => r.int(addMembers(ctx, args[1], args.slice(2)))),
  srem: spec(-3, ["write", "fast"], (ctx, args) => r.int(removeMembers(ctx, args[1], setId(ctx, args[1]), args.slice(2)))),
  smembers: spec(2, ["readonly"], smembers),
  sismember: spec(3, ["readonly", "fast"], (ctx, [, key, member]) => r.int(hasMember(ctx, setId(ctx, key), member) ? 1 : 0)),
  smismember: spec(-3, ["readonly", "fast"], (ctx, args) => {
    const id = setId(ctx, args[1]);
    return r.array(args.slice(2).map((m) => r.int(hasMember(ctx, id, m) ? 1 : 0)));
  }),
  scard: spec(2, ["readonly", "fast"], (ctx, [, key]) => r.int(count(ctx, setId(ctx, key)))),
  spop: spec(-2, ["write", "fast"], spop),
  srandmember: spec(-2, ["readonly"], srandmember),
  smove: spec(4, ["write", "fast"], smove, [1, 2, 1]),
  sinter: op("inter"),
  sunion: op("union"),
  sdiff: op("diff"),
  sinterstore: opStore("inter"),
  sunionstore: opStore("union"),
  sdiffstore: opStore("diff"),
  sintercard: keyless(-3, ["readonly"], cardinality("inter")),
  sscan: spec(-3, ["readonly"], sscan),
  sdiffcard: keyless(-3, ["readonly"], cardinality("diff")),
  sunioncard: keyless(-3, ["readonly"], cardinality("union")),
  saddex: spec(-5, ["write", "fast"], saddex),
  sexpire: spec(-6, ["write", "fast"], expireCommand(MEMBERS, 1000, false)),
  spexpire: spec(-6, ["write", "fast"], expireCommand(MEMBERS, 1, false)),
  sexpireat: spec(-6, ["write", "fast"], expireCommand(MEMBERS, 1000, true)),
  spexpireat: spec(-6, ["write", "fast"], expireCommand(MEMBERS, 1, true)),
  sttl: spec(-5, ["readonly", "fast"], ttlCommand(MEMBERS, ttlOutputs.seconds)),
  spttl: spec(-5, ["readonly", "fast"], ttlCommand(MEMBERS, ttlOutputs.millis)),
  sexpiretime: spec(-5, ["readonly", "fast"], ttlCommand(MEMBERS, ttlOutputs.unixSeconds)),
  spexpiretime: spec(-5, ["readonly", "fast"], ttlCommand(MEMBERS, ttlOutputs.unixMillis)),
  spersist: spec(-5, ["write", "fast"], persistCommand(MEMBERS)),
};
