import { INT64_MAX, INT64_MIN } from "../../commands/args";
import type { Ctx } from "../../commands/types";
import { blob, checkSize, fromBlob, keyString, sameBytes } from "../keyspace";
import { TYPE } from "../schema";
import { RDB_TYPE, RdbFormatError, UINT64_MAX } from "./codec";
import type { RdbReader, RdbWriter } from "./codec";
import { decodeListpackItems, encodeListpack, listpackEntrySize, listpackInt } from "./listpack";

export interface StreamId {
  ms: bigint;
  seq: bigint;
}

export interface StreamEntry {
  id: StreamId;
  fields: Array<Uint8Array>;
}

export interface StreamConsumer {
  name: Uint8Array;
  seenTime: number;
  activeTime: number;
}

export interface StreamPelEntry {
  entryId: StreamId;
  consumerName: Uint8Array | null;
  deliveryTime: number;
  deliveryCount: bigint;
}

export interface StreamGroup {
  name: Uint8Array;
  lastId: StreamId;
  entriesRead: bigint | null;
  pel: Array<StreamPelEntry>;
  consumers: Array<StreamConsumer>;
}

export interface StreamIdmpEntry {
  pid: Uint8Array;
  iid: Uint8Array;
  entryId: StreamId;
}

export interface RestoredStream {
  entries: Array<StreamEntry>;
  lastId: StreamId;
  maxDeletedId: StreamId;
  entriesAdded: bigint;
  groups: Array<StreamGroup>;
  idmpDuration: number;
  idmpMaxsize: number;
  idmp: Array<StreamIdmpEntry>;
  iidsAdded: bigint;
  iidsDuplicates: bigint;
}

const ZERO_ID: StreamId = { ms: 0n, seq: 0n };
const STREAM_NODE_MAX_ENTRIES = 100;
const STREAM_NODE_MAX_BYTES = 4096;
const STREAM_ITEM_FLAG_DELETED = 1;
const STREAM_ITEM_FLAG_SAMEFIELDS = 2;

function encodeStreamId(id: StreamId): ArrayBuffer {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, id.ms, false);
  v.setBigUint64(8, id.seq, false);
  return b.buffer;
}

function decodeStreamId(raw: ArrayBuffer): StreamId {
  const v = new DataView(raw);
  return { ms: v.getBigUint64(0, false), seq: v.getBigUint64(8, false) };
}

function streamIdKey(id: StreamId): string {
  return `${id.ms}-${id.seq}`;
}

function encodeStreamFields(items: Array<Uint8Array>): Uint8Array {
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

function decodeStreamFields(raw: ArrayBuffer): Array<Uint8Array> {
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

function hasSameFields(fields: Array<Uint8Array>, masterFields: Array<Uint8Array>): boolean {
  if (fields.length !== masterFields.length * 2) return false;
  for (let i = 0; i < masterFields.length; i++) {
    if (!sameBytes(fields[i * 2], masterFields[i])) return false;
  }
  return true;
}

function fitsInt64(v: bigint): boolean {
  return v >= INT64_MIN && v <= INT64_MAX;
}

function entryListpackItems(entry: StreamEntry, masterId: StreamId, masterFields: Array<Uint8Array>): Array<Uint8Array | bigint> {
  const msDelta = entry.id.ms - masterId.ms;
  const seqDelta = entry.id.seq - masterId.seq;
  if (hasSameFields(entry.fields, masterFields)) {
    const out: Array<Uint8Array | bigint> = [BigInt(STREAM_ITEM_FLAG_SAMEFIELDS), msDelta, seqDelta];
    for (let i = 1; i < entry.fields.length; i += 2) out.push(entry.fields[i]);
    out.push(BigInt(3 + masterFields.length));
    return out;
  }
  const nFields = BigInt(entry.fields.length / 2);
  const out: Array<Uint8Array | bigint> = [0n, msDelta, seqDelta, nFields, ...entry.fields, 4n + BigInt(entry.fields.length)];
  return out;
}

function itemsByteSize(items: Array<Uint8Array | bigint>): number {
  let total = 0;
  for (const item of items) total += listpackEntrySize(item);
  return total;
}

function buildStreamNodes(entries: Array<StreamEntry>): Array<{ masterId: Uint8Array; listpack: Uint8Array }> {
  const nodes: Array<{ masterId: Uint8Array; listpack: Uint8Array }> = [];
  let master: StreamEntry | undefined;
  let masterFields: Array<Uint8Array> = [];
  let lpItems: Array<Uint8Array | bigint> = [];
  let count = 0;
  let bytesUsed = 7;

  const flush = () => {
    if (!master) return;
    lpItems[0] = BigInt(count);
    nodes.push({ masterId: new Uint8Array(encodeStreamId(master.id)), listpack: encodeListpack(lpItems) });
    master = undefined;
    masterFields = [];
    lpItems = [];
    count = 0;
    bytesUsed = 7;
  };

  for (const entry of entries) {
    if (master) {
      const msDelta = entry.id.ms - master.id.ms;
      const seqDelta = entry.id.seq - master.id.seq;
      const canJoin = count < STREAM_NODE_MAX_ENTRIES && fitsInt64(msDelta) && fitsInt64(seqDelta);
      if (!canJoin) {
        flush();
      } else {
        const nextItems = entryListpackItems(entry, master.id, masterFields);
        const nextBytes = itemsByteSize(nextItems);
        if (bytesUsed + nextBytes > STREAM_NODE_MAX_BYTES) flush();
        else {
          lpItems.push(...nextItems);
          count++;
          bytesUsed += nextBytes;
          continue;
        }
      }
    }
    master = entry;
    masterFields = [];
    for (let i = 0; i < entry.fields.length; i += 2) masterFields.push(entry.fields[i]);
    lpItems = [0n, 0n, BigInt(masterFields.length), ...masterFields, 0n];
    const nextItems = entryListpackItems(entry, master.id, masterFields);
    lpItems.push(...nextItems);
    count = 1;
    bytesUsed = 7 + itemsByteSize(lpItems);
  }
  flush();
  return nodes;
}

function dumpGroups(ctx: Ctx, keyId: number, w: RdbWriter) {
  const groups = ctx.ks.sql.exec<{ name: ArrayBuffer; last_id: ArrayBuffer; entries_read: string | null }>(
    "SELECT name, last_id, entries_read FROM stream_groups WHERE key_id = ? ORDER BY name ASC",
    keyId).toArray();
  w.len(groups.length);
  for (const group of groups) {
    const groupName = fromBlob(group.name);
    const lastId = decodeStreamId(group.last_id);
    const entriesRead = group.entries_read === null ? UINT64_MAX : BigInt(group.entries_read);
    w.rawString(groupName);
    w.len(lastId.ms);
    w.len(lastId.seq);
    w.len(entriesRead);

    const pelRows = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; consumer_name: ArrayBuffer | null; delivery_time: number; delivery_count: string; seq: number }>(
      "SELECT entry_id, consumer_name, delivery_time, delivery_count, seq FROM stream_pel WHERE key_id = ? AND group_name = ? ORDER BY entry_id ASC",
      keyId, group.name).toArray();
    w.len(pelRows.length);
    const byConsumer = new Map<string, Array<StreamId>>();
    const nacked: Array<{ id: StreamId; seq: number }> = [];
    for (const row of pelRows) {
      const id = decodeStreamId(row.entry_id);
      w.u64be(id.ms);
      w.u64be(id.seq);
      w.i64le(BigInt(row.delivery_time));
      w.len(BigInt(row.delivery_count));
      if (row.consumer_name === null) {
        nacked.push({ id, seq: row.seq });
        continue;
      }
      const ck = keyString(fromBlob(row.consumer_name));
      const list = byConsumer.get(ck) ?? [];
      list.push(id);
      byConsumer.set(ck, list);
    }

    const consumers = ctx.ks.sql.exec<{ name: ArrayBuffer; seen_time: number; active_time: number }>(
      "SELECT name, seen_time, active_time FROM stream_consumers WHERE key_id = ? AND group_name = ? ORDER BY name ASC",
      keyId, group.name).toArray();
    w.len(consumers.length);
    for (const c of consumers) {
      const cname = fromBlob(c.name);
      w.rawString(cname);
      w.i64le(BigInt(c.seen_time));
      w.i64le(BigInt(c.active_time));
      const cPel = byConsumer.get(keyString(cname)) ?? [];
      w.len(cPel.length);
      for (const id of cPel) {
        w.u64be(id.ms);
        w.u64be(id.seq);
      }
    }

    nacked.sort((a, b) => a.seq - b.seq);
    w.len(nacked.length);
    for (const n of nacked) {
      w.u64be(n.id.ms);
      w.u64be(n.id.seq);
    }
  }
}

export function dumpStream(ctx: Ctx, keyId: number, w: RdbWriter) {
  w.u8(RDB_TYPE.streamListpacks4);
  const meta = ctx.ks.sql.exec<{
    last_id: ArrayBuffer;
    max_deleted_id: ArrayBuffer;
    entries_added: string;
    idmp_duration: number;
    idmp_maxsize: number;
    iids_added: string;
    iids_duplicates: string;
  }>(
    "SELECT last_id, max_deleted_id, entries_added, idmp_duration, idmp_maxsize, iids_added, iids_duplicates FROM stream_meta WHERE key_id = ?",
    keyId).one();
  const entries = ctx.ks.sql.exec<{ entry_id: ArrayBuffer; fields: ArrayBuffer }>(
    "SELECT entry_id, fields FROM stream_entries WHERE key_id = ? ORDER BY entry_id ASC",
    keyId).toArray().map((row) => ({ id: decodeStreamId(row.entry_id), fields: decodeStreamFields(row.fields) }));

  const nodes = buildStreamNodes(entries);
  w.len(nodes.length);
  for (const node of nodes) {
    w.blobString(node.masterId);
    w.blobString(node.listpack);
  }

  const lastId = decodeStreamId(meta.last_id);
  const firstId = entries[0]?.id ?? ZERO_ID;
  const maxDeletedId = decodeStreamId(meta.max_deleted_id);
  w.len(entries.length);
  w.len(lastId.ms);
  w.len(lastId.seq);
  w.len(firstId.ms);
  w.len(firstId.seq);
  w.len(maxDeletedId.ms);
  w.len(maxDeletedId.seq);
  w.len(BigInt(meta.entries_added));

  dumpGroups(ctx, keyId, w);

  const idmpRows = ctx.ks.sql.exec<{ pid: ArrayBuffer; iid: ArrayBuffer; entry_id: ArrayBuffer }>(
    "SELECT pid, iid, entry_id FROM stream_idmp WHERE key_id = ? AND created_at > ? ORDER BY pid ASC, seq ASC",
    keyId, ctx.now - meta.idmp_duration * 1000).toArray();
  const producers = new Map<string, { pid: Uint8Array; iids: Array<{ iid: Uint8Array; entryId: StreamId }> }>();
  for (const row of idmpRows) {
    const pid = fromBlob(row.pid);
    const pk = keyString(pid);
    const entry = producers.get(pk) ?? { pid, iids: [] };
    entry.iids.push({ iid: fromBlob(row.iid), entryId: decodeStreamId(row.entry_id) });
    producers.set(pk, entry);
  }
  w.len(meta.idmp_duration);
  w.len(meta.idmp_maxsize);
  w.len(producers.size);
  for (const p of producers.values()) {
    w.rawString(p.pid);
    w.len(p.iids.length);
    for (const item of p.iids) {
      w.rawString(item.iid);
      w.len(item.entryId.ms);
      w.len(item.entryId.seq);
    }
  }
  w.len(BigInt(meta.iids_added));
  w.len(BigInt(meta.iids_duplicates));
}

function decodeNodeListpack(masterKey: Uint8Array, lpBytes: Uint8Array, out: Array<StreamEntry>) {
  if (masterKey.length !== 16) throw new RdbFormatError("invalid stream master key");
  const masterId = decodeStreamId(blob(masterKey));
  const items = decodeListpackItems(lpBytes);
  if (items.length < 4) throw new RdbFormatError("invalid stream listpack header");
  listpackInt(items[0]);
  listpackInt(items[1]);
  const masterFieldCountBig = listpackInt(items[2]);
  if (masterFieldCountBig < 0n || masterFieldCountBig > BigInt(items.length - 4)) throw new RdbFormatError("invalid stream master field count");
  const masterFieldCount = Number(masterFieldCountBig);
  const masterFields = items.slice(3, 3 + masterFieldCount).map((item) => item.bytes);
  if (listpackInt(items[3 + masterFieldCount]) !== 0n) throw new RdbFormatError("missing stream master terminator");

  let idx = 4 + masterFieldCount;
  while (idx < items.length) {
    if (idx + 3 >= items.length) throw new RdbFormatError("truncated stream listpack entry");
    const flags = Number(listpackInt(items[idx++]));
    const msDelta = listpackInt(items[idx++]);
    const seqDelta = listpackInt(items[idx++]);
    const ms = masterId.ms + msDelta;
    const seq = masterId.seq + seqDelta;
    if (ms < 0n || ms > UINT64_MAX || seq < 0n || seq > UINT64_MAX) throw new RdbFormatError("stream entry id overflow");

    const fields: Array<Uint8Array> = [];
    let expectedLpCount: bigint;
    if ((flags & STREAM_ITEM_FLAG_SAMEFIELDS) !== 0) {
      if (idx + masterFieldCount >= items.length) throw new RdbFormatError("truncated samefields stream entry");
      for (let j = 0; j < masterFieldCount; j++) {
        fields.push(masterFields[j], items[idx++].bytes);
      }
      expectedLpCount = BigInt(3 + masterFieldCount);
    } else {
      const nFieldsBig = listpackInt(items[idx++]);
      if (nFieldsBig < 0n || nFieldsBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new RdbFormatError("invalid stream field count");
      const nFields = Number(nFieldsBig);
      if (idx + nFields * 2 >= items.length) throw new RdbFormatError("truncated stream fields");
      for (let j = 0; j < nFields * 2; j++) fields.push(items[idx++].bytes);
      expectedLpCount = BigInt(4 + nFields * 2);
    }
    const lpCount = listpackInt(items[idx++]);
    if (lpCount !== expectedLpCount) throw new RdbFormatError("stream listpack entry count mismatch");
    if ((flags & STREAM_ITEM_FLAG_DELETED) === 0) out.push({ id: { ms, seq }, fields });
  }
}

function readPelId(r: RdbReader): StreamId {
  return { ms: r.u64be(), seq: r.u64be() };
}

function decodeGroups(r: RdbReader, rdbType: number): Array<StreamGroup> {
  const groupsCount = r.lenNum();
  const groups: Array<StreamGroup> = [];
  for (let i = 0; i < groupsCount; i++) {
    const name = r.string();
    const lastId = { ms: r.lenBig(), seq: r.lenBig() };
    const entriesReadRaw = rdbType >= RDB_TYPE.streamListpacks2 ? r.lenBig() : UINT64_MAX;
    const entriesRead = entriesReadRaw === UINT64_MAX ? null : entriesReadRaw;

    const pelCount = r.lenNum();
    const pelMap = new Map<string, StreamPelEntry>();
    for (let j = 0; j < pelCount; j++) {
      const entryId = readPelId(r);
      const deliveryTime = Number(r.i64le());
      const deliveryCount = r.lenBig();
      pelMap.set(streamIdKey(entryId), { entryId, consumerName: null, deliveryTime, deliveryCount });
    }

    const consumersCount = r.lenNum();
    const consumers: Array<StreamConsumer> = [];
    for (let j = 0; j < consumersCount; j++) {
      const cname = r.string();
      const seenTime = Number(r.i64le());
      const activeTime = rdbType >= RDB_TYPE.streamListpacks3 ? Number(r.i64le()) : -1;
      consumers.push({ name: cname, seenTime, activeTime });
      const cPelCount = r.lenNum();
      for (let k = 0; k < cPelCount; k++) {
        const entryId = readPelId(r);
        const pel = pelMap.get(streamIdKey(entryId));
        if (!pel) throw new RdbFormatError("consumer PEL missing from global PEL");
        pel.consumerName = cname;
      }
    }

    const orderedPel: Array<StreamPelEntry> = [];
    const seenPel = new Set<string>();
    if (rdbType >= RDB_TYPE.streamListpacks4) {
      const nackedCount = r.lenNum();
      for (let j = 0; j < nackedCount; j++) {
        const entryId = readPelId(r);
        const key = streamIdKey(entryId);
        const pel = pelMap.get(key);
        if (!pel) throw new RdbFormatError("nacked PEL missing from global PEL");
        orderedPel.push(pel);
        seenPel.add(key);
      }
    }
    for (const [key, pel] of pelMap) {
      if (!seenPel.has(key)) orderedPel.push(pel);
    }

    groups.push({ name, lastId, entriesRead, pel: orderedPel, consumers });
  }
  return groups;
}

export function decodeStream(r: RdbReader, rdbType: number): RestoredStream {
  const lpCount = r.lenNum();
  const entries: Array<StreamEntry> = [];
  for (let i = 0; i < lpCount; i++) {
    const masterKey = r.string();
    const lpBytes = r.string();
    decodeNodeListpack(masterKey, lpBytes, entries);
  }
  const length = r.lenNum();
  const lastId = { ms: r.lenBig(), seq: r.lenBig() };
  let maxDeletedId = ZERO_ID;
  let entriesAdded = BigInt(length);
  if (rdbType >= RDB_TYPE.streamListpacks2) {
    r.lenBig();
    r.lenBig();
    maxDeletedId = { ms: r.lenBig(), seq: r.lenBig() };
    entriesAdded = r.lenBig();
  }
  const groups = decodeGroups(r, rdbType);
  let idmpDuration = 100;
  let idmpMaxsize = 100;
  const idmp: Array<StreamIdmpEntry> = [];
  let iidsAdded = 0n;
  let iidsDuplicates = 0n;
  if (rdbType >= RDB_TYPE.streamListpacks4) {
    idmpDuration = r.lenNum();
    idmpMaxsize = r.lenNum();
    const producersCount = r.lenNum();
    for (let i = 0; i < producersCount; i++) {
      const pid = r.string();
      const iidsCount = r.lenNum();
      for (let j = 0; j < iidsCount; j++) {
        const iid = r.string();
        const entryId = { ms: r.lenBig(), seq: r.lenBig() };
        idmp.push({ pid, iid, entryId });
      }
    }
    iidsAdded = r.lenBig();
    iidsDuplicates = r.lenBig();
  }
  return { entries, lastId, maxDeletedId, entriesAdded, groups, idmpDuration, idmpMaxsize, idmp, iidsAdded, iidsDuplicates };
}

export function checkStreamSizes(key: Uint8Array, s: RestoredStream) {
  checkSize(key);
  for (const e of s.entries) {
    for (const f of e.fields) checkSize(key, f);
  }
  for (const g of s.groups) {
    checkSize(key, g.name);
    for (const c of g.consumers) checkSize(key, c.name);
  }
  for (const item of s.idmp) checkSize(key, item.pid, item.iid);
}

export function writeStream(ctx: Ctx, key: Uint8Array, expiresAt: number | null, s: RestoredStream) {
  const sid = ctx.ks.create(key, TYPE.stream, null, expiresAt);
  const lastNode = s.entries.length > 0 ? Math.floor((s.entries.length - 1) / STREAM_NODE_MAX_ENTRIES) : 0;
  const lastFill = s.entries.length > 0 ? ((s.entries.length - 1) % STREAM_NODE_MAX_ENTRIES) + 1 : 0;
  let totalPel = 0;
  for (const g of s.groups) totalPel += g.pel.length;
  const totalIdmp = s.idmp.length;
  ctx.ks.sql.exec(
    "INSERT INTO stream_meta (key_id, last_id, max_deleted_id, entries_added, node, node_fill, idmp_duration, idmp_maxsize, iids_added, iids_duplicates, pel_seq, idmp_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    sid,
    encodeStreamId(s.lastId),
    encodeStreamId(s.maxDeletedId),
    String(s.entriesAdded),
    lastNode,
    lastFill,
    s.idmpDuration,
    s.idmpMaxsize,
    String(s.iidsAdded),
    String(s.iidsDuplicates),
    totalPel,
    totalIdmp,
  );
  for (let i = 0; i < s.entries.length; i++) {
    const e = s.entries[i];
    ctx.ks.sql.exec(
      "INSERT INTO stream_entries (key_id, entry_id, fields, node) VALUES (?, ?, ?, ?)",
      sid, encodeStreamId(e.id), blob(encodeStreamFields(e.fields)), Math.floor(i / STREAM_NODE_MAX_ENTRIES),
    );
  }
  let pelSeq = 0;
  for (const g of s.groups) {
    const gBlob = blob(g.name);
    ctx.ks.sql.exec(
      "INSERT INTO stream_groups (key_id, name, last_id, entries_read) VALUES (?, ?, ?, ?)",
      sid, gBlob, encodeStreamId(g.lastId), g.entriesRead === null ? null : String(g.entriesRead),
    );
    for (const c of g.consumers) {
      ctx.ks.sql.exec(
        "INSERT INTO stream_consumers (key_id, group_name, name, seen_time, active_time) VALUES (?, ?, ?, ?, ?)",
        sid, gBlob, blob(c.name), c.seenTime, c.activeTime,
      );
    }
    for (const p of g.pel) {
      pelSeq++;
      ctx.ks.sql.exec(
        "INSERT INTO stream_pel (key_id, group_name, entry_id, consumer_name, delivery_time, delivery_count, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        sid, gBlob, encodeStreamId(p.entryId), p.consumerName ? blob(p.consumerName) : null, p.deliveryTime, String(p.deliveryCount), pelSeq,
      );
    }
  }
  for (let i = 0; i < s.idmp.length; i++) {
    const item = s.idmp[i];
    ctx.ks.sql.exec(
      "INSERT INTO stream_idmp (key_id, pid, iid, entry_id, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)",
      sid, blob(item.pid), blob(item.iid), encodeStreamId(item.entryId), ctx.now, i + 1,
    );
  }
}
