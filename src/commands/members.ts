import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob } from "../store/keyspace";
import type { KeyType } from "../store/schema";
import { int, opt } from "./args";
import type { Ctx } from "./types";

export const MAX_EXPIRE_MS = 2 ** 48 - 1;

export interface MemberTable {
  table: string;
  column: string;
  type: KeyType;
  keyword: string;
  columns: string;
}

const NUM_ERROR = (keyword: string) => `ERR Parameter \`num${keyword[0]}${keyword.slice(1).toLowerCase()}\` should be greater than 0`;

export function parseMembers(args: Array<Uint8Array>, at: number, keyword: string, perItem = 1): Array<Uint8Array> {
  if (at >= args.length) throw new RedisError("ERR wrong number of arguments");
  if (opt(args[at]) !== keyword) throw new RedisError(`ERR unknown argument: ${text(args[at])}`);
  const raw = args[at + 1];
  const count = raw && /^\d+$/.test(text(raw)) ? Number(text(raw)) : 0;
  if (count <= 0) throw new RedisError(NUM_ERROR(keyword));
  const items = args.slice(at + 2, at + 2 + count * perItem);
  if (items.length < count * perItem) throw new RedisError("ERR wrong number of arguments");
  const extra = args[at + 2 + count * perItem];
  if (extra) throw new RedisError(`ERR unknown argument: ${text(extra)}`);
  return items;
}

export function expireAtArg(ctx: Ctx, arg: Uint8Array, unitMs: number, absolute: boolean, command: string): number {
  const n = int(arg);
  if (n < 0) throw new RedisError("ERR invalid expire time, must be >= 0");
  const at = absolute ? n * unitMs : ctx.now + n * unitMs;
  if (!Number.isSafeInteger(at) || at > MAX_EXPIRE_MS) throw new RedisError(`ERR invalid expire time in '${command}' command`);
  return at;
}

export function memberExpiry(ctx: Ctx, t: MemberTable, id: number | undefined, member: Uint8Array): number | null | undefined {
  if (id === undefined) return undefined;
  const row = ctx.ks.sql.exec<{ expires_at: number | null }>(`SELECT expires_at FROM ${t.table} WHERE key_id = ? AND ${t.column} = ?`, id, blob(member)).toArray()[0];
  return row ? row.expires_at : undefined;
}

export const MEMBER_ORDER = "ORDER BY expires_at IS NULL, expires_at, id";

export function setMemberExpiry(ctx: Ctx, t: MemberTable, id: number, member: Uint8Array, at: number | null) {
  const current = memberExpiry(ctx, t, id, member);
  if (at !== null || current === null || current === undefined) {
    ctx.ks.sql.exec(`UPDATE ${t.table} SET expires_at = ? WHERE key_id = ? AND ${t.column} = ?`, at, id, blob(member));
    return;
  }
  const row = ctx.ks.sql.exec(`DELETE FROM ${t.table} WHERE key_id = ? AND ${t.column} = ? RETURNING ${t.columns}`, id, blob(member)).one();
  const values = Object.values(row);
  ctx.ks.sql.exec(`INSERT INTO ${t.table} (key_id, ${t.columns}) VALUES (?${", ?".repeat(values.length)})`, id, ...values);
}

function deleteMember(ctx: Ctx, t: MemberTable, id: number, member: Uint8Array) {
  ctx.ks.sql.exec(`DELETE FROM ${t.table} WHERE key_id = ? AND ${t.column} = ?`, id, blob(member));
}

function skip(flag: string | undefined, current: number | null, at: number): boolean {
  if (flag === "NX") return current !== null;
  if (flag === "XX") return current === null;
  if (flag === "GT") return current === null || at <= current;
  if (flag === "LT") return current !== null && at >= current;
  return false;
}

export function expireCommand(t: MemberTable, unitMs: number, absolute: boolean) {
  return (ctx: Ctx, args: Array<Uint8Array>): Reply => {
    const [name, key, timeArg] = args;
    let at = 3;
    const flags = new Set<string>();
    while (at < args.length && ["NX", "XX", "GT", "LT"].includes(opt(args[at]))) flags.add(opt(args[at++]));
    if (flags.size > 1) throw new RedisError("ERR Multiple condition flags specified");
    const members = parseMembers(args, at, t.keyword);
    const when = expireAtArg(ctx, timeArg, unitMs, absolute, text(name).toLowerCase());
    const id = ctx.ks.getTyped(key, t.type)?.id;
    if (id === undefined) return r.array(members.map(() => r.int(-2)));
    const [flag] = flags;
    const codes = members.map((m) => {
      const current = memberExpiry(ctx, t, id, m);
      if (current === undefined) return -2;
      if (skip(flag, current, when)) return 0;
      if (when <= ctx.now) {
        deleteMember(ctx, t, id, m);
        return 2;
      }
      setMemberExpiry(ctx, t, id, m, when);
      return 1;
    });
    if (codes.some((c) => c > 0)) ctx.ks.onChange(key);
    if (codes.includes(2)) ctx.ks.deleteIfEmpty(id, key, t.type);
    return r.array(codes.map((c) => r.int(c)));
  };
}

export function ttlCommand(t: MemberTable, out: (msLeft: number, at: number) => number) {
  return (ctx: Ctx, args: Array<Uint8Array>): Reply => {
    const members = parseMembers(args, 2, t.keyword);
    const id = ctx.ks.getTyped(args[1], t.type)?.id;
    return r.array(members.map((m) => {
      const at = memberExpiry(ctx, t, id, m);
      if (at === undefined) return r.int(-2);
      if (at === null) return r.int(-1);
      return r.int(out(Math.max(at - ctx.now, 0), at));
    }));
  };
}

export function persistCommand(t: MemberTable) {
  return (ctx: Ctx, args: Array<Uint8Array>): Reply => {
    const members = parseMembers(args, 2, t.keyword);
    const key = args[1];
    const id = ctx.ks.getTyped(key, t.type)?.id;
    const codes = members.map((m) => {
      const at = memberExpiry(ctx, t, id, m);
      if (id === undefined || at === undefined) return -2;
      if (at === null) return -1;
      setMemberExpiry(ctx, t, id, m, null);
      return 1;
    });
    if (codes.includes(1)) ctx.ks.onChange(key);
    return r.array(codes.map((c) => r.int(c)));
  };
}

export const ttlOutputs = {
  seconds: (ms: number) => Math.floor((ms + 500) / 1000),
  millis: (ms: number) => ms,
  unixSeconds: (_: number, at: number) => Math.floor(at / 1000),
  unixMillis: (_: number, at: number) => at,
};

export type ExpiryOption = { kind: "none" } | { kind: "persist" } | { kind: "keep" } | { kind: "at"; at: number };

const UNITS = new Map<string, readonly [number, boolean]>([["EX", [1000, false]], ["PX", [1, false]], ["EXAT", [1000, true]], ["PXAT", [1, true]]]);

export function expiryOption(ctx: Ctx, args: Array<Uint8Array>, i: number, command: string, extra: "PERSIST" | "KEEPTTL"): { option: ExpiryOption; used: number } | undefined {
  const o = opt(args[i]);
  if (o === extra) return { option: { kind: extra === "PERSIST" ? "persist" : "keep" }, used: 1 };
  const unit = UNITS.get(o);
  if (!unit || i + 1 >= args.length) return undefined;
  return { option: { kind: "at", at: expireAtArg(ctx, args[i + 1], unit[0], unit[1], command) }, used: 2 };
}
