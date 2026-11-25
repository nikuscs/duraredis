import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import type { KeyRow } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { toInt64 } from "./args";
import type { Ctx, Table } from "./types";

const SMALL_COUNT = 128;
const HASH_COUNT = 512;
const SMALL_ITEM = 64;
const INTSET_MAX = 512;
const LIST_NODE_BYTES = 8192;
const EMBSTR_MAX = 44;

type Stats = { n: number; longest: number; total: number; ints: number };

function stats(ctx: Ctx, table: string, column: string, id: number): Stats {
  const row = ctx.ks.sql.exec<Stats>(
    `SELECT count(*) AS n, coalesce(max(length(${column})), 0) AS longest, coalesce(sum(length(${column})), 0) AS total, 0 AS ints FROM ${table} WHERE key_id = ?`, id).one();
  if (table !== "set_members") return row;
  const members = ctx.ks.sql.exec<{ member: ArrayBuffer }>("SELECT member FROM set_members WHERE key_id = ?", id).toArray();
  return { ...row, ints: members.filter((m) => toInt64(new Uint8Array(m.member)) !== undefined).length };
}

const expiring = (ctx: Ctx, table: string, id: number) => ctx.ks.sql.exec(`SELECT 1 FROM ${table} WHERE key_id = ? AND expires_at IS NOT NULL LIMIT 1`, id).toArray().length > 0;

function encoding(ctx: Ctx, row: KeyRow): string {
  if (row.type === TYPE.string) {
    const value = row.value ?? new Uint8Array(0);
    if (value.length <= 20 && toInt64(value) !== undefined) return "int";
    return value.length <= EMBSTR_MAX ? "embstr" : "raw";
  }
  if (row.type === TYPE.list) {
    const s = stats(ctx, "list_items", "value", row.id);
    return s.total + s.n * 11 < LIST_NODE_BYTES && s.n <= SMALL_COUNT ? "listpack" : "quicklist";
  }
  if (row.type === TYPE.hash) {
    const s = stats(ctx, "hash_fields", "value", row.id);
    const f = stats(ctx, "hash_fields", "field", row.id);
    const big = s.n > HASH_COUNT || Math.max(s.longest, f.longest) > SMALL_ITEM;
    const ttl = expiring(ctx, "hash_fields", row.id);
    if (row.value && !ttl) return big ? "template-array" : "template-listpack";
    if (big) return "hashtable";
    return ttl ? "listpackex" : "listpack";
  }
  if (row.type === TYPE.set) {
    const s = stats(ctx, "set_members", "member", row.id);
    const ttl = expiring(ctx, "set_members", row.id);
    if (!ttl && s.ints === s.n && s.n <= INTSET_MAX) return "intset";
    if (s.n > SMALL_COUNT || s.longest > SMALL_ITEM) return "hashtable";
    return ttl ? "listpackex" : "listpack";
  }
  if (row.type === TYPE.stream) return "stream";
  if (row.type === TYPE.array) return "sliced-array";
  if (row.type !== TYPE.zset) return "raw";
  const s = stats(ctx, "zset_members", "member", row.id);
  return s.n <= SMALL_COUNT && s.longest <= SMALL_ITEM ? "listpack" : "skiplist";
}

function object(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sub = text(args[1]).toUpperCase();
  if (sub === "HELP") return r.array([r.simple("OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are: ENCODING, FREQ, IDLETIME, REFCOUNT.")]);
  if (!["ENCODING", "REFCOUNT", "IDLETIME", "FREQ"].includes(sub)) throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try OBJECT HELP.`);
  if (args.length !== 3) throw new RedisError(`ERR wrong number of arguments for 'object|${sub.toLowerCase()}' command`);
  const row = ctx.ks.get(args[2]);
  if (!row) return r.nil;
  if (sub === "ENCODING") return r.bulk(encoding(ctx, row));
  if (sub === "REFCOUNT") return r.int(1);
  if (sub === "IDLETIME") return r.int(0);
  throw new RedisError("ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.");
}

export const objects: Table = {
  object: { arity: -2, flags: ["readonly"], run: object },
};
