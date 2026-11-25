import { opt, toInt64 } from "../commands/args";
import type { Ctx } from "../commands/types";
import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { CHUNK_BYTES, CHUNK_MASK, ChunkStore, MAX_ALLOC_BYTES } from "./chunks";
import { argIndex, MASK64, murmurHash64A, wrongArity } from "./hash";

const DEFAULT_BUCKET_SIZE = 2;
const DEFAULT_CAPACITY = 1024n;
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_EXPANSION = 1;
const MAX_EXPANSIONS = 32;
const MAX_CAPACITY = 1n << 30n;
const MAX_BUCKET_SIZE = 255;
const MAX_ITERATIONS_LIMIT = 65_535;
const MAX_EXPANSION = 32_768;
const CF_MAX_NUM_BUCKETS = 0x00_ff_ff_ff_ff_ff_ff_ffn;
const MAX_SCANDUMP_SIZE = 16 * 1024 * 1024;
const CF_STRUCT_SIZE = 40n;
const SUBCF_STRUCT_SIZE = 16n;
const CF_HEADER_BYTES = 38;

interface SubCF {
  idx: number;
  numBuckets: bigint;
  bucketSize: number;
  chunks: ChunkStore;
}

interface CuckooFilter {
  keyId: number;
  numBuckets: bigint;
  numItems: bigint;
  numDeletes: bigint;
  numFilters: number;
  bucketSize: number;
  maxIterations: number;
  expansion: number;
  filters: Array<SubCF>;
}

interface LookupParams {
  h1: bigint;
  h2: bigint;
  fp: number;
}

function nextPower2(n: bigint): bigint {
  if (n <= 0n) return 0n;
  let p = 1n;
  while (p < n) p <<= 1n;
  return p;
}

function isPower2(n: bigint): boolean {
  return n > 0n && (n & (n - 1n)) === 0n;
}

function getAltHash(fp: number, index: bigint): bigint {
  return (index ^ ((BigInt(fp) * 0x5b_d1_e9_95n) & MASK64)) & MASK64;
}

function lookupParams(item: Uint8Array): LookupParams {
  const hash = murmurHash64A(item, 0n);
  const fp = Number(hash % 255n) + 1;
  return { h1: hash, h2: getAltHash(fp, hash), fp };
}

function readSlot(sub: SubCF, byteOff: number): number {
  const chunkIdx = Math.floor(byteOff / CHUNK_BYTES);
  return sub.chunks.get(chunkIdx)[byteOff & CHUNK_MASK];
}

function writeSlot(sub: SubCF, byteOff: number, val: number) {
  const chunkIdx = Math.floor(byteOff / CHUNK_BYTES);
  sub.chunks.get(chunkIdx)[byteOff & CHUNK_MASK] = val;
  sub.chunks.markDirty(chunkIdx);
}

function bucketBase(sub: SubCF, hash: bigint): number {
  return Number(hash % sub.numBuckets) * sub.bucketSize;
}

function findInBucket(sub: SubCF, base: number, fp: number): number {
  for (let i = 0; i < sub.bucketSize; i++) if (readSlot(sub, base + i) === fp) return base + i;
  return -1;
}

function countInBucket(sub: SubCF, base: number, fp: number): number {
  let n = 0;
  for (let i = 0; i < sub.bucketSize; i++) if (readSlot(sub, base + i) === fp) n++;
  return n;
}

function subTotalBytes(cf: CuckooFilter): bigint {
  let sum = 0n;
  for (const f of cf.filters) sum += f.numBuckets * BigInt(f.bucketSize);
  return sum;
}

function cfMemUsage(cf: CuckooFilter): bigint {
  return CF_STRUCT_SIZE + SUBCF_STRUCT_SIZE * BigInt(cf.numFilters) + subTotalBytes(cf);
}

function saveMeta(sql: SqlStorage, cf: CuckooFilter) {
  sql.exec(
    "INSERT INTO cf_meta (key_id, num_buckets, num_items, num_deletes, num_filters, bucket_size, max_iterations, expansion) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id) DO UPDATE SET num_buckets = excluded.num_buckets, num_items = excluded.num_items, num_deletes = excluded.num_deletes, num_filters = excluded.num_filters, bucket_size = excluded.bucket_size, max_iterations = excluded.max_iterations, expansion = excluded.expansion",
    cf.keyId, String(cf.numBuckets), String(cf.numItems), String(cf.numDeletes), cf.numFilters, cf.bucketSize, cf.maxIterations, cf.expansion);
}

function saveFilterRow(sql: SqlStorage, keyId: number, sub: SubCF) {
  sql.exec(
    "INSERT INTO cf_filters (key_id, idx, num_buckets) VALUES (?, ?, ?) ON CONFLICT (key_id, idx) DO UPDATE SET num_buckets = excluded.num_buckets",
    keyId, sub.idx, String(sub.numBuckets));
}

function loadCF(ctx: Ctx, key: Uint8Array): CuckooFilter | undefined {
  const row = ctx.ks.getTyped(key, TYPE.cuckoo);
  if (!row) return undefined;
  const m = ctx.ks.sql.exec<{
    num_buckets: string;
    num_items: string;
    num_deletes: string;
    num_filters: number;
    bucket_size: number;
    max_iterations: number;
    expansion: number;
  }>("SELECT num_buckets, num_items, num_deletes, num_filters, bucket_size, max_iterations, expansion FROM cf_meta WHERE key_id = ?", row.id).one();
  const fRows = ctx.ks.sql.exec<{ idx: number; num_buckets: string }>(
    "SELECT idx, num_buckets FROM cf_filters WHERE key_id = ? ORDER BY idx", row.id).toArray();
  const filters: Array<SubCF> = fRows.map((f) => {
    const nb = BigInt(f.num_buckets);
    return { idx: f.idx, numBuckets: nb, bucketSize: m.bucket_size, chunks: new ChunkStore(ctx.ks.sql, row.id, "cf_chunks", Number(nb) * m.bucket_size, f.idx) };
  });
  return {
    keyId: row.id,
    numBuckets: BigInt(m.num_buckets),
    numItems: BigInt(m.num_items),
    numDeletes: BigInt(m.num_deletes),
    numFilters: m.num_filters,
    bucketSize: m.bucket_size,
    maxIterations: m.max_iterations,
    expansion: m.expansion,
    filters,
  };
}

function createCF(ctx: Ctx, key: Uint8Array, capacity: bigint, bucketSize: number, maxIterations: number, expansion: number): CuckooFilter {
  const expPow2 = Number(nextPower2(BigInt(expansion)));
  let numBuckets = nextPower2(capacity / BigInt(bucketSize));
  if (numBuckets === 0n) numBuckets = 1n;
  const bytes = numBuckets * BigInt(bucketSize);
  if (numBuckets > CF_MAX_NUM_BUCKETS || bytes > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("ERR Insufficient memory to create filter");
  const keyId = ctx.ks.create(key, TYPE.cuckoo);
  const sub: SubCF = { idx: 0, numBuckets, bucketSize, chunks: new ChunkStore(ctx.ks.sql, keyId, "cf_chunks", Number(bytes), 0) };
  const cf: CuckooFilter = {
    keyId,
    numBuckets,
    numItems: 0n,
    numDeletes: 0n,
    numFilters: 1,
    bucketSize,
    maxIterations,
    expansion: expPow2,
    filters: [sub],
  };
  saveMeta(ctx.ks.sql, cf);
  saveFilterRow(ctx.ks.sql, keyId, sub);
  return cf;
}

function growCF(sql: SqlStorage, cf: CuckooFilter): boolean {
  if (cf.numFilters >= MAX_ITERATIONS_LIMIT) return false;
  const growth = BigInt(cf.expansion) ** BigInt(cf.numFilters);
  if (growth > CF_MAX_NUM_BUCKETS / cf.numBuckets) return false;
  const subBuckets = cf.numBuckets * growth;
  const subBytes = subBuckets * BigInt(cf.bucketSize);
  if (subTotalBytes(cf) + subBytes > BigInt(MAX_ALLOC_BYTES)) return false;
  const idx = cf.numFilters;
  const sub: SubCF = { idx, numBuckets: subBuckets, bucketSize: cf.bucketSize, chunks: new ChunkStore(sql, cf.keyId, "cf_chunks", Number(subBytes), idx) };
  cf.filters.push(sub);
  cf.numFilters++;
  saveFilterRow(sql, cf.keyId, sub);
  return true;
}

function checkFP(cf: CuckooFilter, p: LookupParams): boolean {
  for (const f of cf.filters) {
    if (findInBucket(f, bucketBase(f, p.h1), p.fp) !== -1 || findInBucket(f, bucketBase(f, p.h2), p.fp) !== -1) return true;
  }
  return false;
}

function koInsert(cf: CuckooFilter, sub: SubCF, p: LookupParams): boolean {
  const maxIter = cf.maxIterations;
  const numBuckets = sub.numBuckets;
  const bucketSize = cf.bucketSize;
  let fp = p.fp;
  let victimIx = 0;
  let ii = p.h1 % numBuckets;
  for (let counter = 0; counter < maxIter; counter++) {
    const slot = Number(ii) * bucketSize + victimIx;
    const old = readSlot(sub, slot);
    writeSlot(sub, slot, fp);
    fp = old;
    ii = getAltHash(fp, ii) % numBuckets;
    const empty = findInBucket(sub, Number(ii) * bucketSize, 0);
    if (empty !== -1) {
      writeSlot(sub, empty, fp);
      return true;
    }
    victimIx = (victimIx + 1) % bucketSize;
  }
  for (let counter = 0; counter < maxIter; counter++) {
    victimIx = (victimIx + bucketSize - 1) % bucketSize;
    ii = getAltHash(fp, ii) % numBuckets;
    const slot = Number(ii) * bucketSize + victimIx;
    const old = readSlot(sub, slot);
    writeSlot(sub, slot, fp);
    fp = old;
  }
  return false;
}

function insertFP(sql: SqlStorage, cf: CuckooFilter, p: LookupParams): 1 | -1 | -2 {
  while (true) {
    for (let i = cf.numFilters - 1; i >= 0; i--) {
      const f = cf.filters[i];
      const slot = findInBucket(f, bucketBase(f, p.h1), 0);
      if (slot !== -1) {
        writeSlot(f, slot, p.fp);
        cf.numItems += 1n;
        return 1;
      }
      const slot2 = findInBucket(f, bucketBase(f, p.h2), 0);
      if (slot2 !== -1) {
        writeSlot(f, slot2, p.fp);
        cf.numItems += 1n;
        return 1;
      }
    }
    if (koInsert(cf, cf.filters[cf.numFilters - 1], p)) {
      cf.numItems += 1n;
      return 1;
    }
    if (cf.expansion === 0) return -1;
    if (!growCF(sql, cf)) return -2;
  }
}

function compactCF(sql: SqlStorage, cf: CuckooFilter, cont: boolean) {
  for (let fi = cf.numFilters - 1; fi > 0; fi--) {
    const cur = cf.filters[fi];
    let ok = true;
    for (let b = 0n; b < cur.numBuckets; b++) {
      for (let s = 0; s < cur.bucketSize; s++) {
        const off = Number(b) * cur.bucketSize + s;
        const fp = readSlot(cur, off);
        if (fp === 0) continue;
        const h1 = b;
        const h2 = getAltHash(fp, b);
        let placed = false;
        for (let ti = 0; ti < fi; ti++) {
          const dst = cf.filters[ti];
          const slot = findInBucket(dst, bucketBase(dst, h1), 0);
          if (slot !== -1) {
            writeSlot(dst, slot, fp);
            writeSlot(cur, off, 0);
            placed = true;
            break;
          }
          const slot2 = findInBucket(dst, bucketBase(dst, h2), 0);
          if (slot2 !== -1) {
            writeSlot(dst, slot2, fp);
            writeSlot(cur, off, 0);
            placed = true;
            break;
          }
        }
        if (!placed) ok = false;
      }
    }
    if (ok && fi === cf.numFilters - 1) {
      sql.exec("DELETE FROM cf_chunks WHERE key_id = ? AND filter_idx = ?", cf.keyId, fi);
      sql.exec("DELETE FROM cf_filters WHERE key_id = ? AND idx = ?", cf.keyId, fi);
      cf.filters.pop();
      cf.numFilters--;
    } else if (!ok && !cont) {
      break;
    }
  }
  cf.numDeletes = 0n;
}

function flushCF(ctx: Ctx, key: Uint8Array, cf: CuckooFilter) {
  saveMeta(ctx.ks.sql, cf);
  for (const f of cf.filters) f.chunks.flush();
  ctx.ks.onChange(key);
}

function cfReserve(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 3 || args.length % 2 === 0) throw wrongArity(args[0]);
  const capacity = toInt64(args[2]);
  if (capacity === undefined) throw new RedisError("Bad capacity");

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  const miLoc = argIndex("MAXITERATIONS", args, 3);
  if (miLoc !== -1) {
    const v = toInt64(args[miLoc + 1]);
    if (v === undefined) throw new RedisError("Couldn't parse MAXITERATIONS");
    if (v < 1n || v > BigInt(MAX_ITERATIONS_LIMIT)) throw new RedisError("MAXITERATIONS: value must be in the range [1, 65535]");
    maxIterations = Number(v);
  }

  let bucketSize = DEFAULT_BUCKET_SIZE;
  const bsLoc = argIndex("BUCKETSIZE", args, 3);
  if (bsLoc !== -1) {
    const v = toInt64(args[bsLoc + 1]);
    if (v === undefined) throw new RedisError("Couldn't parse BUCKETSIZE");
    if (v < 1n || v > BigInt(MAX_BUCKET_SIZE)) throw new RedisError("BUCKETSIZE: value must be in the range [1, 255]");
    bucketSize = Number(v);
  }

  let expansion = DEFAULT_EXPANSION;
  const exLoc = argIndex("EXPANSION", args, 3);
  if (exLoc !== -1) {
    const v = toInt64(args[exLoc + 1]);
    if (v === undefined) throw new RedisError("Couldn't parse EXPANSION");
    if (v < 0n || v > BigInt(MAX_EXPANSION)) throw new RedisError("EXPANSION: value must be in the range [0, 32768]");
    expansion = Number(v);
  }

  if (BigInt(bucketSize) * 2n > capacity || capacity > MAX_CAPACITY) {
    throw new RedisError("Capacity must be in the range [2 * BUCKETSIZE, 1073741824]");
  }
  const existing = ctx.ks.getTyped(args[1], TYPE.cuckoo);
  if (existing) throw new RedisError("ERR item exists");
  createCF(ctx, args[1], capacity, bucketSize, maxIterations, expansion);
  return r.ok;
}

function cfInsertCommon(ctx: Ctx, key: Uint8Array, items: Array<Uint8Array>, opts: { isNx: boolean; autocreate: boolean; isMulti: boolean; capacity: bigint }): Reply {
  let cf = loadCF(ctx, key);
  let mutated = false;
  if (!cf) {
    if (!opts.autocreate) throw new RedisError("ERR not found");
    cf = createCF(ctx, key, opts.capacity, DEFAULT_BUCKET_SIZE, DEFAULT_MAX_ITERATIONS, DEFAULT_EXPANSION);
    mutated = true;
  }
  if (cf.numFilters >= MAX_EXPANSIONS) {
    if (mutated) flushCF(ctx, key, cf);
    throw new RedisError("Maximum expansions reached");
  }
  const replies: Array<Reply> = [];
  for (const item of items) {
    const p = lookupParams(item);
    let status: 1 | 0 | -1 | -2;
    if (opts.isNx && checkFP(cf, p)) status = 0;
    else status = insertFP(ctx.ks.sql, cf, p);
    if (status === 1) mutated = true;
    if (status === 1 || status === 0) {
      const reply = opts.isNx && opts.isMulti ? r.int(status) : r.bool(status === 1);
      if (!opts.isMulti) {
        if (mutated) flushCF(ctx, key, cf);
        return reply;
      }
      replies.push(reply);
    } else {
      if (!opts.isMulti) {
        if (mutated) flushCF(ctx, key, cf);
        throw new RedisError(status === -2 ? "ERR Insufficient memory" : "Filter is full");
      }
      replies.push(!opts.isNx && ctx.session.proto === 3 ? r.bool(false) : r.int(-1));
    }
  }
  if (mutated) flushCF(ctx, key, cf);
  return r.array(replies);
}

function cfAdd(ctx: Ctx, args: Array<Uint8Array>, isNx: boolean): Reply {
  return cfInsertCommon(ctx, args[1], [args[2]], { isNx, autocreate: true, isMulti: false, capacity: DEFAULT_CAPACITY });
}

function cfInsert(ctx: Ctx, args: Array<Uint8Array>, isNx: boolean): Reply {
  if (args.length < 4) throw wrongArity(args[0]);
  let autocreate = true;
  let capacity = DEFAULT_CAPACITY;
  let itemsPos = -1;
  let cur = 2;
  while (cur < args.length && itemsPos < 0) {
    const kw = opt(args[cur]);
    if (kw === "ITEMS") {
      itemsPos = cur + 1;
      break;
    }
    if (kw === "CAPACITY") {
      if (++cur === args.length) throw wrongArity(args[0]);
      const v = toInt64(args[cur++]);
      if (v === undefined) throw new RedisError("Bad capacity");
      if (v < BigInt(DEFAULT_BUCKET_SIZE * 2) || v > MAX_CAPACITY) {
        throw new RedisError("Capacity must be in the range [cf-bucket-size * 2, 1073741824]");
      }
      capacity = v;
    } else if (kw === "NOCREATE") {
      autocreate = false;
      cur++;
    } else {
      throw new RedisError("Unknown argument received");
    }
  }
  if (itemsPos < 0 || itemsPos === args.length) throw wrongArity(args[0]);
  return cfInsertCommon(ctx, args[1], args.slice(itemsPos), { isNx, autocreate, isMulti: true, capacity });
}

function cfCheck(ctx: Ctx, args: Array<Uint8Array>, isMulti: boolean, isCount: boolean): Reply {
  if ((isMulti && args.length < 3) || (!isMulti && args.length !== 3)) throw wrongArity(args[0]);
  const row = ctx.ks.get(args[1]);
  const cf = row?.type === TYPE.cuckoo ? loadCF(ctx, args[1]) : undefined;
  const items = args.slice(2);
  const out = items.map((item) => {
    if (!cf) return isCount ? r.int(0) : r.bool(false);
    const p = lookupParams(item);
    if (!isCount) return r.bool(checkFP(cf, p));
    let total = 0n;
    for (const f of cf.filters) total += BigInt(countInBucket(f, bucketBase(f, p.h1), p.fp) + countInBucket(f, bucketBase(f, p.h2), p.fp));
    return r.int(total);
  });
  return isMulti ? r.array(out) : out[0];
}

function cfDel(ctx: Ctx, [, key, item]: Array<Uint8Array>): Reply {
  const row = ctx.ks.get(key);
  if (row?.type !== TYPE.cuckoo) throw new RedisError("Not found");
  const cf = loadCF(ctx, key);
  if (!cf) throw new RedisError("Not found");
  const p = lookupParams(item);
  for (let i = cf.numFilters - 1; i >= 0; i--) {
    const f = cf.filters[i];
    let slot = findInBucket(f, bucketBase(f, p.h1), p.fp);
    if (slot === -1) slot = findInBucket(f, bucketBase(f, p.h2), p.fp);
    if (slot !== -1) {
      writeSlot(f, slot, 0);
      cf.numItems -= 1n;
      cf.numDeletes += 1n;
      if (cf.numFilters > 1 && Number(cf.numDeletes) > Number(cf.numItems) * 0.10) compactCF(ctx.ks.sql, cf, false);
      flushCF(ctx, key, cf);
      return r.bool(true);
    }
  }
  return r.bool(false);
}

function cfCompact(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const row = ctx.ks.get(key);
  if (row?.type !== TYPE.cuckoo) throw new RedisError("Cuckoo filter was not found");
  const cf = loadCF(ctx, key);
  if (!cf) throw new RedisError("Cuckoo filter was not found");
  compactCF(ctx.ks.sql, cf, true);
  flushCF(ctx, key, cf);
  return r.ok;
}

function cfInfo(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const cf = loadCF(ctx, key);
  if (!cf) throw new RedisError("ERR not found");
  return r.map([
    [r.simple("Size"), r.int(cfMemUsage(cf))],
    [r.simple("Number of buckets"), r.int(cf.numBuckets)],
    [r.simple("Number of filters"), r.int(cf.numFilters)],
    [r.simple("Number of items inserted"), r.int(cf.numItems)],
    [r.simple("Number of items deleted"), r.int(cf.numDeletes)],
    [r.simple("Bucket size"), r.int(cf.bucketSize)],
    [r.simple("Expansion rate"), r.int(cf.expansion)],
    [r.simple("Max iterations"), r.int(cf.maxIterations)],
  ]);
}

function cfDebug(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const cf = loadCF(ctx, key);
  if (!cf) throw new RedisError("ERR not found");
  return r.bulk(`bktsize:${cf.bucketSize} buckets:${cf.numBuckets} items:${cf.numItems} deletes:${cf.numDeletes} filters:${cf.numFilters} max_iterations:${cf.maxIterations} expansion:${cf.expansion}`);
}

function cfScandump(ctx: Ctx, [, key, posArg]: Array<Uint8Array>): Reply {
  const pos = toInt64(posArg);
  if (pos === undefined || pos < 0n) throw new RedisError("Invalid position");
  const cf = loadCF(ctx, key);
  if (!cf) throw new RedisError("ERR not found");
  if (cf.numItems === 0n) return r.array([r.int(0), r.nil]);
  if (pos === 0n) {
    const hdr = new Uint8Array(CF_HEADER_BYTES);
    const view = new DataView(hdr.buffer);
    view.setBigUint64(0, cf.numItems, true);
    view.setBigUint64(8, cf.numBuckets, true);
    view.setBigUint64(16, cf.numDeletes, true);
    view.setBigUint64(24, BigInt(cf.numFilters), true);
    view.setUint16(32, cf.bucketSize, true);
    view.setUint16(34, cf.maxIterations, true);
    view.setUint16(36, cf.expansion, true);
    return r.array([r.int(1), r.bulk(hdr)]);
  }
  let offset = pos - 1n;
  for (const f of cf.filters) {
    const size = f.numBuckets * BigInt(f.bucketSize);
    if (offset < size) {
      const remaining = size - offset;
      const len = remaining < BigInt(MAX_SCANDUMP_SIZE) ? Number(remaining) : MAX_SCANDUMP_SIZE;
      return r.array([r.int(pos + BigInt(len)), r.bulk(f.chunks.readRange(Number(offset), len))]);
    }
    offset -= size;
  }
  return r.array([r.int(0), r.nil]);
}

function cfLoadchunk(ctx: Ctx, [, key, posArg, data]: Array<Uint8Array>): Reply {
  const pos = toInt64(posArg);
  if (pos === undefined || pos === 0n) throw new RedisError("Invalid position");
  const existing = loadCF(ctx, key);
  if (pos === 1n) {
    if (existing) throw new RedisError("ERR item exists");
    if (data.length !== CF_HEADER_BYTES) throw new RedisError("Invalid header");
    const view = new DataView(data.buffer, data.byteOffset, CF_HEADER_BYTES);
    const numItems = view.getBigUint64(0, true);
    const numBuckets = view.getBigUint64(8, true);
    const numDeletes = view.getBigUint64(16, true);
    const numFilters64 = view.getBigUint64(24, true);
    const bucketSize = view.getUint16(32, true);
    const maxIterations = view.getUint16(34, true);
    const expansion = view.getUint16(36, true);
    if (
      bucketSize < 1 || bucketSize > MAX_BUCKET_SIZE ||
      numFilters64 < 1n || numFilters64 > BigInt(MAX_EXPANSIONS) ||
      maxIterations < 1 || maxIterations > MAX_ITERATIONS_LIMIT ||
      expansion > MAX_EXPANSION ||
      (expansion === 0 && numFilters64 > 1n) ||
      numBuckets === 0n || numBuckets > CF_MAX_NUM_BUCKETS || !isPower2(numBuckets)
    ) {
      throw new RedisError("Couldn't create filter!");
    }
    const numFilters = Number(numFilters64);
    const filters: Array<SubCF> = [];
    let totalBytes = 0n;
    for (let i = 0; i < numFilters; i++) {
      const nb = numBuckets * BigInt(expansion) ** BigInt(i);
      if (nb === 0n || nb > CF_MAX_NUM_BUCKETS) throw new RedisError("Couldn't create filter!");
      const bytes = nb * BigInt(bucketSize);
      totalBytes += bytes;
      if (totalBytes > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("Couldn't create filter!");
      filters.push({ idx: i, numBuckets: nb, bucketSize, chunks: new ChunkStore(ctx.ks.sql, 0, "cf_chunks", Number(bytes), i) });
    }
    const keyId = ctx.ks.create(key, TYPE.cuckoo);
    const cf: CuckooFilter = { keyId, numBuckets, numItems, numDeletes, numFilters, bucketSize, maxIterations, expansion, filters };
    saveMeta(ctx.ks.sql, cf);
    for (const f of filters) saveFilterRow(ctx.ks.sql, keyId, f);
    ctx.ks.onChange(key);
    return r.ok;
  }
  if (!existing) throw new RedisError("ERR not found");
  if (data.length === 0 || pos < 0n || pos - 1n < BigInt(data.length)) throw new RedisError("Couldn't load chunk!");
  let offset = pos - BigInt(data.length) - 1n;
  for (const f of existing.filters) {
    const size = f.numBuckets * BigInt(f.bucketSize);
    if (offset < size) {
      if (offset + BigInt(data.length) > size) throw new RedisError("Couldn't load chunk!");
      f.chunks.writeRange(Number(offset), data);
      f.chunks.flush();
      ctx.ks.onChange(key);
      return r.ok;
    }
    offset -= size;
  }
  throw new RedisError("Couldn't load chunk!");
}

export const cuckooCommands = {
  cfReserve,
  cfAdd,
  cfInsert,
  cfCheck,
  cfDel,
  cfCompact,
  cfInfo,
  cfDebug,
  cfScandump,
  cfLoadchunk,
};
