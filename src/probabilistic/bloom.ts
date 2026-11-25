import { opt, toInt64 } from "../commands/args";
import type { Ctx } from "../commands/types";
import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { CHUNK_BYTES, CHUNK_MASK, ChunkStore, MAX_ALLOC_BYTES } from "./chunks";
import { argIndex, formatPrintfG, MASK64, murmurHash2, murmurHash64A, parseDoubleStrict, UINT64_MAX, wrongArity } from "./hash";

const BLOOM_OPT_NOROUND = 1;
const BLOOM_OPT_ENTS_IS_BITS = 2;
const BLOOM_OPT_FORCE64 = 4;
const BLOOM_OPT_NO_SCALING = 8;
const BLOOM_VALID_OPTIONS = BLOOM_OPT_NOROUND | BLOOM_OPT_ENTS_IS_BITS | BLOOM_OPT_FORCE64 | BLOOM_OPT_NO_SCALING;
const BLOOM_MAX_HASHES = 1075;

const DENOM = 0.480453013918201;
const ERROR_TIGHTENING_RATIO = 0.5;
const BF_ERROR_RATE_CAP = 0.25;

const DEFAULT_ERROR_RATE = 0.01;
const DEFAULT_CAPACITY = 100n;
const DEFAULT_EXPANSION = 2;
const MAX_CAPACITY = 1n << 30n;
const MAX_EXPANSION = 32_768;
const MAX_SCANDUMP_SIZE = 16 * 1024 * 1024;
const SBCHAIN_SIZE = 32n;
const SBLINK_SIZE = 64n;
const HEADER_PREFIX_BYTES = 20;
const LINK_HEADER_BYTES = 53;

interface BFLink {
  idx: number;
  bytes: bigint;
  bits: bigint;
  size: bigint;
  error: number;
  bpe: number;
  hashes: number;
  entries: bigint;
  n2: number;
  chunks: ChunkStore;
}

interface BFChain {
  keyId: number;
  size: bigint;
  options: number;
  growth: number;
  filters: Array<BFLink>;
}

function calcBpe(error: number): number {
  const bpe = -(Math.log(error) / DENOM);
  return bpe < 0 ? -bpe : bpe;
}

function createLink(sql: SqlStorage, keyId: number, idx: number, entries: bigint, error: number): BFLink {
  const bpe = calcBpe(error);
  let bits = BigInt(Math.trunc(Number(entries) * bpe));
  if (bits === 0n) bits = 1n;
  const bytes = bits % 64n !== 0n ? ((bits / 64n) + 1n) * 8n : bits / 8n;
  if (bytes > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("ERR Insufficient memory to create filter");
  const actualBits = bytes * 8n;
  const hashes = Math.ceil(Math.LN2 * bpe);
  return {
    idx,
    bytes,
    bits: actualBits,
    size: 0n,
    error,
    bpe,
    hashes,
    entries,
    n2: 0,
    chunks: new ChunkStore(sql, keyId, "bf_chunks", Number(bytes), idx),
  };
}

function loadChain(ctx: Ctx, key: Uint8Array): BFChain | undefined {
  const row = ctx.ks.getTyped(key, TYPE.bloom);
  if (!row) return undefined;
  const meta = ctx.ks.sql.exec<{ size: string; options: number; growth: number }>(
    "SELECT size, options, growth FROM bf_meta WHERE key_id = ?", row.id).one();
  const filterRows = ctx.ks.sql.exec<{
    idx: number;
    bytes: string;
    bits: string;
    size: string;
    error: number;
    bpe: number;
    hashes: number;
    entries: string;
    n2: number;
  }>("SELECT idx, bytes, bits, size, error, bpe, hashes, entries, n2 FROM bf_filters WHERE key_id = ? ORDER BY idx", row.id).toArray();
  const filters: Array<BFLink> = filterRows.map((f) => {
    const bytes = BigInt(f.bytes);
    return {
      idx: f.idx,
      bytes,
      bits: BigInt(f.bits),
      size: BigInt(f.size),
      error: f.error,
      bpe: f.bpe,
      hashes: f.hashes,
      entries: BigInt(f.entries),
      n2: f.n2,
      chunks: new ChunkStore(ctx.ks.sql, row.id, "bf_chunks", Number(bytes), f.idx),
    };
  });
  return { keyId: row.id, size: BigInt(meta.size), options: meta.options, growth: meta.growth, filters };
}

function saveLinkRow(sql: SqlStorage, keyId: number, f: BFLink) {
  sql.exec(
    "INSERT INTO bf_filters (key_id, idx, bytes, bits, size, error, bpe, hashes, entries, n2) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id, idx) DO UPDATE SET bytes = excluded.bytes, bits = excluded.bits, size = excluded.size, error = excluded.error, bpe = excluded.bpe, hashes = excluded.hashes, entries = excluded.entries, n2 = excluded.n2",
    keyId, f.idx, String(f.bytes), String(f.bits), String(f.size), f.error, f.bpe, f.hashes, String(f.entries), f.n2);
}

function saveChainMeta(sql: SqlStorage, bf: BFChain) {
  sql.exec(
    "INSERT INTO bf_meta (key_id, size, options, growth) VALUES (?, ?, ?, ?) ON CONFLICT (key_id) DO UPDATE SET size = excluded.size, options = excluded.options, growth = excluded.growth",
    bf.keyId, String(bf.size), bf.options, bf.growth);
}

function createChain(ctx: Ctx, key: Uint8Array, errorRate: number, capacity: bigint, expansion: number, nonScaling: number): BFChain {
  const options = BLOOM_OPT_FORCE64 | nonScaling | BLOOM_OPT_NOROUND;
  const tightening = nonScaling ? 1 : ERROR_TIGHTENING_RATIO;
  const link0 = createLink(ctx.ks.sql, 0, 0, capacity, errorRate * tightening);
  const keyId = ctx.ks.create(key, TYPE.bloom);
  link0.chunks = new ChunkStore(ctx.ks.sql, keyId, "bf_chunks", Number(link0.bytes), 0);
  const bf: BFChain = { keyId, size: 0n, options, growth: expansion, filters: [link0] };
  saveChainMeta(ctx.ks.sql, bf);
  saveLinkRow(ctx.ks.sql, keyId, link0);
  return bf;
}

function calcHash(options: number, item: Uint8Array): [bigint, bigint] {
  if (options & BLOOM_OPT_FORCE64) {
    const a = murmurHash64A(item, 0xc6_a4_a7_93_5b_d1_e9_95n);
    const b = murmurHash64A(item, a);
    return [a, b];
  }
  const a = BigInt(murmurHash2(item, 0x97_47_b2_8c));
  const b = BigInt(murmurHash2(item, Number(a)));
  return [a, b];
}

function testAndSetBit(link: BFLink, bit: number, write: boolean): boolean {
  const byteOff = bit >>> 3;
  const chunkIdx = Math.floor(byteOff / CHUNK_BYTES);
  const inChunk = byteOff & CHUNK_MASK;
  const mask = 1 << (bit & 7);
  const buf = link.chunks.get(chunkIdx);
  const cur = buf[inChunk];
  if (cur & mask) return true;
  if (write) {
    buf[inChunk] = cur | mask;
    link.chunks.markDirty(chunkIdx);
  }
  return false;
}

function checkOrAddLink(link: BFLink, ha: bigint, hb: bigint, force64: boolean, write: boolean): boolean {
  const use32 = link.n2 > 0 && !force64 && link.n2 <= 31;
  let foundUnset = false;
  if (use32) {
    const a32 = Number(ha & 0xff_ff_ff_ffn) >>> 0;
    const b32 = Number(hb & 0xff_ff_ff_ffn) >>> 0;
    const mod = 1 << link.n2;
    for (let i = 0; i < link.hashes; i++) {
      const bit = ((a32 + Math.imul(i, b32)) >>> 0) % mod;
      if (!testAndSetBit(link, bit, write)) {
        if (!write) return false;
        foundUnset = true;
      }
    }
    return write ? foundUnset : true;
  }
  const mod = link.n2 > 0 ? 1n << BigInt(link.n2) : link.bits;
  for (let i = 0; i < link.hashes; i++) {
    const bit = Number(((ha + BigInt(i) * hb) & MASK64) % mod);
    if (!testAndSetBit(link, bit, write)) {
      if (!write) return false;
      foundUnset = true;
    }
  }
  return write ? foundUnset : true;
}

function sbCheck(bf: BFChain, item: Uint8Array): boolean {
  const [ha, hb] = calcHash(bf.options, item);
  const force64 = (bf.options & BLOOM_OPT_FORCE64) !== 0;
  for (let i = bf.filters.length - 1; i >= 0; i--) {
    if (checkOrAddLink(bf.filters[i], ha, hb, force64, false)) return true;
  }
  return false;
}

function sbAdd(sql: SqlStorage, bf: BFChain, item: Uint8Array): number {
  const [ha, hb] = calcHash(bf.options, item);
  const force64 = (bf.options & BLOOM_OPT_FORCE64) !== 0;
  for (let i = bf.filters.length - 1; i >= 0; i--) {
    if (checkOrAddLink(bf.filters[i], ha, hb, force64, false)) return 0;
  }
  let cur = bf.filters.at(-1);
  if (!cur) return -1;
  if (cur.size >= cur.entries) {
    if (bf.options & BLOOM_OPT_NO_SCALING) return -2;
    if (bf.growth === 0 || cur.entries > UINT64_MAX / BigInt(bf.growth)) return -1;
    const nextIdx = bf.filters.length;
    const nextEntries = cur.entries * BigInt(bf.growth);
    const nextError = cur.error * ERROR_TIGHTENING_RATIO;
    const totalNow = bf.filters.reduce((s, f) => s + f.bytes, 0n);
    const nextLink = createLink(sql, bf.keyId, nextIdx, nextEntries, nextError);
    if (totalNow + nextLink.bytes > BigInt(MAX_ALLOC_BYTES)) return -1;
    bf.filters.push(nextLink);
    cur = nextLink;
  }
  if (checkOrAddLink(cur, ha, hb, force64, true)) {
    cur.size += 1n;
    bf.size += 1n;
    return 1;
  }
  return 0;
}

function bfMemUsage(bf: BFChain): bigint {
  let total = SBCHAIN_SIZE + SBLINK_SIZE * BigInt(bf.filters.length);
  for (const f of bf.filters) total += f.bytes;
  return total;
}

function bfCapacity(bf: BFChain): bigint {
  let cap = 0n;
  for (const f of bf.filters) cap += f.entries;
  return cap;
}

function flushChain(ctx: Ctx, key: Uint8Array, bf: BFChain) {
  saveChainMeta(ctx.ks.sql, bf);
  for (const f of bf.filters) {
    saveLinkRow(ctx.ks.sql, bf.keyId, f);
    f.chunks.flush();
  }
  ctx.ks.onChange(key);
}

function getLinkPos(bf: BFChain, curIter: bigint): { link: BFLink; offset: bigint } | undefined {
  if (curIter < 1n) return undefined;
  let pos = curIter - 1n;
  for (const link of bf.filters) {
    if (pos < link.bytes) return { link, offset: pos };
    pos -= link.bytes;
  }
  return undefined;
}

function encodeHeader(bf: BFChain): Uint8Array {
  const out = new Uint8Array(HEADER_PREFIX_BYTES + LINK_HEADER_BYTES * bf.filters.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, bf.size, true);
  view.setUint32(8, bf.filters.length, true);
  view.setUint32(12, bf.options, true);
  view.setUint32(16, bf.growth, true);
  let off = HEADER_PREFIX_BYTES;
  for (const f of bf.filters) {
    view.setBigUint64(off, f.bytes, true);
    view.setBigUint64(off + 8, f.bits, true);
    view.setBigUint64(off + 16, f.size, true);
    view.setFloat64(off + 24, f.error, true);
    view.setFloat64(off + 32, f.bpe, true);
    view.setUint32(off + 40, f.hashes, true);
    view.setBigUint64(off + 44, f.entries, true);
    view.setUint8(off + 52, f.n2);
    off += LINK_HEADER_BYTES;
  }
  return out;
}

function validateLinkHeader(bytes: bigint, bits: bigint, error: number, bpe: number, hashes: number, n2: number): boolean {
  if (!Number.isFinite(error) || error <= 0 || error >= 1) return false;
  if (!Number.isFinite(bpe) || bpe <= 0) return false;
  if (bytes > UINT64_MAX / 8n || n2 > 63) return false;
  if (n2 !== 0 && bits < 1n << BigInt(n2)) return false;
  if (bits === 0n || bits !== bytes * 8n) return false;
  const expectedHashes = Math.ceil(Math.LN2 * bpe);
  if (!Number.isFinite(expectedHashes) || expectedHashes < 1 || expectedHashes > BLOOM_MAX_HASHES) return false;
  return hashes === expectedHashes;
}

function decodeAndCreateFromHeader(ctx: Ctx, key: Uint8Array, buf: Uint8Array): void {
  if (buf.length < HEADER_PREFIX_BYTES) throw new RedisError("ERR received bad data");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = view.getBigUint64(0, true);
  const nfilters = view.getUint32(8, true);
  const options = view.getUint32(12, true);
  const growth = view.getUint32(16, true);
  if (nfilters <= 0 || buf.length !== HEADER_PREFIX_BYTES + LINK_HEADER_BYTES * nfilters) {
    throw new RedisError("ERR received bad data");
  }
  if ((options & ~BLOOM_VALID_OPTIONS) !== 0) throw new RedisError("ERR received bad data");
  const links: Array<BFLink> = [];
  let totalSize = 0n;
  let totalBytes = 0n;
  let off = HEADER_PREFIX_BYTES;
  for (let i = 0; i < nfilters; i++) {
    const bytes = view.getBigUint64(off, true);
    const bits = view.getBigUint64(off + 8, true);
    const linkSize = view.getBigUint64(off + 16, true);
    const error = view.getFloat64(off + 24, true);
    const bpe = view.getFloat64(off + 32, true);
    const hashes = view.getUint32(off + 40, true);
    const entries = view.getBigUint64(off + 44, true);
    const n2 = view.getUint8(off + 52);
    off += LINK_HEADER_BYTES;
    if (!validateLinkHeader(bytes, bits, error, bpe, hashes, n2)) throw new RedisError("ERR received bad data");
    totalSize += linkSize;
    totalBytes += bytes;
    if (totalBytes > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("ERR received bad data");
    links.push({ idx: i, bytes, bits, size: linkSize, error, bpe, hashes, entries, n2, chunks: new ChunkStore(ctx.ks.sql, 0, "bf_chunks", Number(bytes), i) });
  }
  if (totalSize !== size) throw new RedisError("ERR received bad data");
  const keyId = ctx.ks.create(key, TYPE.bloom);
  const bf: BFChain = { keyId, size, options, growth, filters: links };
  saveChainMeta(ctx.ks.sql, bf);
  for (const f of links) saveLinkRow(ctx.ks.sql, keyId, f);
  ctx.ks.onChange(key);
}

function bfReserve(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 4 || args.length > 7) throw wrongArity(args[0]);
  let errorRate = parseDoubleStrict(args[2]);
  if (errorRate === undefined) throw new RedisError("ERR bad error rate");
  if (!(errorRate > 0 && errorRate < 1)) throw new RedisError("ERR error rate must be in the range (0.000000, 1.000000)");
  if (errorRate > BF_ERROR_RATE_CAP) errorRate = BF_ERROR_RATE_CAP;

  const capacity = toInt64(args[3]);
  if (capacity === undefined) throw new RedisError("ERR bad capacity");
  if (capacity < 1n || capacity > MAX_CAPACITY) throw new RedisError("ERR capacity must be in the range [1, 1073741824]");

  let nonScaling = 0;
  if (argIndex("NONSCALING", args) !== -1) nonScaling = BLOOM_OPT_NO_SCALING;
  let expansion = DEFAULT_EXPANSION;
  const exLoc = argIndex("EXPANSION", args);
  if (exLoc + 1 === args.length) throw new RedisError("ERR no expansion");
  if (exLoc !== -1) {
    const expVal = toInt64(args[exLoc + 1]);
    if (expVal === undefined) throw new RedisError("ERR bad expansion");
    if (expVal === 0n) nonScaling = BLOOM_OPT_NO_SCALING;
    else if (nonScaling === BLOOM_OPT_NO_SCALING) throw new RedisError("Nonscaling filters cannot expand");
    if (expVal < 0n || expVal > BigInt(MAX_EXPANSION)) throw new RedisError("ERR expansion must be in the range [0, 32768]");
    expansion = Number(expVal);
  }

  const existing = ctx.ks.getTyped(args[1], TYPE.bloom);
  if (existing) throw new RedisError("ERR item exists");
  createChain(ctx, args[1], errorRate, capacity, expansion, nonScaling);
  return r.ok;
}

function insertCommon(ctx: Ctx, key: Uint8Array, items: Array<Uint8Array>, opts: { capacity: bigint; errorRate: number; autocreate: boolean; isMulti: boolean; expansion: number; nonScaling: number }): Reply {
  let bf = loadChain(ctx, key);
  if (!bf) {
    if (!opts.autocreate) throw new RedisError("ERR not found");
    bf = createChain(ctx, key, opts.errorRate, opts.capacity, opts.expansion, opts.nonScaling);
  }
  const replies: Array<Reply> = [];
  let changed = false;
  for (const item of items) {
    const rv = sbAdd(ctx.ks.sql, bf, item);
    if (rv === -2) {
      if (changed) flushChain(ctx, key, bf);
      const err = r.error("ERR non scaling filter is full");
      if (!opts.isMulti) return err;
      replies.push(err);
      return r.array(replies);
    }
    if (rv === -1) {
      if (changed) flushChain(ctx, key, bf);
      const err = r.error("ERR problem inserting into filter");
      if (!opts.isMulti) return err;
      replies.push(err);
      return r.array(replies);
    }
    if (rv === 1) changed = true;
    const reply = r.bool(rv !== 0);
    if (!opts.isMulti) {
      if (changed) flushChain(ctx, key, bf);
      return reply;
    }
    replies.push(reply);
  }
  if (changed) flushChain(ctx, key, bf);
  return r.array(replies);
}

function bfAdd(ctx: Ctx, args: Array<Uint8Array>, isMulti: boolean): Reply {
  if ((isMulti && args.length < 3) || (!isMulti && args.length !== 3)) throw wrongArity(args[0]);
  return insertCommon(ctx, args[1], args.slice(2), {
    capacity: DEFAULT_CAPACITY,
    errorRate: DEFAULT_ERROR_RATE,
    autocreate: true,
    isMulti,
    expansion: DEFAULT_EXPANSION,
    nonScaling: 0,
  });
}

function bfInsert(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 4) throw wrongArity(args[0]);
  let capacity = DEFAULT_CAPACITY;
  let errorRate = DEFAULT_ERROR_RATE;
  let autocreate = true;
  let expansion = DEFAULT_EXPANSION;
  let nonScaling = 0;
  let itemsIndex = -1;
  let cur = 2;
  while (cur < args.length && itemsIndex < 0) {
    const kw = opt(args[cur]);
    if (kw === "ITEMS") {
      itemsIndex = cur + 1;
      break;
    }
    if (kw === "ERROR") {
      if (++cur === args.length) throw wrongArity(args[0]);
      const er = parseDoubleStrict(args[cur++]);
      if (er === undefined || !(er > 0 && er < 1)) throw new RedisError("Bad error rate");
      errorRate = er > BF_ERROR_RATE_CAP ? BF_ERROR_RATE_CAP : er;
    } else if (kw === "EXPANSION") {
      if (++cur === args.length) throw wrongArity(args[0]);
      const ex = toInt64(args[cur++]);
      if (ex === undefined || ex < 0n || ex > BigInt(MAX_EXPANSION)) throw new RedisError("Bad expansion");
      expansion = Number(ex);
    } else if (kw === "CAPACITY") {
      if (++cur === args.length) throw wrongArity(args[0]);
      const cap = toInt64(args[cur++]);
      if (cap === undefined || cap < 1n || cap > MAX_CAPACITY) throw new RedisError("Bad capacity");
      capacity = cap;
    } else if (kw === "NOCREATE") {
      autocreate = false;
      cur++;
    } else if (kw === "NONSCALING") {
      nonScaling = BLOOM_OPT_NO_SCALING;
      cur++;
    } else {
      throw new RedisError("Unknown argument received");
    }
  }
  if (expansion === 0) nonScaling = BLOOM_OPT_NO_SCALING;
  if (itemsIndex < 0 || itemsIndex === args.length) throw wrongArity(args[0]);
  return insertCommon(ctx, args[1], args.slice(itemsIndex), { capacity, errorRate, autocreate, isMulti: true, expansion, nonScaling });
}

function bfExists(ctx: Ctx, args: Array<Uint8Array>, isMulti: boolean): Reply {
  if ((isMulti && args.length < 3) || (!isMulti && args.length !== 3)) throw wrongArity(args[0]);
  const row = ctx.ks.get(args[1]);
  const bf = row?.type === TYPE.bloom ? loadChain(ctx, args[1]) : undefined;
  if (!isMulti) return r.bool(bf ? sbCheck(bf, args[2]) : false);
  return r.array(args.slice(2).map((item) => r.bool(bf ? sbCheck(bf, item) : false)));
}

function bfCard(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const bf = loadChain(ctx, key);
  return r.int(bf ? bf.size : 0n);
}

function bfInfo(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 2 && args.length !== 3) throw wrongArity(args[0]);
  const bf = loadChain(ctx, args[1]);
  if (!bf) throw new RedisError("ERR not found");
  const expansionVal = bf.options & BLOOM_OPT_NO_SCALING ? r.nil : r.int(bf.growth);
  if (args.length === 3) {
    const sub = opt(args[2]);
    let entry: [string, Reply];
    if (sub === "CAPACITY") entry = ["Capacity", r.int(bfCapacity(bf))];
    else if (sub === "SIZE") entry = ["Size", r.int(bfMemUsage(bf))];
    else if (sub === "FILTERS") entry = ["Number of filters", r.int(bf.filters.length)];
    else if (sub === "ITEMS") entry = ["Number of items inserted", r.int(bf.size)];
    else if (sub === "EXPANSION") entry = ["Expansion rate", expansionVal];
    else throw new RedisError("Invalid information value");
    return ctx.session.proto === 3 ? r.map([[r.simple(entry[0]), entry[1]]]) : r.array([entry[1]]);
  }
  return r.map([
    [r.simple("Capacity"), r.int(bfCapacity(bf))],
    [r.simple("Size"), r.int(bfMemUsage(bf))],
    [r.simple("Number of filters"), r.int(bf.filters.length)],
    [r.simple("Number of items inserted"), r.int(bf.size)],
    [r.simple("Expansion rate"), expansionVal],
  ]);
}

function bfDebug(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const bf = loadChain(ctx, key);
  if (!bf) throw new RedisError("ERR not found");
  const hw = bf.options & BLOOM_OPT_FORCE64 ? 64 : 32;
  const out: Array<Reply> = [r.bulk(`size:${bf.size}`)];
  for (const f of bf.filters) {
    const bits = f.bits !== 0n ? f.bits : 1n << BigInt(f.n2);
    out.push(r.bulk(`bytes:${f.bytes} bits:${bits} hashes:${f.hashes} hashwidth:${hw} capacity:${f.entries} size:${f.size} ratio:${formatPrintfG(f.error)}`));
  }
  return r.array(out);
}

function bfScandump(ctx: Ctx, [, key, iterArg]: Array<Uint8Array>): Reply {
  const bf = loadChain(ctx, key);
  if (!bf) throw new RedisError("ERR not found");
  const iter = toInt64(iterArg);
  if (iter === undefined) throw new RedisError("Second argument must be numeric");
  if (iter === 0n) return r.array([r.int(1), r.bulk(encodeHeader(bf))]);
  const pos = getLinkPos(bf, iter);
  if (!pos) return r.array([r.int(0), r.bulk(new Uint8Array(0))]);
  const remaining = pos.link.bytes - pos.offset;
  const len = remaining < BigInt(MAX_SCANDUMP_SIZE) ? Number(remaining) : MAX_SCANDUMP_SIZE;
  const chunk = pos.link.chunks.readRange(Number(pos.offset), len);
  return r.array([r.int(iter + BigInt(len)), r.bulk(chunk)]);
}

function bfLoadchunk(ctx: Ctx, [, key, iterArg, data]: Array<Uint8Array>): Reply {
  const iter = toInt64(iterArg);
  if (iter === undefined) throw new RedisError("ERR Second argument must be numeric");
  const bf = loadChain(ctx, key);
  if (!bf && iter === 1n) {
    decodeAndCreateFromHeader(ctx, key, data);
    return r.ok;
  }
  if (!bf) throw new RedisError("ERR not found");
  if (iter <= 0n || iter < BigInt(data.length)) throw new RedisError("ERR received bad data");
  const pos = getLinkPos(bf, iter - BigInt(data.length));
  if (!pos) throw new RedisError("ERR invalid offset - no link found");
  if (BigInt(data.length) > pos.link.bytes - pos.offset) throw new RedisError("ERR invalid chunk - Too big for current filter");
  pos.link.chunks.writeRange(Number(pos.offset), data);
  pos.link.chunks.flush();
  ctx.ks.onChange(key);
  return r.ok;
}

export const bloomCommands = {
  bfReserve,
  bfAdd,
  bfInsert,
  bfExists,
  bfCard,
  bfInfo,
  bfDebug,
  bfScandump,
  bfLoadchunk,
};
