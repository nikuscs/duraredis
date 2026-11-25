import { bytes, r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob, checkSize, fromBlob, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { sha256 } from "../store/sha256";
import { ERR, int, int64, INT64_MAX, opt, toInt64 } from "./args";
import { block } from "./blocking";
import { keyless, spec } from "./types";
import type { Ctx, Outcome, Table } from "./types";

interface StreamId {
  ms: bigint;
  seq: bigint;
}

interface StreamMeta {
  lastId: StreamId;
  maxDeletedId: StreamId;
  entriesAdded: bigint;
  idmpDuration: number;
  idmpMaxsize: number;
  iidsAdded: bigint;
  iidsDuplicates: bigint;
}

interface StreamGroup {
  name: Uint8Array;
  lastId: StreamId;
  entriesRead: bigint | null;
}

interface StreamConsumer {
  name: Uint8Array;
  seenTime: number;
  activeTime: number;
}

interface PelRow {
  entryId: StreamId;
  consumerName: Uint8Array | null;
  deliveryTime: number;
  deliveryCount: bigint;
  seq: number;
}

type RefMode = "KEEPREF" | "DELREF" | "ACKED";

interface TrimOpt {
  kind: "MAXLEN" | "MINID";
  approx: boolean;
  thresholdLen: number;
  thresholdId: StreamId;
  limit: number;
  refMode: RefMode;
}

interface ParsedTrim {
  trim: TrimOpt;
  refMode: RefMode | undefined;
  next: number;
}

interface ParsedIdsClause {
  refMode: RefMode;
  rawIds: Array<Uint8Array>;
  count: number;
}

interface GroupRef {
  sid: number;
  group: StreamGroup;
}

type IdmpSpec =
  | { kind: "explicit"; pid: Uint8Array; iid: Uint8Array }
  | { kind: "auto"; pid: Uint8Array };

type ClaimCandidate = {
  entry_id: ArrayBuffer;
  delivery_time: number;
  delivery_count: string;
};

const UINT64_MAX = (1n << 64n) - 1n;
const ZERO_ID: StreamId = { ms: 0n, seq: 0n };
const MAX_ID: StreamId = { ms: UINT64_MAX, seq: UINT64_MAX };
const NODE_MAX_ENTRIES = 100;
const DEFAULT_APPROX_LIMIT = 100 * NODE_MAX_ENTRIES;
const BAD_ID = "ERR Invalid stream ID specified as stream command argument";
const NO_KEY_GROUP = "ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.";

const XGROUP_HELP = [
  "XGROUP <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "CREATE <key> <groupname> <id|$> [option]",
  "    Create a new consumer group. Options are:",
  "    * MKSTREAM",
  "      Create the empty stream if it does not exist.",
  "    * ENTRIESREAD entries_read",
  "      Set the group's entries_read counter (internal use).",
  "CREATECONSUMER <key> <groupname> <consumer>",
  "    Create a new consumer in the specified group.",
  "DELCONSUMER <key> <groupname> <consumer>",
  "    Remove the specified consumer.",
  "DESTROY <key> <groupname>",
  "    Remove the specified group.",
  "SETID <key> <groupname> <id|$> [ENTRIESREAD entries_read]",
  "    Set the current group ID and entries_read counter.",
  "HELP",
  "    Print this help.",
];

const XINFO_HELP = [
  "XINFO <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "CONSUMERS <key> <groupname>",
  "    Show consumers of <groupname>.",
  "GROUPS <key>",
  "    Show the stream consumer groups.",
  "STREAM <key> [FULL [COUNT <count>]",
  "    Show information about the stream.",
  "HELP",
  "    Print this help.",
];

function encodeId(id: StreamId): ArrayBuffer {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, id.ms, false);
  v.setBigUint64(8, id.seq, false);
  return b.buffer;
}

function decodeId(raw: ArrayBuffer): StreamId {
  const v = new DataView(raw);
  return { ms: v.getBigUint64(0, false), seq: v.getBigUint64(8, false) };
}

const formatId = (id: StreamId) => `${id.ms}-${id.seq}`;

function cmpId(a: StreamId, b: StreamId): number {
  if (a.ms !== b.ms) return a.ms < b.ms ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

function incId(id: StreamId): StreamId | undefined {
  if (id.seq < UINT64_MAX) return { ms: id.ms, seq: id.seq + 1n };
  if (id.ms < UINT64_MAX) return { ms: id.ms + 1n, seq: 0n };
  return undefined;
}

function decId(id: StreamId): StreamId | undefined {
  if (id.seq > 0n) return { ms: id.ms, seq: id.seq - 1n };
  if (id.ms > 0n) return { ms: id.ms - 1n, seq: UINT64_MAX };
  return undefined;
}

const incDeliveryCount = (n: bigint): bigint => (n < INT64_MAX ? n + 1n : INT64_MAX);

function parseUint64(s: string): bigint | undefined {
  if (!/^\d{1,20}$/.test(s)) return undefined;
  const n = BigInt(s);
  return n <= UINT64_MAX ? n : undefined;
}

function parsePositiveInt64(b: Uint8Array, nonIntErr: string, nonPosErr: string): bigint {
  const n = toInt64(b);
  if (n === undefined) throw new RedisError(nonIntErr);
  if (n <= 0n) throw new RedisError(nonPosErr);
  return n;
}

function parseStrictId(b: Uint8Array, defaultSeq = 0n): StreamId | undefined {
  const s = text(b);
  const dash = s.indexOf("-");
  if (dash === -1) {
    const ms = parseUint64(s);
    return ms === undefined ? undefined : { ms, seq: defaultSeq };
  }
  if (s.indexOf("-", dash + 1) !== -1) return undefined;
  const ms = parseUint64(s.slice(0, dash));
  const seq = parseUint64(s.slice(dash + 1));
  if (ms === undefined || seq === undefined) return undefined;
  return { ms, seq };
}

function requireId(b: Uint8Array, defaultSeq = 0n): StreamId {
  const id = parseStrictId(b, defaultSeq);
  if (!id) throw new RedisError(BAD_ID);
  return id;
}

function parseBound(b: Uint8Array, high: boolean, label: "start" | "end"): StreamId {
  const s = text(b);
  if (s === "-") return ZERO_ID;
  if (s === "+") return MAX_ID;
  const exclusive = s.startsWith("(");
  const raw = exclusive ? s.slice(1) : s;
  if (exclusive && (raw === "-" || raw === "+")) throw new RedisError(BAD_ID);
  const parsed = parseStrictId(bytes(raw), high ? UINT64_MAX : 0n);
  if (!parsed) throw new RedisError(BAD_ID);
  if (!exclusive) return parsed;
  const adj = high ? decId(parsed) : incId(parsed);
  if (!adj) throw new RedisError(`ERR invalid ${label} ID for the interval`);
  return adj;
}

function parseRefMode(b: Uint8Array): RefMode | undefined {
  const o = opt(b);
  if (o === "KEEPREF" || o === "DELREF" || o === "ACKED") return o;
  return undefined;
}

function encodeFields(items: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const item of items) total += 4 + item.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const item of items) {
    view.setUint32(pos, item.length, false);
    pos += 4;
    out.set(item, pos);
    pos += item.length;
  }
  return out;
}

function decodeFields(raw: ArrayBuffer): Array<Uint8Array> {
  const buf = new Uint8Array(raw);
  const view = new DataView(raw);
  const out: Array<Uint8Array> = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = view.getUint32(pos, false);
    pos += 4;
    out.push(buf.subarray(pos, pos + len));
    pos += len;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function autoIdmpHash(fieldValues: Array<Uint8Array>): Uint8Array {
  const pairs: Array<Uint8Array> = [];
  let total = 0;
  for (let i = 0; i < fieldValues.length; i += 2) {
    const f = fieldValues[i];
    const v = fieldValues[i + 1];
    const item = new Uint8Array(8 + f.length + v.length);
    const view = new DataView(item.buffer);
    view.setUint32(0, f.length, false);
    item.set(f, 4);
    view.setUint32(4 + f.length, v.length, false);
    item.set(v, 8 + f.length);
    pairs.push(item);
    total += item.length;
  }
  pairs.sort(compareBytes);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of pairs) {
    out.set(p, pos);
    pos += p.length;
  }
  return sha256(out);
}

const respIntBytes = (n: number | bigint) => String(n).length + 3;
const respBulkBytes = (len: number) => String(len).length + len + 5;
const respArrBytes = (len: number) => String(len).length + 3;
const streamHeaderBytes = (key: Uint8Array, proto: 2 | 3) => (proto === 2 ? 4 : 0) + respBulkBytes(key.length);

function entryReplyBytes(id: StreamId, fields: Array<Uint8Array> | null, proto: 2 | 3, claimMeta?: [number, bigint]): number {
  const idBytes = respBulkBytes(formatId(id).length);
  let fieldsBytes = proto === 3 ? 3 : 5;
  if (fields !== null) {
    fieldsBytes = respArrBytes(fields.length);
    for (const f of fields) fieldsBytes += respBulkBytes(f.length);
  }
  if (claimMeta) return 4 + idBytes + fieldsBytes + respIntBytes(claimMeta[0]) + respIntBytes(claimMeta[1]);
  return 4 + idBytes + fieldsBytes;
}

function entryReply(id: StreamId, fields: Array<Uint8Array> | null, claimMeta?: [number, bigint]): Reply {
  const base = [r.bulk(formatId(id)), fields ? r.bulks(fields) : r.nilArray];
  if (claimMeta) base.push(r.int(claimMeta[0]), r.int(claimMeta[1]));
  return r.array(base);
}

function readReply(ctx: Ctx, results: Array<[Uint8Array, Array<Reply>]>): Reply {
  if (ctx.session.proto === 3) return r.map(results.map(([k, entries]) => [r.bulk(k), r.array(entries)]));
  return r.array(results.map(([k, entries]) => r.array([r.bulk(k), r.array(entries)])));
}

const streamId = (ctx: Ctx, key: Uint8Array): number | undefined => ctx.ks.getTyped(key, TYPE.stream)?.id;

function createStream(ctx: Ctx, key: Uint8Array): number {
  const id = ctx.ks.create(key, TYPE.stream);
  const zero = encodeId(ZERO_ID);
  ctx.ks.sql.exec("INSERT INTO stream_meta (key_id, last_id, max_deleted_id, entries_added) VALUES (?, ?, ?, ?)", id, zero, zero, "0");
  return id;
}

function readMeta(ctx: Ctx, id: number): StreamMeta {
  const row = ctx.ks.sql.exec<{
    last_id: ArrayBuffer;
    max_deleted_id: ArrayBuffer;
    entries_added: string;
    idmp_duration: number;
    idmp_maxsize: number;
    iids_added: string;
    iids_duplicates: string;
  }>(
    "SELECT last_id, max_deleted_id, entries_added, idmp_duration, idmp_maxsize, iids_added, iids_duplicates FROM stream_meta WHERE key_id = ?",
    id).one();
  return {
    lastId: decodeId(row.last_id),
    maxDeletedId: decodeId(row.max_deleted_id),
    entriesAdded: BigInt(row.entries_added),
    idmpDuration: row.idmp_duration,
    idmpMaxsize: row.idmp_maxsize,
    iidsAdded: BigInt(row.iids_added),
    iidsDuplicates: BigInt(row.iids_duplicates),
  };
}

function updateMaxDeletedId(ctx: Ctx, sid: number, maxDel: StreamId) {
  const meta = readMeta(ctx, sid);
  if (cmpId(maxDel, meta.maxDeletedId) > 0) {
    ctx.ks.sql.exec("UPDATE stream_meta SET max_deleted_id = ? WHERE key_id = ?", encodeId(maxDel), sid);
  }
}

function nextPelSeq(ctx: Ctx, sid: number): number {
  return ctx.ks.sql.exec<{ pel_seq: number }>("UPDATE stream_meta SET pel_seq = pel_seq + 1 WHERE key_id = ? RETURNING pel_seq", sid).one().pel_seq;
}

function nextIdmpSeq(ctx: Ctx, sid: number): number {
  return ctx.ks.sql.exec<{ idmp_seq: number }>("UPDATE stream_meta SET idmp_seq = idmp_seq + 1 WHERE key_id = ? RETURNING idmp_seq", sid).one().idmp_seq;
}

function streamLength(ctx: Ctx, id: number): number {
  return ctx.ks.sql.exec<{ n: number }>("SELECT count(*) AS n FROM stream_entries WHERE key_id = ?", id).one().n;
}

function edgeEntry(ctx: Ctx, id: number, order: "ASC" | "DESC"): { id: StreamId; fields: Array<Uint8Array> } | undefined {
  const row = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
    `SELECT entry_id, fields FROM stream_entries WHERE key_id = ? ORDER BY entry_id ${order} LIMIT 1`, id).toArray()[0];
  if (!row) return undefined;
  return { id: decodeId(row.entry_id), fields: decodeFields(row.fields) };
}

function entryFields(ctx: Ctx, id: number, entryId: StreamId): Array<Uint8Array> | null {
  const row = ctx.ks.sql.exec<{ fields: ArrayBuffer }>(
    "SELECT fields FROM stream_entries WHERE key_id = ? AND entry_id = ?", id, encodeId(entryId)).toArray()[0];
  return row ? decodeFields(row.fields) : null;
}

function readGroup(ctx: Ctx, id: number, name: Uint8Array): StreamGroup | undefined {
  const row = ctx.ks.sql.exec<{ name: ArrayBuffer; last_id: ArrayBuffer; entries_read: string | null }>(
    "SELECT name, last_id, entries_read FROM stream_groups WHERE key_id = ? AND name = ?", id, blob(name)).toArray()[0];
  if (!row) return undefined;
  return { name: fromBlob(row.name), lastId: decodeId(row.last_id), entriesRead: row.entries_read === null ? null : BigInt(row.entries_read) };
}

function readGroups(ctx: Ctx, id: number): Array<StreamGroup> {
  return ctx.ks.sql.exec<{ name: ArrayBuffer; last_id: ArrayBuffer; entries_read: string | null }>(
    "SELECT name, last_id, entries_read FROM stream_groups WHERE key_id = ? ORDER BY name ASC", id).toArray()
    .map((row) => ({ name: fromBlob(row.name), lastId: decodeId(row.last_id), entriesRead: row.entries_read === null ? null : BigInt(row.entries_read) }));
}

function requireGroup(ctx: Ctx, key: Uint8Array, groupName: Uint8Array, error: string): GroupRef {
  const sid = streamId(ctx, key);
  const group = sid === undefined ? undefined : readGroup(ctx, sid, groupName);
  if (sid === undefined || !group) throw new RedisError(error);
  return { sid, group };
}

function minGroupLastId(groups: Array<StreamGroup>): StreamId | undefined {
  let min: StreamId | undefined;
  for (const g of groups) {
    if (!min || cmpId(g.lastId, min) < 0) min = g.lastId;
  }
  return min;
}

function isAckedByAll(ctx: Ctx, sid: number, id: StreamId, minLastId: StreamId | undefined): boolean {
  if (minLastId === undefined) return true;
  if (cmpId(id, minLastId) > 0) return false;
  return ctx.ks.sql.exec("SELECT 1 FROM stream_pel WHERE key_id = ? AND entry_id = ? LIMIT 1", sid, encodeId(id)).toArray().length === 0;
}

function ensureConsumer(ctx: Ctx, sid: number, groupName: Uint8Array, name: Uint8Array, markActive: boolean): boolean {
  const existing = ctx.ks.sql.exec<{ active_time: number }>(
    "SELECT active_time FROM stream_consumers WHERE key_id = ? AND group_name = ? AND name = ?", sid, blob(groupName), blob(name)).toArray()[0];
  if (existing) {
    const active = markActive ? ctx.now : existing.active_time;
    ctx.ks.sql.exec("UPDATE stream_consumers SET seen_time = ?, active_time = ? WHERE key_id = ? AND group_name = ? AND name = ?",
      ctx.now, active, sid, blob(groupName), blob(name));
    return false;
  }
  ctx.ks.sql.exec("INSERT INTO stream_consumers (key_id, group_name, name, seen_time, active_time) VALUES (?, ?, ?, ?, ?)",
    sid, blob(groupName), blob(name), ctx.now, markActive ? ctx.now : -1);
  return true;
}

function readConsumers(ctx: Ctx, sid: number, groupName: Uint8Array): Array<StreamConsumer> {
  return ctx.ks.sql.exec<{ name: ArrayBuffer; seen_time: number; active_time: number }>(
    "SELECT name, seen_time, active_time FROM stream_consumers WHERE key_id = ? AND group_name = ? ORDER BY name ASC", sid, blob(groupName)).toArray()
    .map((row) => ({ name: fromBlob(row.name), seenTime: row.seen_time, activeTime: row.active_time }));
}

function readPel(ctx: Ctx, sid: number, groupName: Uint8Array): Array<PelRow> {
  return ctx.ks.sql.exec<{ entry_id: ArrayBuffer; consumer_name: ArrayBuffer | null; delivery_time: number; delivery_count: string; seq: number }>(
    "SELECT entry_id, consumer_name, delivery_time, delivery_count, seq FROM stream_pel WHERE key_id = ? AND group_name = ? ORDER BY entry_id ASC",
    sid, blob(groupName)).toArray()
    .map((row) => ({
      entryId: decodeId(row.entry_id),
      consumerName: row.consumer_name === null ? null : fromBlob(row.consumer_name),
      deliveryTime: row.delivery_time,
      deliveryCount: BigInt(row.delivery_count),
      seq: row.seq,
    }));
}

function groupLag(meta: StreamMeta, len: number, firstId: StreamId | undefined, group: StreamGroup): bigint | null {
  const total = BigInt(len);
  if (meta.entriesAdded === 0n || total === 0n) return 0n;
  if (group.entriesRead !== null && cmpId(meta.maxDeletedId, group.lastId) <= 0) {
    return meta.entriesAdded >= group.entriesRead ? meta.entriesAdded - group.entriesRead : 0n;
  }
  if (cmpId(group.lastId, meta.lastId) === 0) return 0n;
  if (cmpId(meta.maxDeletedId, group.lastId) > 0) return null;
  if (firstId && cmpId(group.lastId, firstId) < 0 && cmpId(meta.maxDeletedId, ZERO_ID) === 0 && meta.entriesAdded === total) return total;
  return null;
}

function parseTrim(args: Array<Uint8Array>, index: number, forXadd: boolean, hasRefMode: boolean): ParsedTrim {
  const kind = opt(args[index]) === "MAXLEN" ? "MAXLEN" : "MINID";
  const missing = forXadd ? "ERR wrong number of arguments for 'xadd' command" : ERR.syntax;
  let i = index + 1;
  if (i >= args.length) throw new RedisError(missing);
  let approx = false;
  const mod = text(args[i]);
  if (mod === "~" || mod === "=") {
    approx = mod === "~";
    i++;
    if (i >= args.length) throw new RedisError(missing);
  }
  let thresholdLen = 0;
  let thresholdId = ZERO_ID;
  if (kind === "MAXLEN") {
    const n = int64(args[i++]);
    if (n < 0n) throw new RedisError("ERR The MAXLEN argument must be >= 0.");
    thresholdLen = Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n);
  } else {
    thresholdId = requireId(args[i++]);
  }
  let refMode: RefMode | undefined;
  if (!hasRefMode && i < args.length) {
    const maybeRef = parseRefMode(args[i]);
    if (maybeRef) {
      refMode = maybeRef;
      i++;
    }
  }
  let limit = approx ? DEFAULT_APPROX_LIMIT : 0;
  if (i < args.length && opt(args[i]) === "LIMIT") {
    if (!approx) throw new RedisError("ERR syntax error, LIMIT cannot be used without the special ~ option");
    i++;
    if (i >= args.length) throw new RedisError(missing);
    const lim = int64(args[i++]);
    if (lim < 0n) throw new RedisError("ERR The LIMIT argument must be >= 0.");
    limit = Number(lim > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : lim);
  }
  return { trim: { kind, approx, thresholdLen, thresholdId, limit, refMode: refMode ?? "KEEPREF" }, refMode, next: i };
}

function nextNode(ctx: Ctx, sid: number): number {
  const row = ctx.ks.sql.exec<{ node: number; node_fill: number }>("SELECT node, node_fill FROM stream_meta WHERE key_id = ?", sid).one();
  const node = row.node_fill >= NODE_MAX_ENTRIES ? row.node + 1 : row.node;
  const fill = row.node_fill >= NODE_MAX_ENTRIES ? 1 : row.node_fill + 1;
  ctx.ks.sql.exec("UPDATE stream_meta SET node = ?, node_fill = ? WHERE key_id = ?", node, fill, sid);
  return node;
}

function trimNodes(ctx: Ctx, sid: number, trim: TrimOpt): number {
  const nodes = ctx.ks.sql.exec<{ node: number; entries: number; last: ArrayBuffer }>(
    "SELECT node, count(*) AS entries, max(entry_id) AS last FROM stream_entries WHERE key_id = ? GROUP BY node ORDER BY node", sid).toArray();
  let length = nodes.reduce((sum, n) => sum + n.entries, 0);
  let deleted = 0;
  for (const n of nodes) {
    if (trim.kind === "MAXLEN" && length - n.entries < trim.thresholdLen) break;
    if (trim.kind === "MINID" && cmpId(decodeId(n.last), trim.thresholdId) >= 0) break;
    if (trim.limit && deleted + n.entries > trim.limit) break;
    ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND node = ?", sid, n.node);
    length -= n.entries;
    deleted += n.entries;
  }
  return deleted;
}

function trimNodesWithRef(ctx: Ctx, sid: number, trim: TrimOpt): number {
  const nodes = ctx.ks.sql.exec<{ node: number; entries: number }>(
    "SELECT node, count(*) AS entries FROM stream_entries WHERE key_id = ? GROUP BY node ORDER BY node", sid).toArray();
  let length = nodes.reduce((sum, n) => sum + n.entries, 0);
  let deleted = 0;
  const minLast = trim.refMode === "ACKED" ? minGroupLastId(readGroups(ctx, sid)) : undefined;
  for (const n of nodes) {
    if (trim.limit && deleted + n.entries > trim.limit) break;
    if (trim.kind === "MAXLEN" && length <= trim.thresholdLen) break;
    const rows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
      "SELECT entry_id FROM stream_entries WHERE key_id = ? AND node = ? ORDER BY entry_id ASC", sid, n.node).toArray();
    let stop = false;
    for (const row of rows) {
      if (trim.kind === "MAXLEN" && length <= trim.thresholdLen) {
        stop = true;
        break;
      }
      const id = decodeId(row.entry_id);
      if (trim.kind === "MINID" && cmpId(id, trim.thresholdId) >= 0) {
        stop = true;
        break;
      }
      if (trim.refMode === "ACKED") {
        if (minLast && cmpId(id, minLast) > 0) {
          stop = true;
          break;
        }
        if (!isAckedByAll(ctx, sid, id, minLast)) continue;
      }
      ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND entry_id = ?", sid, row.entry_id);
      if (trim.refMode === "DELREF") ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND entry_id = ?", sid, row.entry_id);
      length--;
      deleted++;
    }
    if (stop) break;
  }
  return deleted;
}

function deleteExactKeepRef(ctx: Ctx, sid: number, trim: TrimOpt): Array<ArrayBuffer> {
  if (trim.kind === "MAXLEN") {
    const excess = streamLength(ctx, sid) - trim.thresholdLen;
    if (excess <= 0) return [];
    const count = trim.limit > 0 ? Math.min(excess, trim.limit) : excess;
    return ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
      "DELETE FROM stream_entries WHERE key_id = ? AND entry_id IN (SELECT entry_id FROM stream_entries WHERE key_id = ? ORDER BY entry_id ASC LIMIT ?) RETURNING entry_id",
      sid, sid, count).toArray().map((row) => row.entry_id);
  }
  const minBlob = encodeId(trim.thresholdId);
  if (trim.limit > 0) {
    return ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
      "DELETE FROM stream_entries WHERE key_id = ? AND entry_id IN (SELECT entry_id FROM stream_entries WHERE key_id = ? AND entry_id < ? ORDER BY entry_id ASC LIMIT ?) RETURNING entry_id",
      sid, sid, minBlob, trim.limit).toArray().map((row) => row.entry_id);
  }
  return ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
    "DELETE FROM stream_entries WHERE key_id = ? AND entry_id < ? RETURNING entry_id", sid, minBlob).toArray().map((row) => row.entry_id);
}

function applyTrim(ctx: Ctx, sid: number, trim: TrimOpt): number {
  if (trim.approx) return trim.refMode === "KEEPREF" ? trimNodes(ctx, sid, trim) : trimNodesWithRef(ctx, sid, trim);
  if (trim.refMode !== "ACKED") {
    const removed = deleteExactKeepRef(ctx, sid, trim);
    if (trim.refMode === "DELREF") {
      for (const id of removed) ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND entry_id = ?", sid, id);
    }
    return removed.length;
  }
  const minLast = minGroupLastId(readGroups(ctx, sid));
  if (minLast === undefined) return deleteExactKeepRef(ctx, sid, trim).length;
  let length = streamLength(ctx, sid);
  if (trim.kind === "MAXLEN" && length <= trim.thresholdLen) return 0;
  const rows = trim.kind === "MAXLEN"
    ? ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>("SELECT entry_id FROM stream_entries WHERE key_id = ? ORDER BY entry_id ASC", sid).toArray()
    : ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>("SELECT entry_id FROM stream_entries WHERE key_id = ? AND entry_id < ? ORDER BY entry_id ASC", sid, encodeId(trim.thresholdId)).toArray();
  let deleted = 0;
  for (const row of rows) {
    if (trim.kind === "MAXLEN" && length <= trim.thresholdLen) break;
    const id = decodeId(row.entry_id);
    if (cmpId(id, minLast) > 0) break;
    if (!isAckedByAll(ctx, sid, id, minLast)) continue;
    ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND entry_id = ?", sid, row.entry_id);
    length--;
    deleted++;
  }
  return deleted;
}

function purgeExpiredIdmp(ctx: Ctx, sid: number, durationSec: number) {
  ctx.ks.sql.exec("DELETE FROM stream_idmp WHERE key_id = ? AND created_at <= ?", sid, ctx.now - durationSec * 1000);
}

function recordIdmp(ctx: Ctx, sid: number, meta: StreamMeta, pid: Uint8Array, iid: Uint8Array, id: StreamId) {
  const seq = nextIdmpSeq(ctx, sid);
  ctx.ks.sql.exec(
    "INSERT INTO stream_idmp (key_id, pid, iid, entry_id, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)",
    sid, blob(pid), blob(iid), encodeId(id), ctx.now, seq);
  ctx.ks.sql.exec(
    "DELETE FROM stream_idmp WHERE key_id = ? AND pid = ? AND seq NOT IN (SELECT seq FROM stream_idmp WHERE key_id = ? AND pid = ? ORDER BY seq DESC LIMIT ?)",
    sid, blob(pid), sid, blob(pid), meta.idmpMaxsize);
  ctx.ks.sql.exec("UPDATE stream_meta SET iids_added = ? WHERE key_id = ?", String(meta.iidsAdded + 1n), sid);
}

function nextAutoId(lastId: StreamId, nowMs: bigint): StreamId {
  if (nowMs > lastId.ms) return { ms: nowMs, seq: 0n };
  const next = incId(lastId);
  if (!next) throw new RedisError("ERR The stream has exhausted the last possible ID, unable to add more items");
  return next;
}

function nextPartialId(lastId: StreamId, ms: bigint): StreamId {
  if (ms < lastId.ms) throw new RedisError("ERR The ID specified in XADD is equal or smaller than the target stream top item");
  if (ms === lastId.ms) {
    const next = incId(lastId);
    if (!next) throw new RedisError("ERR The stream has exhausted the last possible ID, unable to add more items");
    return next;
  }
  return { ms, seq: 0n };
}

function parseAddId(arg: Uint8Array, idmp: boolean): { kind: "auto" } | { kind: "partial"; ms: bigint } | { kind: "explicit"; id: StreamId } {
  const s = text(arg);
  if (s === "*") return { kind: "auto" };
  if (s.endsWith("-*")) {
    const ms = parseUint64(s.slice(0, -2));
    if (ms === undefined) throw new RedisError(BAD_ID);
    if (idmp) throw new RedisError("ERR syntax error, IDMP/IDMPAUTO can be used only with auto-generated IDs");
    return { kind: "partial", ms };
  }
  const id = requireId(arg);
  if (idmp) throw new RedisError("ERR syntax error, IDMP/IDMPAUTO can be used only with auto-generated IDs");
  if (cmpId(id, ZERO_ID) === 0) throw new RedisError("ERR The ID specified in XADD must be greater than 0-0");
  return { kind: "explicit", id };
}

function xadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  let nomkstream = false;
  let refMode: RefMode | undefined;
  let trim: TrimOpt | undefined;
  let idmp: IdmpSpec | undefined;
  let i = 2;
  while (i < args.length) {
    const o = opt(args[i]);
    if (o === "NOMKSTREAM") {
      nomkstream = true;
      i++;
      continue;
    }
    const maybeRef = parseRefMode(args[i]);
    if (maybeRef) {
      if (refMode !== undefined) break;
      refMode = maybeRef;
      i++;
      continue;
    }
    if (o === "IDMP") {
      if (idmp) throw new RedisError("ERR syntax error, IDMP/IDMPAUTO specified multiple times");
      if (i + 2 >= args.length) break;
      idmp = { kind: "explicit", pid: args[i + 1], iid: args[i + 2] };
      i += 3;
      continue;
    }
    if (o === "IDMPAUTO") {
      if (idmp) throw new RedisError("ERR syntax error, IDMP/IDMPAUTO specified multiple times");
      if (i + 1 >= args.length) break;
      idmp = { kind: "auto", pid: args[i + 1] };
      i += 2;
      continue;
    }
    if (o === "MAXLEN" || o === "MINID") {
      if (trim) throw new RedisError("ERR syntax error, MAXLEN and MINID options at the same time are not compatible");
      const parsed = parseTrim(args, i, true, refMode !== undefined);
      trim = parsed.trim;
      refMode ??= parsed.refMode;
      i = parsed.next;
      continue;
    }
    break;
  }
  const rem = args.length - i;
  if (rem === 0) throw new RedisError("ERR wrong number of arguments for 'xadd' command");
  const specId = parseAddId(args[i], idmp !== undefined);
  if (rem < 3 || rem % 2 === 0) throw new RedisError("ERR wrong number of arguments for 'xadd' command");
  const fieldValues = args.slice(i + 1);
  const encoded = encodeFields(fieldValues);
  const existing = streamId(ctx, key);
  if (existing === undefined && nomkstream) return r.nil;
  const meta = existing === undefined
    ? { lastId: ZERO_ID, maxDeletedId: ZERO_ID, entriesAdded: 0n, idmpDuration: 100, idmpMaxsize: 100, iidsAdded: 0n, iidsDuplicates: 0n }
    : readMeta(ctx, existing);
  const iid = idmp ? (idmp.kind === "explicit" ? idmp.iid : autoIdmpHash(fieldValues)) : undefined;
  if (idmp && iid && existing !== undefined) {
    purgeExpiredIdmp(ctx, existing, meta.idmpDuration);
    const dup = ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
      "SELECT entry_id FROM stream_idmp WHERE key_id = ? AND pid = ? AND iid = ?",
      existing, blob(idmp.pid), blob(iid)).toArray()[0];
    if (dup) {
      ctx.ks.sql.exec("UPDATE stream_meta SET iids_duplicates = ? WHERE key_id = ?", String(meta.iidsDuplicates + 1n), existing);
      return r.bulk(formatId(decodeId(dup.entry_id)));
    }
  }
  let id: StreamId;
  if (specId.kind === "auto") {
    id = nextAutoId(meta.lastId, BigInt(ctx.now));
  } else if (specId.kind === "partial") {
    id = nextPartialId(meta.lastId, specId.ms);
  } else {
    if (cmpId(specId.id, meta.lastId) <= 0) throw new RedisError("ERR The ID specified in XADD is equal or smaller than the target stream top item");
    id = specId.id;
  }
  checkSize(key, encoded);
  const sid = existing ?? createStream(ctx, key);
  const node = nextNode(ctx, sid);
  ctx.ks.sql.exec("INSERT INTO stream_entries (key_id, entry_id, fields, node) VALUES (?, ?, ?, ?)", sid, encodeId(id), blob(encoded), node);
  ctx.ks.sql.exec("UPDATE stream_meta SET last_id = ?, entries_added = ? WHERE key_id = ?", encodeId(id), String(meta.entriesAdded + 1n), sid);
  if (idmp && iid) recordIdmp(ctx, sid, meta, idmp.pid, iid, id);
  if (trim) applyTrim(ctx, sid, { ...trim, refMode: refMode ?? "KEEPREF" });
  ctx.ks.onChange(key);
  return r.bulk(formatId(id));
}

function xlen(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const sid = streamId(ctx, key);
  return r.int(sid === undefined ? 0 : streamLength(ctx, sid));
}

function rangeCmd(ctx: Ctx, args: Array<Uint8Array>, rev: boolean): Reply {
  if (args.length !== 4 && (args.length !== 6 || opt(args[4]) !== "COUNT")) throw new RedisError(ERR.syntax);
  const min = rev ? parseBound(args[3], false, "end") : parseBound(args[2], false, "start");
  const max = rev ? parseBound(args[2], true, "start") : parseBound(args[3], true, "end");
  const count = args.length === 6 ? int(args[5]) : undefined;
  const sid = streamId(ctx, args[1]);
  if (sid === undefined) return r.array([]);
  if (count !== undefined && count <= 0) return r.nilArray;
  if (cmpId(min, max) > 0) return r.array([]);
  const dir = rev ? "DESC" : "ASC";
  const rows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
    `SELECT entry_id, fields FROM stream_entries WHERE key_id = ? AND entry_id >= ? AND entry_id <= ? ORDER BY entry_id ${dir} LIMIT ?`,
    sid, encodeId(min), encodeId(max), count ?? -1).toArray();
  return r.array(rows.map((row) => entryReply(decodeId(row.entry_id), decodeFields(row.fields))));
}

function xdel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const sid = streamId(ctx, key);
  if (sid === undefined) return r.int(0);
  const ids = args.slice(2).map((a) => requireId(a));
  let deleted = 0;
  let maxDel: StreamId | undefined;
  for (const id of ids) {
    const n = ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND entry_id = ? RETURNING entry_id", sid, encodeId(id)).toArray().length;
    if (!n) continue;
    deleted += n;
    if (!maxDel || cmpId(id, maxDel) > 0) maxDel = id;
  }
  if (!deleted || !maxDel) return r.int(0);
  updateMaxDeletedId(ctx, sid, maxDel);
  ctx.ks.onChange(key);
  return r.int(deleted);
}

function parseIdsClause(args: Array<Uint8Array>, startIdx: number): ParsedIdsClause {
  let i = startIdx;
  let refMode: RefMode = "KEEPREF";
  if (i < args.length) {
    const maybeRef = parseRefMode(args[i]);
    if (maybeRef) {
      refMode = maybeRef;
      i++;
    }
  }
  if (i >= args.length || opt(args[i]) !== "IDS") throw new RedisError(ERR.syntax);
  i++;
  if (i >= args.length) throw new RedisError(ERR.syntax);
  const numIds = parsePositiveInt64(args[i++], "ERR Number of IDs must be a positive integer", "ERR Number of IDs must be a positive integer");
  const rem = BigInt(args.length - i);
  if (rem < numIds) throw new RedisError("ERR The `numids` parameter must match the number of arguments");
  if (rem > numIds) throw new RedisError(ERR.syntax);
  return { refMode, rawIds: args.slice(i), count: Number(numIds) };
}

function xdelex(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const sid = streamId(ctx, key);
  const { refMode, rawIds, count } = parseIdsClause(args, 2);
  if (sid === undefined) return r.array(Array.from({ length: count }, () => r.int(-1)));
  const ids = rawIds.map((a) => requireId(a));
  const minLast = refMode === "ACKED" ? minGroupLastId(readGroups(ctx, sid)) : undefined;
  const results: Array<Reply> = [];
  let maxDel: StreamId | undefined;
  let mutated = false;
  for (const id of ids) {
    const idBlob = encodeId(id);
    if (refMode === "ACKED" && !isAckedByAll(ctx, sid, id, minLast)) {
      results.push(r.int(2));
      continue;
    }
    const deleted = ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND entry_id = ? RETURNING entry_id", sid, idBlob).toArray().length > 0;
    if (refMode === "DELREF") {
      if (ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND entry_id = ? RETURNING entry_id", sid, idBlob).toArray().length > 0) mutated = true;
    }
    if (deleted) {
      if (!maxDel || cmpId(id, maxDel) > 0) maxDel = id;
      mutated = true;
      results.push(r.int(1));
    } else {
      results.push(r.int(-1));
    }
  }
  if (maxDel) updateMaxDeletedId(ctx, sid, maxDel);
  if (mutated) ctx.ks.onChange(key);
  return r.array(results);
}

function xackdel(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group] = args;
  const sid = streamId(ctx, key);
  const { refMode, rawIds, count } = parseIdsClause(args, 3);
  if (sid === undefined || !readGroup(ctx, sid, group)) return r.array(Array.from({ length: count }, () => r.int(-1)));
  const ids = rawIds.map((a) => requireId(a));
  const minLast = refMode === "ACKED" ? minGroupLastId(readGroups(ctx, sid)) : undefined;
  const results: Array<Reply> = [];
  let maxDel: StreamId | undefined;
  let mutated = false;
  for (const id of ids) {
    const idBlob = encodeId(id);
    const acked = ctx.ks.sql.exec(
      "DELETE FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ? RETURNING entry_id",
      sid, blob(group), idBlob).toArray().length > 0;
    if (!acked) {
      results.push(r.int(-1));
      continue;
    }
    mutated = true;
    if (refMode === "ACKED" && !isAckedByAll(ctx, sid, id, minLast)) {
      results.push(r.int(2));
      continue;
    }
    const deleted = ctx.ks.sql.exec("DELETE FROM stream_entries WHERE key_id = ? AND entry_id = ? RETURNING entry_id", sid, idBlob).toArray().length > 0;
    if (deleted && (!maxDel || cmpId(id, maxDel) > 0)) maxDel = id;
    if (refMode === "DELREF") ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND entry_id = ?", sid, idBlob);
    results.push(r.int(1));
  }
  if (maxDel) updateMaxDeletedId(ctx, sid, maxDel);
  if (mutated) ctx.ks.onChange(key);
  return r.array(results);
}

function xtrim(ctx: Ctx, args: Array<Uint8Array>): Reply {
  let i = 2;
  let refMode: RefMode | undefined;
  const preRef = parseRefMode(args[i]);
  if (preRef) {
    refMode = preRef;
    i++;
  }
  if (i >= args.length) throw new RedisError(ERR.syntax);
  const o = opt(args[i]);
  if (o !== "MAXLEN" && o !== "MINID") throw new RedisError(ERR.syntax);
  const parsed = parseTrim(args, i, false, refMode !== undefined);
  refMode ??= parsed.refMode;
  i = parsed.next;
  if (i < args.length) {
    const postRef = parseRefMode(args[i]);
    if (!postRef || refMode !== undefined) throw new RedisError(ERR.syntax);
    refMode = postRef;
    i++;
  }
  if (i !== args.length) throw new RedisError(ERR.syntax);
  const sid = streamId(ctx, args[1]);
  if (sid === undefined) return r.int(0);
  const deleted = applyTrim(ctx, sid, { ...parsed.trim, refMode: refMode ?? "KEEPREF" });
  if (deleted) ctx.ks.onChange(args[1]);
  return r.int(deleted);
}

function xsetid(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  const lastId = requireId(args[2]);
  let entriesAdded: bigint | undefined;
  let maxDeletedId: StreamId | undefined;
  for (let i = 3; i < args.length; i += 2) {
    if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
    const o = opt(args[i]);
    if (o === "ENTRIESADDED") {
      entriesAdded = int64(args[i + 1]);
      if (entriesAdded < 0n) throw new RedisError("ERR entries_added must be positive");
    } else if (o === "MAXDELETEDID") {
      maxDeletedId = requireId(args[i + 1]);
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  const sid = streamId(ctx, key);
  if (sid === undefined) throw new RedisError("ERR no such key");
  if (maxDeletedId && cmpId(maxDeletedId, ZERO_ID) > 0 && cmpId(lastId, maxDeletedId) < 0) {
    throw new RedisError("ERR The ID specified in XSETID is smaller than the provided max_deleted_entry_id");
  }
  const top = edgeEntry(ctx, sid, "DESC");
  if (top && cmpId(lastId, top.id) < 0) throw new RedisError("ERR The ID specified in XSETID is smaller than the target stream top item");
  const len = BigInt(streamLength(ctx, sid));
  if (entriesAdded !== undefined && entriesAdded < len) {
    throw new RedisError("ERR The entries_added specified in XSETID is smaller than the target stream length");
  }
  const meta = readMeta(ctx, sid);
  const nextAdded = entriesAdded ?? meta.entriesAdded;
  const nextMaxDel = maxDeletedId && cmpId(maxDeletedId, ZERO_ID) > 0 ? maxDeletedId : meta.maxDeletedId;
  ctx.ks.sql.exec("UPDATE stream_meta SET last_id = ?, max_deleted_id = ?, entries_added = ? WHERE key_id = ?",
    encodeId(lastId), encodeId(nextMaxDel), String(nextAdded), sid);
  ctx.ks.onChange(key);
  return r.ok;
}

function xcfgset(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const sid = streamId(ctx, args[1]);
  if (sid === undefined) throw new RedisError("ERR no such key");
  if (args.length === 2) throw new RedisError("ERR At least one parameter must be specified");
  let duration: number | undefined;
  let maxsize: number | undefined;
  for (let i = 2; i < args.length; i += 2) {
    const o = opt(args[i]);
    if (o === "IDMP-DURATION") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      if (duration !== undefined) throw new RedisError("ERR IDMP-DURATION specified multiple times");
      const v = int64(args[i + 1]);
      if (v < 1n || v > 86_400n) throw new RedisError("ERR IDMP-DURATION must be between 1 and 86400 seconds");
      duration = Number(v);
    } else if (o === "IDMP-MAXSIZE") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      if (maxsize !== undefined) throw new RedisError("ERR IDMP-MAXSIZE specified multiple times");
      const v = int64(args[i + 1]);
      if (v < 1n || v > 10_000n) throw new RedisError("ERR IDMP-MAXSIZE must be between 1 and 10000 entries");
      maxsize = Number(v);
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  const meta = readMeta(ctx, sid);
  const nextDuration = duration ?? meta.idmpDuration;
  const nextMaxsize = maxsize ?? meta.idmpMaxsize;
  if (nextDuration !== meta.idmpDuration || nextMaxsize !== meta.idmpMaxsize) {
    ctx.ks.sql.exec("UPDATE stream_meta SET idmp_duration = ?, idmp_maxsize = ? WHERE key_id = ?", nextDuration, nextMaxsize, sid);
    ctx.ks.sql.exec("DELETE FROM stream_idmp WHERE key_id = ?", sid);
    ctx.ks.onChange(args[1]);
  }
  return r.ok;
}

function xidmprecord(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, pid, iid, idArg] = args;
  const sid = streamId(ctx, key);
  if (sid === undefined) throw new RedisError("ERR no such key");
  const id = requireId(idArg);
  if (!entryFields(ctx, sid, id)) throw new RedisError("ERR No such message in stream");
  const meta = readMeta(ctx, sid);
  purgeExpiredIdmp(ctx, sid, meta.idmpDuration);
  const existing = ctx.ks.sql.exec<{ entry_id: ArrayBuffer }>(
    "SELECT entry_id FROM stream_idmp WHERE key_id = ? AND pid = ? AND iid = ?",
    sid, blob(pid), blob(iid)).toArray()[0];
  if (existing) {
    if (cmpId(decodeId(existing.entry_id), id) === 0) return r.ok;
    throw new RedisError("ERR IID already exists for this producer with a different stream ID");
  }
  recordIdmp(ctx, sid, meta, pid, iid, id);
  ctx.ks.onChange(key);
  return r.ok;
}

function blockTimeout(b: Uint8Array): number {
  const ms = int(b);
  if (ms < 0) throw new RedisError("ERR timeout is negative");
  return ms;
}

function canReadMore(totalEntries: bigint, usedBytes: bigint, maxCount: bigint | undefined, maxSize: bigint | undefined): boolean {
  if (maxCount !== undefined && totalEntries >= maxCount) return false;
  if (maxSize !== undefined && totalEntries > 0n && usedBytes >= maxSize) return false;
  return true;
}

function xread(ctx: Ctx, args: Array<Uint8Array>): Outcome {
  let count: number | undefined;
  let maxCount: bigint | undefined;
  let maxSize: bigint | undefined;
  let blockMs: number | undefined;
  let hasStreams = false;
  let i = 1;
  while (i < args.length) {
    const o = opt(args[i]);
    if (o === "STREAMS") {
      hasStreams = true;
      i++;
      break;
    }
    if (o === "COUNT" && i + 1 < args.length) {
      count = int(args[i + 1]);
      i += 2;
      continue;
    }
    if (o === "MAXCOUNT" && i + 1 < args.length) {
      maxCount = parsePositiveInt64(args[i + 1], ERR.int, "ERR MAXCOUNT must be a positive integer");
      i += 2;
      continue;
    }
    if (o === "MAXSIZE" && i + 1 < args.length) {
      maxSize = parsePositiveInt64(args[i + 1], ERR.int, "ERR MAXSIZE must be a positive integer");
      i += 2;
      continue;
    }
    if (o === "BLOCK" && i + 1 < args.length) {
      blockMs = blockTimeout(args[i + 1]);
      i += 2;
      continue;
    }
    throw new RedisError(ERR.syntax);
  }
  if (!hasStreams) throw new RedisError(ERR.syntax);
  const rest = args.slice(i);
  if (!rest.length || rest.length % 2 !== 0) {
    throw new RedisError("ERR Unbalanced 'xread' list of streams: for each stream key an ID, '+', or '$' must be specified.");
  }
  const n = rest.length / 2;
  const keys = rest.slice(0, n);
  const rawIds = rest.slice(n);
  const targets: Array<{ key: Uint8Array; sid: number | undefined; id: StreamId | "plus" }> = [];
  const retryIds: Array<Uint8Array> = [];
  for (let j = 0; j < n; j++) {
    const key = keys[j];
    const idArg = rawIds[j];
    const idStr = text(idArg);
    if (idStr === ">") throw new RedisError("ERR The > ID can be specified only when calling XREADGROUP using the GROUP <group> <consumer> option.");
    const sid = streamId(ctx, key);
    if (idStr === "$") {
      const last = sid === undefined ? ZERO_ID : readMeta(ctx, sid).lastId;
      targets.push({ key, sid, id: last });
      retryIds.push(bytes(formatId(last)));
    } else if (idStr === "+") {
      targets.push({ key, sid, id: "plus" });
      retryIds.push(idArg);
    } else {
      targets.push({ key, sid, id: requireId(idArg) });
      retryIds.push(idArg);
    }
  }
  const proto = ctx.session.proto;
  const limit = count !== undefined && count > 0 ? count : -1;
  const results: Array<[Uint8Array, Array<Reply>]> = [];
  let totalEntries = 0n;
  let usedBytes = 0n;
  for (const t of targets) {
    if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
    if (t.sid === undefined) continue;
    const rows: Array<{ id: StreamId; fields: Array<Uint8Array> }> = [];
    if (t.id === "plus") {
      const last = edgeEntry(ctx, t.sid, "DESC");
      if (last) rows.push(last);
    } else {
      const fetched = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
        "SELECT entry_id, fields FROM stream_entries WHERE key_id = ? AND entry_id > ? ORDER BY entry_id ASC LIMIT ?",
        t.sid, encodeId(t.id), limit).toArray();
      for (const row of fetched) rows.push({ id: decodeId(row.entry_id), fields: decodeFields(row.fields) });
    }
    if (!rows.length) continue;
    usedBytes += BigInt(streamHeaderBytes(t.key, proto));
    const entries: Array<Reply> = [];
    for (const row of rows) {
      if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
      entries.push(entryReply(row.id, row.fields));
      totalEntries++;
      usedBytes += BigInt(entryReplyBytes(row.id, row.fields, proto));
    }
    results.push([t.key, entries]);
    usedBytes += BigInt(respArrBytes(entries.length));
  }
  if (results.length) return readReply(ctx, results);
  if (blockMs !== undefined) return block(ctx, keys, blockMs, r.nilArray, [...args.slice(0, i), ...keys, ...retryIds]);
  return r.nilArray;
}

function parseGroupEntriesRead(b: Uint8Array): bigint | null {
  const n = int64(b);
  if (n < -1n) throw new RedisError("ERR value for ENTRIESREAD must be positive or -1");
  return n === -1n ? null : n;
}

function xgroupCreate(ctx: Ctx, args: Array<Uint8Array>, rawSub: string): Reply {
  if (args.length < 5) throw new RedisError("ERR wrong number of arguments for 'xgroup|create' command");
  const [, , key, group, idArg] = args;
  let mkstream = false;
  let entriesRead: bigint | null = null;
  for (let i = 5; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "MKSTREAM") mkstream = true;
    else if (o === "ENTRIESREAD" && i + 1 < args.length) entriesRead = parseGroupEntriesRead(args[++i]);
    else throw new RedisError(`ERR unknown subcommand or wrong number of arguments for '${rawSub}'. Try XGROUP HELP.`);
  }
  const existing = streamId(ctx, key);
  if (existing === undefined && !mkstream) throw new RedisError(NO_KEY_GROUP);
  const dollar = text(idArg) === "$";
  if (!dollar) requireId(idArg);
  const sid = existing ?? createStream(ctx, key);
  if (readGroup(ctx, sid, group)) throw new RedisError("BUSYGROUP Consumer Group name already exists");
  const lastId = dollar ? readMeta(ctx, sid).lastId : requireId(idArg);
  ctx.ks.sql.exec("INSERT INTO stream_groups (key_id, name, last_id, entries_read) VALUES (?, ?, ?, ?)",
    sid, blob(group), encodeId(lastId), entriesRead === null ? null : String(entriesRead));
  ctx.ks.onChange(key);
  return r.ok;
}

function xgroupSetId(ctx: Ctx, args: Array<Uint8Array>, rawSub: string): Reply {
  if (args.length < 5) throw new RedisError("ERR wrong number of arguments for 'xgroup|setid' command");
  const [, , key, group, idArg] = args;
  let entriesRead: bigint | null = null;
  for (let i = 5; i < args.length; i++) {
    if (opt(args[i]) === "ENTRIESREAD" && i + 1 < args.length) entriesRead = parseGroupEntriesRead(args[++i]);
    else throw new RedisError(`ERR unknown subcommand or wrong number of arguments for '${rawSub}'. Try XGROUP HELP.`);
  }
  const sid = streamId(ctx, key);
  if (sid === undefined) throw new RedisError(NO_KEY_GROUP);
  const dollar = text(idArg) === "$";
  const nextId = dollar ? readMeta(ctx, sid).lastId : requireId(idArg);
  if (!readGroup(ctx, sid, group)) throw new RedisError(`NOGROUP No such consumer group '${text(group)}' for key name '${text(key)}'`);
  ctx.ks.sql.exec("UPDATE stream_groups SET last_id = ?, entries_read = ? WHERE key_id = ? AND name = ?",
    encodeId(nextId), entriesRead === null ? null : String(entriesRead), sid, blob(group));
  ctx.ks.onChange(key);
  return r.ok;
}

function xgroup(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const rawSub = text(args[1]);
  const sub = rawSub.toUpperCase();
  if (sub === "HELP") {
    if (args.length !== 2) throw new RedisError("ERR wrong number of arguments for 'xgroup|help' command");
    return r.array(XGROUP_HELP.map((line) => r.simple(line)));
  }
  if (sub === "CREATE") return xgroupCreate(ctx, args, rawSub);
  if (sub === "SETID") return xgroupSetId(ctx, args, rawSub);
  if (sub === "DESTROY") {
    if (args.length !== 4) throw new RedisError("ERR wrong number of arguments for 'xgroup|destroy' command");
    const sid = streamId(ctx, args[2]);
    if (sid === undefined) throw new RedisError(NO_KEY_GROUP);
    const n = ctx.ks.sql.exec("DELETE FROM stream_groups WHERE key_id = ? AND name = ? RETURNING name", sid, blob(args[3])).toArray().length;
    if (!n) return r.int(0);
    ctx.ks.sql.exec("DELETE FROM stream_consumers WHERE key_id = ? AND group_name = ?", sid, blob(args[3]));
    ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND group_name = ?", sid, blob(args[3]));
    ctx.ks.onChange(args[2]);
    return r.int(1);
  }
  if (sub === "CREATECONSUMER") {
    if (args.length !== 5) throw new RedisError("ERR wrong number of arguments for 'xgroup|createconsumer' command");
    const sid = streamId(ctx, args[2]);
    if (sid === undefined) throw new RedisError(NO_KEY_GROUP);
    if (!readGroup(ctx, sid, args[3])) throw new RedisError(`NOGROUP No such consumer group '${text(args[3])}' for key name '${text(args[2])}'`);
    const created = ensureConsumer(ctx, sid, args[3], args[4], false);
    if (created) ctx.ks.onChange(args[2]);
    return r.int(created ? 1 : 0);
  }
  if (sub === "DELCONSUMER") {
    if (args.length !== 5) throw new RedisError("ERR wrong number of arguments for 'xgroup|delconsumer' command");
    const sid = streamId(ctx, args[2]);
    if (sid === undefined) throw new RedisError(NO_KEY_GROUP);
    if (!readGroup(ctx, sid, args[3])) throw new RedisError(`NOGROUP No such consumer group '${text(args[3])}' for key name '${text(args[2])}'`);
    const deleted = ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND group_name = ? AND consumer_name = ? RETURNING entry_id",
      sid, blob(args[3]), blob(args[4])).toArray().length;
    const removed = ctx.ks.sql.exec("DELETE FROM stream_consumers WHERE key_id = ? AND group_name = ? AND name = ? RETURNING name",
      sid, blob(args[3]), blob(args[4])).toArray().length;
    if (deleted || removed) ctx.ks.onChange(args[2]);
    return r.int(deleted);
  }
  throw new RedisError(`ERR unknown subcommand '${rawSub}'. Try XGROUP HELP.`);
}

function nextEntriesRead(meta: StreamMeta, len: number, firstId: StreamId | undefined, group: StreamGroup, deliveredCount: number, lastDelivered: StreamId): bigint | null {
  if (group.entriesRead !== null) {
    if (cmpId(lastDelivered, meta.lastId) === 0 && cmpId(meta.maxDeletedId, group.lastId) > 0) return meta.entriesAdded;
    return group.entriesRead + BigInt(deliveredCount);
  }
  if (firstId && cmpId(group.lastId, firstId) < 0 && cmpId(meta.maxDeletedId, ZERO_ID) === 0 && meta.entriesAdded === BigInt(len)) {
    return BigInt(deliveredCount);
  }
  if (cmpId(lastDelivered, meta.lastId) === 0) return meta.entriesAdded;
  return null;
}

function gatherClaimCandidates(ctx: Ctx, sid: number, groupName: Uint8Array, claimIdle: bigint, cap: number): Array<{ id: StreamId; idBlob: ArrayBuffer; fields: Array<Uint8Array>; idle: number; count: bigint }> {
  const out: Array<{ id: StreamId; idBlob: ArrayBuffer; fields: Array<Uint8Array>; idle: number; count: bigint }> = [];
  const nacked = ctx.ks.sql.exec<ClaimCandidate>(
    "SELECT entry_id, delivery_time, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND consumer_name IS NULL ORDER BY seq ASC",
    sid, blob(groupName)).toArray();
  for (const row of nacked) {
    if (out.length >= cap) return out;
    const id = decodeId(row.entry_id);
    const fields = entryFields(ctx, sid, id);
    if (!fields) continue;
    out.push({ id, idBlob: row.entry_id, fields, idle: Math.max(0, ctx.now - row.delivery_time), count: BigInt(row.delivery_count) });
  }
  const owned = ctx.ks.sql.exec<ClaimCandidate>(
    "SELECT entry_id, delivery_time, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND consumer_name IS NOT NULL ORDER BY delivery_time ASC, seq ASC",
    sid, blob(groupName)).toArray();
  for (const row of owned) {
    if (out.length >= cap) return out;
    if (BigInt(ctx.now) - BigInt(row.delivery_time) < claimIdle) continue;
    const id = decodeId(row.entry_id);
    const fields = entryFields(ctx, sid, id);
    if (!fields) continue;
    out.push({ id, idBlob: row.entry_id, fields, idle: Math.max(0, ctx.now - row.delivery_time), count: BigInt(row.delivery_count) });
  }
  return out;
}

function xreadgroup(ctx: Ctx, args: Array<Uint8Array>): Outcome {
  let groupName: Uint8Array | undefined;
  let consumer: Uint8Array | undefined;
  let count: number | undefined;
  let maxCount: bigint | undefined;
  let maxSize: bigint | undefined;
  let claimIdle: bigint | undefined;
  let blockMs: number | undefined;
  let noack = false;
  let hasStreams = false;
  let i = 1;
  while (i < args.length) {
    const o = opt(args[i]);
    if (o === "STREAMS") {
      hasStreams = true;
      i++;
      break;
    }
    if (o === "GROUP" && i + 2 < args.length) {
      groupName = args[i + 1];
      consumer = args[i + 2];
      i += 3;
      continue;
    }
    if (o === "COUNT" && i + 1 < args.length) {
      count = int(args[i + 1]);
      i += 2;
      continue;
    }
    if (o === "MAXCOUNT" && i + 1 < args.length) {
      maxCount = parsePositiveInt64(args[i + 1], ERR.int, "ERR MAXCOUNT must be a positive integer");
      i += 2;
      continue;
    }
    if (o === "MAXSIZE" && i + 1 < args.length) {
      maxSize = parsePositiveInt64(args[i + 1], ERR.int, "ERR MAXSIZE must be a positive integer");
      i += 2;
      continue;
    }
    if (o === "CLAIM" && i + 1 < args.length) {
      const v = toInt64(args[i + 1]);
      if (v === undefined) throw new RedisError("ERR min-idle-time is not an integer or out of range");
      if (v < 0n) throw new RedisError("ERR min-idle-time must be a positive integer");
      claimIdle = v;
      i += 2;
      continue;
    }
    if (o === "BLOCK" && i + 1 < args.length) {
      blockMs = blockTimeout(args[i + 1]);
      i += 2;
      continue;
    }
    if (o === "NOACK") {
      noack = true;
      i++;
      continue;
    }
    throw new RedisError(ERR.syntax);
  }
  if (!hasStreams || !groupName || !consumer) throw new RedisError(ERR.syntax);
  const rest = args.slice(i);
  if (!rest.length || rest.length % 2 !== 0) {
    throw new RedisError("ERR Unbalanced 'xreadgroup' list of streams: for each stream key an ID or '>' must be specified.");
  }
  const n = rest.length / 2;
  const keys = rest.slice(0, n);
  const rawIds = rest.slice(n);
  const targets: Array<{ key: Uint8Array; sid: number; group: StreamGroup; id: StreamId | ">" }> = [];
  for (let j = 0; j < n; j++) {
    const key = keys[j];
    const idStr = text(rawIds[j]);
    const { sid, group } = requireGroup(ctx, key, groupName, `NOGROUP No such key '${text(key)}' or consumer group '${text(groupName)}' in XREADGROUP with GROUP option`);
    if (idStr === "$" || idStr === "+") {
      throw new RedisError(`ERR The ${idStr} ID is meaningless in the context of XREADGROUP: you want to read the history of this consumer by specifying a proper ID, or use the > ID to get new messages. The ${idStr} ID would just return an empty result set.`);
    }
    targets.push({ key, sid, group, id: idStr === ">" ? ">" : requireId(rawIds[j]) });
  }
  const proto = ctx.session.proto;
  const perStreamCap = count !== undefined && count > 0 ? count : Infinity;
  const sqlLimit = Number.isFinite(perStreamCap) ? perStreamCap : -1;
  const results: Array<[Uint8Array, Array<Reply>]> = [];
  let totalEntries = 0n;
  let usedBytes = 0n;
  let claimActive = claimIdle !== undefined;
  for (const t of targets) {
    if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
    if (t.id !== ">") {
      claimActive = false;
      const pelRows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; delivery_count: string }>(
        "SELECT entry_id, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND consumer_name = ? AND entry_id > ? ORDER BY entry_id ASC LIMIT ?",
        t.sid, blob(groupName), blob(consumer), encodeId(t.id), sqlLimit).toArray();
      usedBytes += BigInt(streamHeaderBytes(t.key, proto));
      const entries: Array<Reply> = [];
      for (const row of pelRows) {
        if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
        const seq = nextPelSeq(ctx, t.sid);
        const nextCount = incDeliveryCount(BigInt(row.delivery_count));
        ctx.ks.sql.exec("UPDATE stream_pel SET delivery_time = ?, delivery_count = ?, seq = ? WHERE key_id = ? AND group_name = ? AND entry_id = ?",
          ctx.now, String(nextCount), seq, t.sid, blob(groupName), row.entry_id);
        const id = decodeId(row.entry_id);
        const fields = entryFields(ctx, t.sid, id);
        entries.push(entryReply(id, fields));
        totalEntries++;
        usedBytes += BigInt(entryReplyBytes(id, fields, proto));
      }
      ensureConsumer(ctx, t.sid, groupName, consumer, entries.length > 0);
      ctx.ks.onChange(t.key);
      results.push([t.key, entries]);
      usedBytes += BigInt(respArrBytes(entries.length));
      continue;
    }
    const claims = claimActive && claimIdle !== undefined ? gatherClaimCandidates(ctx, t.sid, groupName, claimIdle, perStreamCap) : [];
    const newLimit = Number.isFinite(perStreamCap) ? Math.max(0, perStreamCap - claims.length) : -1;
    const newRows = newLimit === 0
      ? []
      : ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
        "SELECT entry_id, fields FROM stream_entries WHERE key_id = ? AND entry_id > ? ORDER BY entry_id ASC LIMIT ?",
        t.sid, encodeId(t.group.lastId), newLimit).toArray();
    if (!claims.length && !newRows.length) continue;
    usedBytes += BigInt(streamHeaderBytes(t.key, proto));
    const entries: Array<Reply> = [];
    let claimedCount = 0;
    for (const c of claims) {
      if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
      const nextCount = incDeliveryCount(c.count);
      const seq = nextPelSeq(ctx, t.sid);
      ctx.ks.sql.exec(
        "UPDATE stream_pel SET consumer_name = ?, delivery_time = ?, delivery_count = ?, seq = ? WHERE key_id = ? AND group_name = ? AND entry_id = ?",
        blob(consumer), ctx.now, String(nextCount), seq, t.sid, blob(groupName), c.idBlob);
      const metaPair: [number, bigint] = [c.idle, c.count];
      entries.push(entryReply(c.id, c.fields, metaPair));
      claimedCount++;
      totalEntries++;
      usedBytes += BigInt(entryReplyBytes(c.id, c.fields, proto, metaPair));
    }
    const emittedNew: Array<{ entry_id: ArrayBuffer; fields: ArrayBuffer }> = [];
    for (const row of newRows) {
      if (!canReadMore(totalEntries, usedBytes, maxCount, maxSize)) break;
      const id = decodeId(row.entry_id);
      const fields = decodeFields(row.fields);
      const metaPair: [number, bigint] | undefined = claimActive ? [0, 0n] : undefined;
      entries.push(entryReply(id, fields, metaPair));
      emittedNew.push(row);
      totalEntries++;
      usedBytes += BigInt(entryReplyBytes(id, fields, proto, metaPair));
    }
    const lastRow = emittedNew.at(-1);
    if (lastRow) {
      const meta = readMeta(ctx, t.sid);
      const len = streamLength(ctx, t.sid);
      const firstId = edgeEntry(ctx, t.sid, "ASC")?.id;
      const lastDelivered = decodeId(lastRow.entry_id);
      const nextEr = nextEntriesRead(meta, len, firstId, t.group, emittedNew.length, lastDelivered);
      ctx.ks.sql.exec("UPDATE stream_groups SET last_id = ?, entries_read = ? WHERE key_id = ? AND name = ?",
        encodeId(lastDelivered), nextEr === null ? null : String(nextEr), t.sid, blob(groupName));
      if (!noack) {
        for (const row of emittedNew) {
          const seq = nextPelSeq(ctx, t.sid);
          ctx.ks.sql.exec(
            "INSERT INTO stream_pel (key_id, group_name, entry_id, consumer_name, delivery_time, delivery_count, seq) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id, group_name, entry_id) DO UPDATE SET consumer_name = excluded.consumer_name, delivery_time = excluded.delivery_time, delivery_count = excluded.delivery_count, seq = excluded.seq",
            t.sid, blob(groupName), row.entry_id, blob(consumer), ctx.now, "1", seq);
        }
      }
    }
    if (claimedCount || emittedNew.length) {
      ensureConsumer(ctx, t.sid, groupName, consumer, claimedCount > 0 || !noack);
      ctx.ks.onChange(t.key);
    }
    results.push([t.key, entries]);
    usedBytes += BigInt(respArrBytes(entries.length));
  }
  if (results.length) return readReply(ctx, results);
  for (const t of targets) ensureConsumer(ctx, t.sid, groupName, consumer, false);
  if (blockMs !== undefined) return block(ctx, keys, blockMs, r.nilArray);
  return r.nilArray;
}

function xack(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group] = args;
  const sid = streamId(ctx, key);
  if (sid === undefined || !readGroup(ctx, sid, group)) return r.int(0);
  const ids = args.slice(3).map((a) => requireId(a));
  let acked = 0;
  for (const id of ids) {
    acked += ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ? RETURNING entry_id",
      sid, blob(group), encodeId(id)).toArray().length;
  }
  if (acked) ctx.ks.onChange(key);
  return r.int(acked);
}

function xnack(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group, modeArg] = args;
  const { sid } = requireGroup(ctx, key, group, `NOGROUP No such key '${text(key)}' or consumer group '${text(group)}'`);
  const mode = opt(modeArg);
  if (mode !== "SILENT" && mode !== "FAIL" && mode !== "FATAL") {
    throw new RedisError("ERR mode must be SILENT, FAIL, or FATAL");
  }
  let rawIds: Array<Uint8Array> | undefined;
  let retryCount: bigint | undefined;
  let force = false;
  let i = 4;
  while (i < args.length) {
    const raw = text(args[i]);
    const o = raw.toUpperCase();
    if (o === "IDS") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      const numIds = parsePositiveInt64(args[i + 1], "ERR numids must be a positive integer", "ERR numids must be a positive integer");
      const n = Number(numIds);
      if (i + 2 + n > args.length) throw new RedisError("ERR number of IDs doesn't match numids");
      rawIds = args.slice(i + 2, i + 2 + n);
      i += 2 + n;
    } else if (o === "RETRYCOUNT") {
      if (i + 1 >= args.length) throw new RedisError(`ERR Unrecognized XNACK option '${raw}'`);
      const rc = int64(args[i + 1]);
      if (rc < 0n) throw new RedisError("ERR Invalid RETRYCOUNT value, must be >= 0");
      retryCount = rc;
      i += 2;
    } else if (o === "FORCE") {
      force = true;
      i++;
    } else {
      throw new RedisError(`ERR Unrecognized XNACK option '${raw}'`);
    }
  }
  if (!rawIds) throw new RedisError("ERR syntax error, expected IDS keyword");
  const ids = rawIds.map((a) => requireId(a));
  let nacked = 0;
  for (const id of ids) {
    const idBlob = encodeId(id);
    const pel = ctx.ks.sql.exec<{ delivery_count: string }>(
      "SELECT delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ?",
      sid, blob(group), idBlob).toArray()[0];
    if (pel) {
      const cur = BigInt(pel.delivery_count);
      const nextCount = retryCount !== undefined ? retryCount : mode === "FATAL" ? INT64_MAX : mode === "SILENT" ? (cur > 0n ? cur - 1n : 0n) : cur;
      const seq = nextPelSeq(ctx, sid);
      ctx.ks.sql.exec(
        "UPDATE stream_pel SET consumer_name = NULL, delivery_time = 0, delivery_count = ?, seq = ? WHERE key_id = ? AND group_name = ? AND entry_id = ?",
        String(nextCount), seq, sid, blob(group), idBlob);
      nacked++;
    } else if (force) {
      if (!entryFields(ctx, sid, id)) continue;
      const nextCount = retryCount !== undefined ? retryCount : mode === "FATAL" ? INT64_MAX : 0n;
      const seq = nextPelSeq(ctx, sid);
      ctx.ks.sql.exec(
        "INSERT INTO stream_pel (key_id, group_name, entry_id, consumer_name, delivery_time, delivery_count, seq) VALUES (?, ?, ?, NULL, 0, ?, ?)",
        sid, blob(group), idBlob, String(nextCount), seq);
      nacked++;
    }
  }
  if (nacked) ctx.ks.onChange(key);
  return r.int(nacked);
}

function xpending(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group] = args;
  if (args.length === 3) {
    const { sid } = requireGroup(ctx, key, group, `NOGROUP No such key '${text(key)}' or consumer group '${text(group)}'`);
    const agg = ctx.ks.sql.exec<{ n: number; min_id: ArrayBuffer | null; max_id: ArrayBuffer | null }>(
      "SELECT count(*) AS n, min(entry_id) AS min_id, max(entry_id) AS max_id FROM stream_pel WHERE key_id = ? AND group_name = ?",
      sid, blob(group)).one();
    if (!agg.n || !agg.min_id || !agg.max_id) return r.array([r.int(0), r.nil, r.nil, r.nilArray]);
    const counts = ctx.ks.sql.exec<{ consumer_name: ArrayBuffer; cnt: number }>(
      "SELECT consumer_name, count(*) AS cnt FROM stream_pel WHERE key_id = ? AND group_name = ? AND consumer_name IS NOT NULL GROUP BY consumer_name ORDER BY consumer_name ASC",
      sid, blob(group)).toArray();
    return r.array([
      r.int(agg.n),
      r.bulk(formatId(decodeId(agg.min_id))),
      r.bulk(formatId(decodeId(agg.max_id))),
      r.array(counts.map((c) => r.array([r.bulk(fromBlob(c.consumer_name)), r.bulk(String(c.cnt))]))),
    ]);
  }
  const hasIdle = opt(args[3]) === "IDLE";
  const base = hasIdle ? 5 : 3;
  if (args.length !== base + 3 && args.length !== base + 4) throw new RedisError(ERR.syntax);
  const minIdle = hasIdle ? int64(args[4]) : 0n;
  const start = parseBound(args[base], false, "start");
  const end = parseBound(args[base + 1], true, "end");
  const count = int(args[base + 2]);
  const consumer = args[base + 3];
  const { sid } = requireGroup(ctx, key, group, `NOGROUP No such key '${text(key)}' or consumer group '${text(group)}'`);
  if (count <= 0 || cmpId(start, end) > 0) return r.array([]);
  const whereConsumer = consumer ? " AND consumer_name = ?" : "";
  const params: Array<SqlStorageValue> = [sid, blob(group), encodeId(start), encodeId(end)];
  if (consumer) params.push(blob(consumer));
  const limitClause = minIdle <= 0n ? " LIMIT ?" : "";
  if (minIdle <= 0n) params.push(count);
  const rows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; consumer_name: ArrayBuffer | null; delivery_time: number; delivery_count: string }>(
    `SELECT entry_id, consumer_name, delivery_time, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id >= ? AND entry_id <= ?${whereConsumer} ORDER BY entry_id ASC${limitClause}`,
    ...params).toArray();
  const out: Array<Reply> = [];
  for (const row of rows) {
    if (out.length >= count) break;
    if (minIdle > 0n && row.consumer_name !== null && BigInt(ctx.now) - BigInt(row.delivery_time) < minIdle) continue;
    out.push(r.array([
      r.bulk(formatId(decodeId(row.entry_id))),
      r.bulk(row.consumer_name === null ? "" : fromBlob(row.consumer_name)),
      r.int(row.consumer_name === null ? -1 : Math.max(0, ctx.now - row.delivery_time)),
      r.int(BigInt(row.delivery_count)),
    ]));
  }
  return r.array(out);
}

function xclaim(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group, consumer, minIdleArg] = args;
  const minIdleRaw = int64(minIdleArg, "ERR Invalid min-idle-time argument for XCLAIM");
  const minIdle = minIdleRaw < 0n ? 0n : minIdleRaw;
  const ids: Array<StreamId> = [requireId(args[5])];
  let i = 6;
  while (i < args.length) {
    const parsed = parseStrictId(args[i]);
    if (!parsed) break;
    ids.push(parsed);
    i++;
  }
  let deliveryTime: number | undefined;
  let retryCount: bigint | undefined;
  let force = false;
  let justId = false;
  let lastIdOpt: StreamId | undefined;
  while (i < args.length) {
    const raw = text(args[i]);
    const o = raw.toUpperCase();
    if (o === "FORCE") {
      force = true;
      i++;
    } else if (o === "JUSTID") {
      justId = true;
      i++;
    } else if (o === "IDLE") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      const idle = int64(args[i + 1], "ERR Invalid IDLE option argument for XCLAIM");
      deliveryTime = ctx.now - Number(idle < 0n ? 0n : idle);
      i += 2;
    } else if (o === "TIME") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      const t = int64(args[i + 1], "ERR Invalid TIME option argument for XCLAIM");
      deliveryTime = t < 0n ? ctx.now : Number(t);
      i += 2;
    } else if (o === "RETRYCOUNT") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      const rc = int64(args[i + 1], "ERR Invalid RETRYCOUNT option argument for XCLAIM");
      if (rc >= 0n) retryCount = rc;
      i += 2;
    } else if (o === "LASTID") {
      if (i + 1 >= args.length) throw new RedisError(ERR.syntax);
      lastIdOpt = requireId(args[i + 1]);
      i += 2;
    } else {
      throw new RedisError(`ERR Unrecognized XCLAIM option '${raw}'`);
    }
  }
  const { sid, group: grp } = requireGroup(ctx, key, group, `NOGROUP No such key '${text(key)}' or consumer group '${text(group)}'`);
  ensureConsumer(ctx, sid, group, consumer, false);
  let mutated = false;
  if (lastIdOpt && cmpId(lastIdOpt, grp.lastId) > 0) {
    ctx.ks.sql.exec("UPDATE stream_groups SET last_id = ? WHERE key_id = ? AND name = ?", encodeId(lastIdOpt), sid, blob(group));
    mutated = true;
  }
  const out: Array<Reply> = [];
  for (const id of ids) {
    const idBlob = encodeId(id);
    const pel = ctx.ks.sql.exec<{ consumer_name: ArrayBuffer | null; delivery_time: number; delivery_count: string }>(
      "SELECT consumer_name, delivery_time, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ?",
      sid, blob(group), idBlob).toArray()[0];
    if (pel) {
      if (pel.consumer_name !== null && BigInt(ctx.now) - BigInt(pel.delivery_time) < minIdle) continue;
      const fields = entryFields(ctx, sid, id);
      if (!fields) {
        ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ?", sid, blob(group), idBlob);
        mutated = true;
        continue;
      }
      const curCount = BigInt(pel.delivery_count);
      const nextCount = retryCount ?? (justId ? curCount : incDeliveryCount(curCount));
      const nextTime = deliveryTime ?? ctx.now;
      const seq = nextPelSeq(ctx, sid);
      ctx.ks.sql.exec("UPDATE stream_pel SET consumer_name = ?, delivery_time = ?, delivery_count = ?, seq = ? WHERE key_id = ? AND group_name = ? AND entry_id = ?",
        blob(consumer), nextTime, String(nextCount), seq, sid, blob(group), idBlob);
      ensureConsumer(ctx, sid, group, consumer, true);
      mutated = true;
      out.push(justId ? r.bulk(formatId(id)) : entryReply(id, fields));
    } else if (force) {
      const fields = entryFields(ctx, sid, id);
      if (!fields) continue;
      const nextCount = retryCount ?? (justId ? 1n : 2n);
      const nextTime = deliveryTime ?? ctx.now;
      const seq = nextPelSeq(ctx, sid);
      ctx.ks.sql.exec("INSERT INTO stream_pel (key_id, group_name, entry_id, consumer_name, delivery_time, delivery_count, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sid, blob(group), idBlob, blob(consumer), nextTime, String(nextCount), seq);
      ensureConsumer(ctx, sid, group, consumer, true);
      mutated = true;
      out.push(justId ? r.bulk(formatId(id)) : entryReply(id, fields));
    }
  }
  if (mutated) ctx.ks.onChange(key);
  return r.array(out);
}

function xautoclaim(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const [, key, group, consumer, minIdleArg, startArg] = args;
  const minIdleRaw = int64(minIdleArg, "ERR Invalid min-idle-time argument for XAUTOCLAIM");
  const minIdle = minIdleRaw < 0n ? 0n : minIdleRaw;
  const start = parseBound(startArg, false, "start");
  let count = 100;
  let justId = false;
  for (let i = 6; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "JUSTID") {
      justId = true;
    } else if (o === "COUNT" && i + 1 < args.length) {
      count = int(args[++i]);
      if (count <= 0) throw new RedisError("ERR COUNT must be > 0");
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  const { sid } = requireGroup(ctx, key, group, `NOGROUP No such key '${text(key)}' or consumer group '${text(group)}'`);
  ensureConsumer(ctx, sid, group, consumer, false);
  const attempts = count * 10;
  const rows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; consumer_name: ArrayBuffer | null; delivery_time: number; delivery_count: string }>(
    "SELECT entry_id, consumer_name, delivery_time, delivery_count FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id >= ? ORDER BY entry_id ASC LIMIT ?",
    sid, blob(group), encodeId(start), attempts + 1).toArray();
  const claimed: Array<Reply> = [];
  const deleted: Array<Reply> = [];
  let nextId = ZERO_ID;
  let stoppedEarly = false;
  const bound = Math.min(rows.length, attempts);
  for (let j = 0; j < bound; j++) {
    if (claimed.length + deleted.length >= count) {
      nextId = decodeId(rows[j].entry_id);
      stoppedEarly = true;
      break;
    }
    const row = rows[j];
    const id = decodeId(row.entry_id);
    const fields = entryFields(ctx, sid, id);
    if (!fields) {
      ctx.ks.sql.exec("DELETE FROM stream_pel WHERE key_id = ? AND group_name = ? AND entry_id = ?", sid, blob(group), row.entry_id);
      deleted.push(r.bulk(formatId(id)));
      continue;
    }
    if (row.consumer_name !== null && BigInt(ctx.now) - BigInt(row.delivery_time) < minIdle) continue;
    const curCount = BigInt(row.delivery_count);
    const nextCount = justId ? curCount : incDeliveryCount(curCount);
    const seq = nextPelSeq(ctx, sid);
    ctx.ks.sql.exec("UPDATE stream_pel SET consumer_name = ?, delivery_time = ?, delivery_count = ?, seq = ? WHERE key_id = ? AND group_name = ? AND entry_id = ?",
      blob(consumer), ctx.now, String(nextCount), seq, sid, blob(group), row.entry_id);
    ensureConsumer(ctx, sid, group, consumer, true);
    claimed.push(justId ? r.bulk(formatId(id)) : entryReply(id, fields));
  }
  if (!stoppedEarly && rows.length > attempts) nextId = decodeId(rows[attempts].entry_id);
  if (claimed.length || deleted.length) ctx.ks.onChange(key);
  return r.array([r.bulk(formatId(nextId)), r.array(claimed), r.array(deleted)]);
}

function groupSummaryEntries(meta: StreamMeta, len: number, firstId: StreamId | undefined, group: StreamGroup, consumerCount: number, pelCount: number): Reply {
  const lag = groupLag(meta, len, firstId, group);
  return r.map([
    [r.bulk("name"), r.bulk(group.name)],
    [r.bulk("consumers"), r.int(consumerCount)],
    [r.bulk("pending"), r.int(pelCount)],
    [r.bulk("last-delivered-id"), r.bulk(formatId(group.lastId))],
    [r.bulk("entries-read"), group.entriesRead !== null ? r.int(group.entriesRead) : r.nil],
    [r.bulk("lag"), lag !== null ? r.int(lag) : r.nil],
  ]);
}

function xinfoStream(ctx: Ctx, args: Array<Uint8Array>, rawSub: string): Reply {
  if (args.length < 3) throw new RedisError("ERR wrong number of arguments for 'xinfo|stream' command");
  let full = false;
  let fullCount = 10;
  if (args.length > 3) {
    if (opt(args[3]) !== "FULL") throw new RedisError(`ERR unknown subcommand or wrong number of arguments for '${rawSub}'. Try XINFO HELP.`);
    full = true;
    if (args.length === 6 && opt(args[4]) === "COUNT") fullCount = int(args[5]);
    else if (args.length !== 4) throw new RedisError(`ERR unknown subcommand or wrong number of arguments for '${rawSub}'. Try XINFO HELP.`);
  }
  const sid = streamId(ctx, args[2]);
  if (sid === undefined) throw new RedisError("ERR no such key");
  const meta = readMeta(ctx, sid);
  const len = streamLength(ctx, sid);
  const first = edgeEntry(ctx, sid, "ASC");
  const last = edgeEntry(ctx, sid, "DESC");
  const groups = readGroups(ctx, sid);
  const idmpStats = ctx.ks.sql.exec<{ pids: number; iids: number }>(
    "SELECT count(DISTINCT pid) AS pids, count(*) AS iids FROM stream_idmp WHERE key_id = ? AND created_at > ?",
    sid, ctx.now - meta.idmpDuration * 1000).one();
  const base: Array<[Reply, Reply]> = [
    [r.bulk("length"), r.int(len)],
    [r.bulk("radix-tree-keys"), r.int(len === 0 ? 0 : 1)],
    [r.bulk("radix-tree-nodes"), r.int(1)],
    [r.bulk("last-generated-id"), r.bulk(formatId(meta.lastId))],
    [r.bulk("max-deleted-entry-id"), r.bulk(formatId(meta.maxDeletedId))],
    [r.bulk("entries-added"), r.int(meta.entriesAdded)],
    [r.bulk("recorded-first-entry-id"), r.bulk(first ? formatId(first.id) : "0-0")],
    [r.bulk("idmp-duration"), r.int(meta.idmpDuration)],
    [r.bulk("idmp-maxsize"), r.int(meta.idmpMaxsize)],
    [r.bulk("pids-tracked"), r.int(idmpStats.pids)],
    [r.bulk("iids-tracked"), r.int(idmpStats.iids)],
    [r.bulk("iids-added"), r.int(meta.iidsAdded)],
    [r.bulk("iids-duplicates"), r.int(meta.iidsDuplicates)],
  ];
  if (!full) {
    return r.map([
      ...base,
      [r.bulk("groups"), r.int(groups.length)],
      [r.bulk("first-entry"), first ? entryReply(first.id, first.fields) : r.nil],
      [r.bulk("last-entry"), last ? entryReply(last.id, last.fields) : r.nil],
    ]);
  }
  const lim = fullCount <= 0 ? -1 : fullCount;
  const entries = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
    "SELECT entry_id, fields FROM stream_entries WHERE key_id = ? ORDER BY entry_id ASC LIMIT ?", sid, lim).toArray()
    .map((row) => entryReply(decodeId(row.entry_id), decodeFields(row.fields)));
  const groupMaps = groups.map((g) => {
    const pel = readPel(ctx, sid, g.name);
    const consumers = readConsumers(ctx, sid, g.name);
    const lag = groupLag(meta, len, first?.id, g);
    const pelSlice = lim === -1 ? pel : pel.slice(0, lim);
    const nackedCount = pel.filter((p) => p.consumerName === null).length;
    const consumerMaps = consumers.map((c) => {
      const cPel = pel.filter((p) => p.consumerName !== null && sameBytes(p.consumerName, c.name));
      const cSlice = lim === -1 ? cPel : cPel.slice(0, lim);
      return r.map([
        [r.bulk("name"), r.bulk(c.name)],
        [r.bulk("seen-time"), r.int(c.seenTime)],
        [r.bulk("active-time"), r.int(c.activeTime)],
        [r.bulk("pel-count"), r.int(cPel.length)],
        [r.bulk("pending"), r.array(cSlice.map((p) => r.array([r.bulk(formatId(p.entryId)), r.int(p.deliveryTime), r.int(p.deliveryCount)])))],
      ]);
    });
    return r.map([
      [r.bulk("name"), r.bulk(g.name)],
      [r.bulk("last-delivered-id"), r.bulk(formatId(g.lastId))],
      [r.bulk("entries-read"), g.entriesRead !== null ? r.int(g.entriesRead) : r.nil],
      [r.bulk("lag"), lag !== null ? r.int(lag) : r.nil],
      [r.bulk("pel-count"), r.int(pel.length)],
      [r.bulk("nacked-count"), r.int(nackedCount)],
      [r.bulk("pending"), r.array(pelSlice.map((p) => r.array([r.bulk(formatId(p.entryId)), r.bulk(p.consumerName ?? ""), r.int(p.deliveryTime), r.int(p.deliveryCount)])))],
      [r.bulk("consumers"), r.array(consumerMaps)],
    ]);
  });
  return r.map([...base, [r.bulk("entries"), r.array(entries)], [r.bulk("groups"), r.array(groupMaps)]]);
}

function xinfo(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const rawSub = text(args[1]);
  const sub = rawSub.toUpperCase();
  if (sub === "HELP") {
    if (args.length !== 2) throw new RedisError("ERR wrong number of arguments for 'xinfo|help' command");
    return r.array(XINFO_HELP.map((line) => r.simple(line)));
  }
  if (sub === "STREAM") return xinfoStream(ctx, args, rawSub);
  if (sub === "GROUPS") {
    if (args.length !== 3) throw new RedisError("ERR wrong number of arguments for 'xinfo|groups' command");
    const sid = streamId(ctx, args[2]);
    if (sid === undefined) throw new RedisError("ERR no such key");
    const meta = readMeta(ctx, sid);
    const len = streamLength(ctx, sid);
    const firstId = edgeEntry(ctx, sid, "ASC")?.id;
    return r.array(readGroups(ctx, sid).map((g) => {
      const consumers = readConsumers(ctx, sid, g.name).length;
      const pel = readPel(ctx, sid, g.name).length;
      return groupSummaryEntries(meta, len, firstId, g, consumers, pel);
    }));
  }
  if (sub === "CONSUMERS") {
    if (args.length !== 4) throw new RedisError("ERR wrong number of arguments for 'xinfo|consumers' command");
    const sid = streamId(ctx, args[2]);
    if (sid === undefined) throw new RedisError("ERR no such key");
    if (!readGroup(ctx, sid, args[3])) throw new RedisError(`NOGROUP No such consumer group '${text(args[3])}' for key name '${text(args[2])}'`);
    const pel = readPel(ctx, sid, args[3]);
    return r.array(readConsumers(ctx, sid, args[3]).map((c) => {
      const pending = pel.filter((p) => p.consumerName !== null && sameBytes(p.consumerName, c.name)).length;
      return r.map([
        [r.bulk("name"), r.bulk(c.name)],
        [r.bulk("pending"), r.int(pending)],
        [r.bulk("idle"), r.int(Math.max(0, ctx.now - c.seenTime))],
        [r.bulk("inactive"), r.int(c.activeTime === -1 ? -1 : Math.max(0, ctx.now - c.activeTime))],
      ]);
    }));
  }
  throw new RedisError(`ERR unknown subcommand '${rawSub}'. Try XINFO HELP.`);
}

export const streams: Table = {
  xadd: spec(-5, ["write", "fast"], xadd),
  xlen: spec(2, ["readonly", "fast"], xlen),
  xrange: spec(-4, ["readonly"], (ctx, args) => rangeCmd(ctx, args, false)),
  xrevrange: spec(-4, ["readonly"], (ctx, args) => rangeCmd(ctx, args, true)),
  xdel: spec(-3, ["write", "fast"], xdel),
  xdelex: spec(-5, ["write", "fast"], xdelex),
  xackdel: spec(-6, ["write", "fast"], xackdel),
  xtrim: spec(-4, ["write"], xtrim),
  xsetid: spec(-3, ["write", "fast"], xsetid),
  xcfgset: spec(-2, ["write", "fast"], xcfgset),
  xidmprecord: spec(5, ["write", "fast"], xidmprecord),
  xread: keyless(-4, ["readonly", "blocking"], xread),
  xgroup: keyless(-2, ["write"], xgroup),
  xreadgroup: keyless(-7, ["write", "blocking"], xreadgroup),
  xack: spec(-4, ["write", "fast"], xack),
  xnack: spec(-7, ["write", "fast"], xnack),
  xpending: spec(-3, ["readonly"], xpending),
  xclaim: spec(-6, ["write", "fast"], xclaim),
  xautoclaim: spec(-6, ["write", "fast"], xautoclaim),
  xinfo: keyless(-2, ["readonly"], xinfo),
};
