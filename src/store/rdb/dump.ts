import { MEMBER_ORDER } from "../../commands/members";
import { toFloat, toInt64 } from "../../commands/args";
import type { Ctx } from "../../commands/types";
import { bytes, formatDouble } from "../../resp/reply";
import { blob, checkSize, fromBlob } from "../keyspace";
import type { KeyRow } from "../keyspace";
import { TYPE } from "../schema";
import {
  QUICKLIST_PACKED,
  QUICKLIST_PLAIN,
  RDB_TYPE,
  RdbFormatError,
  RdbWriter,
} from "./codec";
import type { RdbReader } from "./codec";
import { decodeIntset, encodeIntset } from "./intset";
import { decodeListpack, decodeListpackItems, encodeListpack, listpackEntrySize, listpackInt } from "./listpack";
import { checkModuleSizes, decodePrivateModule, dumpPrivateModule, writePrivateModule } from "./private";
import type { RestoredModule } from "./private";
import { checkStreamSizes, decodeStream, dumpStream, writeStream } from "./stream";
import type { RestoredStream } from "./stream";
import { decodeZiplist } from "./ziplist";

const SMALL_COUNT = 128;
const HASH_COUNT = 512;
const SMALL_ITEM = 64;
const INTSET_MAX = 512;
const LIST_NODE_BYTES = 8192;
const SCORE_INT_LIMIT = 4_611_686_018_427_387_904;

export interface HashEntry {
  field: Uint8Array;
  value: Uint8Array;
  expiresAt: number | null;
}

export interface SetEntry {
  member: Uint8Array;
  expiresAt: number | null;
}

export interface ZsetEntry {
  member: Uint8Array;
  score: number;
}

export type RestoredObject =
  | { kind: "string"; value: Uint8Array }
  | { kind: "list"; items: Array<Uint8Array> }
  | { kind: "set"; members: Array<SetEntry> }
  | { kind: "zset"; entries: Array<ZsetEntry> }
  | { kind: "hash"; fields: Array<HashEntry> }
  | { kind: "stream"; stream: RestoredStream }
  | { kind: "module"; module: RestoredModule };

function formatZsetScore(score: number): Uint8Array | bigint {
  if (score === Infinity) return bytes("inf");
  if (score === -Infinity) return bytes("-inf");
  if (score === 0) return 0n;
  if (Number.isInteger(score) && Math.abs(score) <= SCORE_INT_LIMIT) return BigInt(score);
  return bytes(formatDouble(score));
}

function parseZsetScore(raw: Uint8Array): number {
  const n = toFloat(raw);
  if (n === undefined || Number.isNaN(n)) throw new RdbFormatError("invalid zset score");
  return n;
}

function minExpiry(rows: Array<{ expires_at: number | null }>): bigint | undefined {
  let min: number | undefined;
  for (const row of rows) {
    if (row.expires_at === null) continue;
    if (min === undefined || row.expires_at < min) min = row.expires_at;
  }
  return min === undefined ? undefined : BigInt(min);
}

function dumpList(ctx: Ctx, keyId: number, w: RdbWriter) {
  w.u8(RDB_TYPE.listQuicklist2);
  const rows = ctx.ks.sql.exec<{ value: ArrayBuffer }>("SELECT value FROM list_items WHERE key_id = ? ORDER BY pos ASC", keyId).toArray();
  const nodes: Array<{ packed: boolean; items: Array<Uint8Array>; plain?: Uint8Array }> = [];
  let batch: Array<Uint8Array> = [];
  let lpBytes = 7;

  const flush = () => {
    if (!batch.length) return;
    nodes.push({ packed: true, items: batch });
    batch = [];
    lpBytes = 7;
  };

  for (const row of rows) {
    const val = fromBlob(row.value);
    if (val.length > LIST_NODE_BYTES) {
      flush();
      nodes.push({ packed: false, items: [], plain: val });
      continue;
    }
    const size = listpackEntrySize(val);
    if (batch.length > 0 && lpBytes + size > LIST_NODE_BYTES) flush();
    batch.push(val);
    lpBytes += size;
  }
  flush();

  w.len(nodes.length);
  for (const node of nodes) {
    if (node.packed) {
      w.len(QUICKLIST_PACKED);
      w.blobString(encodeListpack(node.items));
    } else {
      w.len(QUICKLIST_PLAIN);
      w.blobString(node.plain ?? new Uint8Array(0));
    }
  }
}

function dumpSet(ctx: Ctx, keyId: number, w: RdbWriter) {
  const rows = ctx.ks.sql.exec<{ member: ArrayBuffer; expires_at: number | null }>(
    `SELECT member, expires_at FROM set_members WHERE key_id = ? ${MEMBER_ORDER}`, keyId).toArray();
  const members = rows.map((row) => ({ member: fromBlob(row.member), expires_at: row.expires_at }));
  const minExp = minExpiry(rows);
  let longest = 0;
  for (const m of members) if (m.member.length > longest) longest = m.member.length;

  if (minExp === undefined && members.length <= INTSET_MAX) {
    const ints: Array<bigint> = [];
    let allInts = true;
    for (const m of members) {
      const iv = toInt64(m.member);
      if (iv === undefined) {
        allInts = false;
        break;
      }
      ints.push(iv);
    }
    if (allInts) {
      w.u8(RDB_TYPE.setIntset);
      w.blobString(encodeIntset(ints));
      return;
    }
  }

  if (members.length <= SMALL_COUNT && longest <= SMALL_ITEM) {
    if (minExp === undefined) {
      w.u8(RDB_TYPE.setListpack);
      w.blobString(encodeListpack(members.map((m) => m.member)));
      return;
    }
    w.u8(RDB_TYPE.setListpackEx);
    w.i64le(minExp);
    const items: Array<Uint8Array | bigint> = [];
    for (const m of members) items.push(m.member, BigInt(m.expires_at ?? 0));
    w.blobString(encodeListpack(items));
    return;
  }

  if (minExp === undefined) {
    w.u8(RDB_TYPE.set);
    w.len(members.length);
    for (const m of members) w.rawString(m.member, true);
    return;
  }

  w.u8(RDB_TYPE.setMetadata);
  w.i64le(minExp);
  w.len(members.length);
  for (const m of members) {
    w.len(m.expires_at === null ? 0n : BigInt(m.expires_at) - minExp + 1n);
    w.rawString(m.member, true);
  }
}

function dumpZset(ctx: Ctx, keyId: number, w: RdbWriter) {
  const rows = ctx.ks.sql.exec<{ member: ArrayBuffer; score: number }>(
    "SELECT member, score FROM zset_members WHERE key_id = ? ORDER BY score ASC, member ASC", keyId).toArray();
  const entries = rows.map((row) => ({ member: fromBlob(row.member), score: row.score }));
  let longest = 0;
  for (const e of entries) if (e.member.length > longest) longest = e.member.length;

  if (entries.length <= SMALL_COUNT && longest <= SMALL_ITEM) {
    w.u8(RDB_TYPE.zsetListpack);
    const items: Array<Uint8Array | bigint> = [];
    for (const e of entries) items.push(e.member, formatZsetScore(e.score));
    w.blobString(encodeListpack(items));
    return;
  }

  w.u8(RDB_TYPE.zset2);
  w.len(entries.length);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    w.rawString(e.member, true);
    w.f64le(Object.is(e.score, -0) ? 0 : e.score);
  }
}

function dumpHash(ctx: Ctx, keyId: number, w: RdbWriter) {
  const rows = ctx.ks.sql.exec<{ field: ArrayBuffer; value: ArrayBuffer; expires_at: number | null }>(
    `SELECT field, value, expires_at FROM hash_fields WHERE key_id = ? ${MEMBER_ORDER}`, keyId).toArray();
  const fields = rows.map((row) => ({ field: fromBlob(row.field), value: fromBlob(row.value), expires_at: row.expires_at }));
  const minExp = minExpiry(rows);
  let longest = 0;
  for (const f of fields) {
    if (f.field.length > longest) longest = f.field.length;
    if (f.value.length > longest) longest = f.value.length;
  }

  if (fields.length <= HASH_COUNT && longest <= SMALL_ITEM) {
    if (minExp === undefined) {
      w.u8(RDB_TYPE.hashListpack);
      const items: Array<Uint8Array> = [];
      for (const f of fields) items.push(f.field, f.value);
      w.blobString(encodeListpack(items));
      return;
    }
    w.u8(RDB_TYPE.hashListpackEx);
    w.i64le(minExp);
    const items: Array<Uint8Array | bigint> = [];
    for (const f of fields) items.push(f.field, f.value, BigInt(f.expires_at ?? 0));
    w.blobString(encodeListpack(items));
    return;
  }

  if (minExp === undefined) {
    w.u8(RDB_TYPE.hash);
    w.len(fields.length);
    for (const f of fields) {
      w.rawString(f.field, true);
      w.rawString(f.value, true);
    }
    return;
  }

  w.u8(RDB_TYPE.hashMetadata);
  w.i64le(minExp);
  w.len(fields.length);
  for (const f of fields) {
    w.len(f.expires_at === null ? 0n : BigInt(f.expires_at) - minExp + 1n);
    w.rawString(f.field, true);
    w.rawString(f.value, true);
  }
}

export function dumpKey(ctx: Ctx, row: KeyRow): Uint8Array {
  const w = new RdbWriter();
  switch (row.type) {
    case TYPE.string:
      w.u8(RDB_TYPE.string);
      w.rawString(row.value ?? new Uint8Array(0), true);
      break;
    case TYPE.list:
      dumpList(ctx, row.id, w);
      break;
    case TYPE.set:
      dumpSet(ctx, row.id, w);
      break;
    case TYPE.zset:
      dumpZset(ctx, row.id, w);
      break;
    case TYPE.hash:
      dumpHash(ctx, row.id, w);
      break;
    case TYPE.stream:
      dumpStream(ctx, row.id, w);
      break;
    default:
      dumpPrivateModule(ctx, row, w);
      break;
  }
  return w.finishDump();
}

function decodePairedFlat(raw: Array<Uint8Array>, kind: "zset" | "hash"): RestoredObject {
  if (raw.length === 0 || raw.length % 2 !== 0) throw new RdbFormatError("invalid packed pairs");
  if (kind === "zset") {
    const entries: Array<ZsetEntry> = [];
    for (let i = 0; i < raw.length; i += 2) entries.push({ member: raw[i], score: parseZsetScore(raw[i + 1]) });
    return { kind: "zset", entries };
  }
  const fields: Array<HashEntry> = [];
  for (let i = 0; i < raw.length; i += 2) fields.push({ field: raw[i], value: raw[i + 1], expiresAt: null });
  return { kind: "hash", fields };
}

function toExpiryMs(v: bigint): number | null {
  if (v < 0n) throw new RdbFormatError("negative member expiry");
  if (v === 0n) return null;
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

function decodeHashListpackEx(r: RdbReader, hasMinExpire: boolean): RestoredObject {
  if (hasMinExpire) r.i64le();
  const items = decodeListpackItems(r.string());
  if (items.length === 0 || items.length % 3 !== 0) throw new RdbFormatError("invalid hash listpack ex");
  const fields: Array<HashEntry> = [];
  for (let i = 0; i < items.length; i += 3) {
    fields.push({ field: items[i].bytes, value: items[i + 1].bytes, expiresAt: toExpiryMs(listpackInt(items[i + 2])) });
  }
  return { kind: "hash", fields };
}

function decodeHashMetadata(r: RdbReader, hasMinExpire: boolean): RestoredObject {
  const minExp = hasMinExpire ? r.i64le() : 0n;
  if (hasMinExpire && minExp < 0n) throw new RdbFormatError("negative hash minExpire");
  const count = r.lenNum();
  if (count === 0) throw new RdbFormatError("empty hash metadata");
  const fields: Array<HashEntry> = [];
  for (let i = 0; i < count; i++) {
    const ttlVal = r.lenBig();
    const expiresAt = ttlVal === 0n ? null : toExpiryMs(hasMinExpire ? minExp + ttlVal - 1n : ttlVal);
    fields.push({ field: r.string(), value: r.string(), expiresAt });
  }
  return { kind: "hash", fields };
}

function decodeSetListpackEx(r: RdbReader): RestoredObject {
  r.i64le();
  const items = decodeListpackItems(r.string());
  if (items.length === 0 || items.length % 2 !== 0) throw new RdbFormatError("invalid set listpack ex");
  const members: Array<SetEntry> = [];
  for (let i = 0; i < items.length; i += 2) {
    members.push({ member: items[i].bytes, expiresAt: toExpiryMs(listpackInt(items[i + 1])) });
  }
  return { kind: "set", members };
}

function decodeSetMetadata(r: RdbReader): RestoredObject {
  const minExp = r.i64le();
  if (minExp < 0n) throw new RdbFormatError("negative set minExpire");
  const count = r.lenNum();
  if (count === 0) throw new RdbFormatError("empty set metadata");
  const members: Array<SetEntry> = [];
  for (let i = 0; i < count; i++) {
    const ttlVal = r.lenBig();
    const expiresAt = ttlVal === 0n ? null : toExpiryMs(minExp + ttlVal - 1n);
    members.push({ member: r.string(), expiresAt });
  }
  return { kind: "set", members };
}

export function decodeDumpObject(r: RdbReader): RestoredObject {
  const rdbType = r.u8();
  switch (rdbType) {
    case RDB_TYPE.string:
      return { kind: "string", value: r.string() };
    case RDB_TYPE.list: {
      const count = r.lenNum();
      if (count === 0) throw new RdbFormatError("empty list");
      const items: Array<Uint8Array> = [];
      for (let i = 0; i < count; i++) items.push(r.string());
      return { kind: "list", items };
    }
    case RDB_TYPE.listZiplist: {
      const items = decodeZiplist(r.string());
      if (items.length === 0) throw new RdbFormatError("empty list ziplist");
      return { kind: "list", items };
    }
    case RDB_TYPE.listQuicklist: {
      const nodes = r.lenNum();
      if (nodes === 0) throw new RdbFormatError("empty quicklist");
      const items: Array<Uint8Array> = [];
      for (let i = 0; i < nodes; i++) items.push(...decodeZiplist(r.string()));
      if (items.length === 0) throw new RdbFormatError("empty quicklist items");
      return { kind: "list", items };
    }
    case RDB_TYPE.listQuicklist2: {
      const nodes = r.lenNum();
      if (nodes === 0) throw new RdbFormatError("empty quicklist2");
      const items: Array<Uint8Array> = [];
      for (let i = 0; i < nodes; i++) {
        const container = r.lenNum();
        if (container === QUICKLIST_PLAIN) items.push(r.string());
        else if (container === QUICKLIST_PACKED) items.push(...decodeListpack(r.string()));
        else throw new RdbFormatError("unknown quicklist2 container");
      }
      if (items.length === 0) throw new RdbFormatError("empty quicklist2 items");
      return { kind: "list", items };
    }
    case RDB_TYPE.set: {
      const count = r.lenNum();
      if (count === 0) throw new RdbFormatError("empty set");
      const members: Array<SetEntry> = [];
      for (let i = 0; i < count; i++) members.push({ member: r.string(), expiresAt: null });
      return { kind: "set", members };
    }
    case RDB_TYPE.setIntset:
      return { kind: "set", members: decodeIntset(r.string()).map((member) => ({ member, expiresAt: null })) };
    case RDB_TYPE.setListpack: {
      const raw = decodeListpack(r.string());
      if (raw.length === 0) throw new RdbFormatError("empty set listpack");
      return { kind: "set", members: raw.map((member) => ({ member, expiresAt: null })) };
    }
    case RDB_TYPE.setListpackEx:
      return decodeSetListpackEx(r);
    case RDB_TYPE.setMetadata:
      return decodeSetMetadata(r);
    case RDB_TYPE.zset:
    case RDB_TYPE.zset2: {
      const count = r.lenNum();
      if (count === 0) throw new RdbFormatError("empty zset");
      const entries: Array<ZsetEntry> = [];
      for (let i = 0; i < count; i++) {
        const member = r.string();
        const score = rdbType === RDB_TYPE.zset2 ? r.f64le() : r.legacyDouble();
        if (Number.isNaN(score)) throw new RdbFormatError("NaN zset score");
        entries.push({ member, score });
      }
      return { kind: "zset", entries };
    }
    case RDB_TYPE.zsetZiplist:
      return decodePairedFlat(decodeZiplist(r.string()), "zset");
    case RDB_TYPE.zsetListpack:
      return decodePairedFlat(decodeListpack(r.string()), "zset");
    case RDB_TYPE.hash: {
      const count = r.lenNum();
      if (count === 0) throw new RdbFormatError("empty hash");
      const fields: Array<HashEntry> = [];
      for (let i = 0; i < count; i++) fields.push({ field: r.string(), value: r.string(), expiresAt: null });
      return { kind: "hash", fields };
    }
    case RDB_TYPE.hashZiplist:
      return decodePairedFlat(decodeZiplist(r.string()), "hash");
    case RDB_TYPE.hashListpack:
      return decodePairedFlat(decodeListpack(r.string()), "hash");
    case RDB_TYPE.hashMetadataPreGa:
      return decodeHashMetadata(r, false);
    case RDB_TYPE.hashMetadata:
      return decodeHashMetadata(r, true);
    case RDB_TYPE.hashListpackExPreGa:
      return decodeHashListpackEx(r, false);
    case RDB_TYPE.hashListpackEx:
      return decodeHashListpackEx(r, true);
    case RDB_TYPE.streamListpacks:
    case RDB_TYPE.streamListpacks2:
    case RDB_TYPE.streamListpacks3:
    case RDB_TYPE.streamListpacks4:
      return { kind: "stream", stream: decodeStream(r, rdbType) };
    case RDB_TYPE.module2:
      return { kind: "module", module: decodePrivateModule(r) };
    default:
      throw new RdbFormatError(`unsupported RDB object type ${rdbType}`);
  }
}

function validateSizes(key: Uint8Array, obj: RestoredObject) {
  switch (obj.kind) {
    case "string":
      checkSize(key, obj.value);
      break;
    case "list":
      for (const item of obj.items) checkSize(key, item);
      break;
    case "set":
      for (const m of obj.members) checkSize(key, m.member);
      break;
    case "zset":
      for (const e of obj.entries) checkSize(key, e.member);
      break;
    case "hash":
      for (const f of obj.fields) checkSize(key, f.field, f.value);
      break;
    case "stream":
      checkStreamSizes(key, obj.stream);
      break;
    case "module":
      checkModuleSizes(key, obj.module);
      break;
  }
}

export function restoreObject(ctx: Ctx, key: Uint8Array, expiresAt: number | null, replace: boolean, obj: RestoredObject) {
  validateSizes(key, obj);
  if (replace) ctx.ks.delete(key);
  if (expiresAt !== null && expiresAt <= ctx.now) return;
  switch (obj.kind) {
    case "string":
      ctx.ks.create(key, TYPE.string, obj.value, expiresAt);
      break;
    case "list": {
      const id = ctx.ks.create(key, TYPE.list, null, expiresAt);
      for (let i = 0; i < obj.items.length; i++) {
        ctx.ks.sql.exec("INSERT INTO list_items (key_id, pos, value) VALUES (?, ?, ?)", id, i, blob(obj.items[i]));
      }
      break;
    }
    case "set": {
      const id = ctx.ks.create(key, TYPE.set, null, expiresAt);
      for (const m of obj.members) {
        ctx.ks.sql.exec(
          "INSERT INTO set_members (key_id, member, expires_at) VALUES (?, ?, ?) ON CONFLICT (key_id, member) DO UPDATE SET expires_at = excluded.expires_at",
          id, blob(m.member), m.expiresAt,
        );
      }
      break;
    }
    case "zset": {
      const id = ctx.ks.create(key, TYPE.zset, null, expiresAt);
      for (const e of obj.entries) {
        ctx.ks.sql.exec(
          "INSERT INTO zset_members (key_id, member, score) VALUES (?, ?, ?) ON CONFLICT (key_id, member) DO UPDATE SET score = excluded.score",
          id, blob(e.member), Object.is(e.score, -0) ? 0 : e.score,
        );
      }
      break;
    }
    case "hash": {
      const id = ctx.ks.create(key, TYPE.hash, null, expiresAt);
      for (const f of obj.fields) {
        ctx.ks.sql.exec(
          "INSERT INTO hash_fields (key_id, field, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, field) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
          id, blob(f.field), blob(f.value), f.expiresAt,
        );
      }
      break;
    }
    case "stream":
      writeStream(ctx, key, expiresAt, obj.stream);
      break;
    case "module":
      writePrivateModule(ctx, key, expiresAt, obj.module);
      break;
  }
}
