import { toInt64 } from "../commands/args";
import type { Ctx } from "../commands/types";
import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { blob, fromBlob, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { CHUNK_BYTES, CHUNK_MASK, ChunkStore, MAX_ALLOC_BYTES } from "./chunks";
import { MASK64, murmurHash2, parseDoubleStrict, wrongArity } from "./hash";

const TOPK_DEFAULT_WIDTH = 8;
const TOPK_DEFAULT_DEPTH = 7;
const TOPK_DEFAULT_DECAY = 0.9;
const TOPK_DECAY_LOOKUP_TABLE = 256;
const GA = 1919;
const UINT32_MAX = 0xff_ff_ff_ffn;
const MAX_INCREMENT = 100_000n;
const INCREMENT_ERR = "TopK: increment must be an integer greater or equal to 0                            and smaller or equal to 100,000";

interface Bucket {
  fp: number;
  count: number;
}

interface HeapBucket {
  fp: number;
  count: number;
  item: Uint8Array | null;
}

interface TopK {
  keyId: number;
  k: number;
  width: number;
  depth: number;
  decay: number;
  heap: Array<HeapBucket>;
  lookupTable: Float64Array;
  chunks: ChunkStore;
}

let seedState: { s: bigint } | undefined;

function nextRandom(state: { s: bigint }): bigint {
  state.s = (state.s + 0x9e_37_79_b9_7f_4a_7c_15n) & MASK64;
  let z = state.s;
  z = ((z ^ (z >> 30n)) * 0xbf_58_47_6d_1c_e4_e5_b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94_d0_49_bb_13_31_11_ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

function nextSeed(): bigint {
  if (!seedState) {
    const b = new Uint32Array(2);
    crypto.getRandomValues(b);
    seedState = { s: (BigInt(b[1]) << 32n) | BigInt(b[0]) };
  }
  return nextRandom(seedState) >> 1n;
}

function topkRandom(rng: { s: bigint }): number {
  return Number(nextRandom(rng) >> 11n) * 2 ** -53;
}

function buildLookup(decay: number): Float64Array {
  const t = new Float64Array(TOPK_DECAY_LOOKUP_TABLE);
  for (let i = 0; i < TOPK_DECAY_LOOKUP_TABLE; i++) t[i] = decay ** i;
  return t;
}

function cString(b: Uint8Array): Uint8Array {
  const nul = b.indexOf(0);
  return nul === -1 ? b : b.subarray(0, nul);
}

function loadTopK(ctx: Ctx, key: Uint8Array): TopK {
  const row = ctx.ks.getTyped(key, TYPE.topk);
  if (!row) throw new RedisError("TopK: key does not exist");
  const m = ctx.ks.sql.exec<{ k: number; width: number; depth: number; decay: number }>(
    "SELECT k, width, depth, decay FROM topk_meta WHERE key_id = ?", row.id).one();
  const heap: Array<HeapBucket> = Array.from({ length: m.k }, () => ({ fp: 0, count: 0, item: null }));
  const hRows = ctx.ks.sql.exec<{ idx: number; fp: number; count: number; item: ArrayBuffer | null }>(
    "SELECT idx, fp, count, item FROM topk_heap WHERE key_id = ?", row.id).toArray();
  for (const h of hRows) heap[h.idx] = { fp: h.fp, count: h.count, item: h.item ? fromBlob(h.item) : null };
  return {
    keyId: row.id,
    k: m.k,
    width: m.width,
    depth: m.depth,
    decay: m.decay,
    heap,
    lookupTable: buildLookup(m.decay),
    chunks: new ChunkStore(ctx.ks.sql, row.id, "topk_chunks", m.width * m.depth * 8),
  };
}

function saveHeap(sql: SqlStorage, topk: TopK) {
  sql.exec("DELETE FROM topk_heap WHERE key_id = ?", topk.keyId);
  for (let i = 0; i < topk.k; i++) {
    const h = topk.heap[i];
    if (h.item !== null) {
      sql.exec("INSERT INTO topk_heap (key_id, idx, fp, count, item) VALUES (?, ?, ?, ?, ?)",
        topk.keyId, i, h.fp, h.count, blob(h.item));
    }
  }
}

function getBucket(topk: TopK, idx: number): Bucket {
  const off = idx * 8;
  const buf = topk.chunks.get(Math.floor(off / CHUNK_BYTES));
  const view = new DataView(buf.buffer, buf.byteOffset + (off & CHUNK_MASK), 8);
  return { fp: view.getUint32(0, true), count: view.getUint32(4, true) };
}

function setBucket(topk: TopK, idx: number, fp: number, count: number) {
  const off = idx * 8;
  const chunkIdx = Math.floor(off / CHUNK_BYTES);
  const buf = topk.chunks.get(chunkIdx);
  const view = new DataView(buf.buffer, buf.byteOffset + (off & CHUNK_MASK), 8);
  view.setUint32(0, fp, true);
  view.setUint32(4, count, true);
  topk.chunks.markDirty(chunkIdx);
}

function heapifyDown(heap: Array<HeapBucket>, len: number, start: number) {
  let child = start;
  if (len < 2 || Math.floor((len - 2) / 2) < child) return;
  child = 2 * child + 1;
  if (child + 1 < len && heap[child].count > heap[child + 1].count) child++;
  if (heap[child].count > heap[start].count) return;
  const top = heap[start];
  do {
    heap[start] = heap[child];
    start = child;
    if (Math.floor((len - 2) / 2) < child) break;
    child = 2 * child + 1;
    if (child + 1 < len && heap[child].count > heap[child + 1].count) child++;
  } while (heap[child].count < top.count);
  heap[start] = top;
}

function findInHeap(topk: TopK, item: Uint8Array, fp: number): number {
  for (let i = topk.k - 1; i >= 0; i--) {
    const h = topk.heap[i];
    if (h.fp === fp && h.item !== null && sameBytes(h.item, item)) return i;
  }
  return -1;
}

function topkAddItem(topk: TopK, item: Uint8Array, increment: number, rng: { s: bigint }): Uint8Array | null {
  let maxCount = 0;
  const fp = murmurHash2(item, GA);
  const heapMin = topk.heap[0].count;
  for (let i = 0; i < topk.depth; i++) {
    const loc = murmurHash2(item, i) % topk.width;
    const bIdx = i * topk.width + loc;
    const b = getBucket(topk, bIdx);
    let bFp = b.fp;
    let bCount = b.count;
    if (bCount === 0) {
      bFp = fp;
      bCount = increment >>> 0;
      if (bCount > maxCount) maxCount = bCount;
    } else if (bFp === fp) {
      bCount = (bCount + increment) >>> 0;
      if (bCount > maxCount) maxCount = bCount;
    } else {
      for (let localIncr = increment; localIncr > 0; localIncr--) {
        let decay: number;
        if (bCount < TOPK_DECAY_LOOKUP_TABLE) {
          decay = topk.lookupTable[bCount];
        } else {
          const base = topk.lookupTable[TOPK_DECAY_LOOKUP_TABLE - 1];
          const exp = Math.floor(bCount / (TOPK_DECAY_LOOKUP_TABLE - 1));
          const rem = bCount % (TOPK_DECAY_LOOKUP_TABLE - 1);
          decay = base ** exp * topk.lookupTable[rem];
        }
        if (topkRandom(rng) < decay) {
          bCount = (bCount - 1) >>> 0;
          if (bCount === 0) {
            bFp = fp;
            bCount = localIncr >>> 0;
            if (bCount > maxCount) maxCount = bCount;
            break;
          }
        }
      }
    }
    setBucket(topk, bIdx, bFp, bCount);
  }
  if (maxCount >= heapMin) {
    const idx = findInHeap(topk, item, fp);
    if (idx !== -1) {
      topk.heap[idx].count = maxCount;
      heapifyDown(topk.heap, topk.k, idx);
    } else {
      const expelled = topk.heap[0].item;
      topk.heap[0] = { fp, count: maxCount, item };
      heapifyDown(topk.heap, topk.k, 0);
      return expelled;
    }
  }
  return null;
}

function topkReserve(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 3 && args.length !== 6) throw wrongArity(args[0]);
  if (ctx.ks.exists(args[1])) throw new RedisError("TopK: key already exists");
  const k64 = toInt64(args[2]);
  if (k64 === undefined || k64 > UINT32_MAX || k64 < 1n) throw new RedisError("TopK: invalid k");
  let width = TOPK_DEFAULT_WIDTH;
  let depth = TOPK_DEFAULT_DEPTH;
  let decay = TOPK_DEFAULT_DECAY;
  if (args.length === 6) {
    const w64 = toInt64(args[3]);
    if (w64 === undefined || w64 > UINT32_MAX || w64 < 1n) throw new RedisError("TopK: invalid width");
    const d64 = toInt64(args[4]);
    if (d64 === undefined || d64 > UINT32_MAX || d64 < 1n) throw new RedisError("TopK: invalid depth");
    const dec = parseDoubleStrict(args[5]);
    if (dec === undefined || !(dec > 0 && dec <= 1)) throw new RedisError("TopK: invalid decay value. must be '<= 1' & '> 0'");
    width = Number(w64);
    depth = Number(d64);
    decay = dec;
  }
  const k = Number(k64);
  const totalBytes = BigInt(width) * BigInt(depth) * 8n + BigInt(k) * 24n;
  if (totalBytes > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("ERR Insufficient memory to create topk data structure");
  const keyId = ctx.ks.create(args[1], TYPE.topk);
  ctx.ks.sql.exec("INSERT INTO topk_meta (key_id, k, width, depth, decay) VALUES (?, ?, ?, ?, ?)",
    keyId, k, width, depth, decay);
  return r.ok;
}

function topkAdd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const topk = loadTopK(ctx, args[1]);
  const rng = { s: nextSeed() };
  const out = args.slice(2).map((item) => {
    const expelled = topkAddItem(topk, item, 1, rng);
    return expelled === null ? r.nil : r.bulk(cString(expelled));
  });
  saveHeap(ctx.ks.sql, topk);
  topk.chunks.flush();
  ctx.ks.onChange(args[1]);
  return r.array(out);
}

function topkIncrby(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 4 || (args.length - 2) % 2 !== 0) throw wrongArity(args[0]);
  const topk = loadTopK(ctx, args[1]);
  const rng = { s: nextSeed() };
  const count = (args.length - 2) / 2;
  const out: Array<Reply> = [];
  let applied = 0;
  for (let i = 0; i < count; i++) {
    const item = args[2 + i * 2];
    const incr = toInt64(args[2 + i * 2 + 1]);
    if (incr === undefined || incr < 0n || incr > MAX_INCREMENT) {
      out.push(r.error(INCREMENT_ERR));
      break;
    }
    const expelled = topkAddItem(topk, item, Number(incr), rng);
    out.push(expelled === null ? r.nil : r.bulk(cString(expelled)));
    applied++;
  }
  if (applied > 0) {
    saveHeap(ctx.ks.sql, topk);
    topk.chunks.flush();
    ctx.ks.onChange(args[1]);
  }
  return r.array(out);
}

function topkQuery(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const topk = loadTopK(ctx, args[1]);
  return r.array(args.slice(2).map((item) => r.bool(findInHeap(topk, item, murmurHash2(item, GA)) !== -1)));
}

function topkCount(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const topk = loadTopK(ctx, args[1]);
  const heapMin = topk.heap[0].count;
  return r.array(args.slice(2).map((item) => {
    const fp = murmurHash2(item, GA);
    const inHeap = findInHeap(topk, item, fp) !== -1;
    let res = 0;
    for (let i = 0; i < topk.depth; i++) {
      const loc = murmurHash2(item, i) % topk.width;
      const b = getBucket(topk, i * topk.width + loc);
      if (b.fp === fp && (!inHeap || b.count >= heapMin)) {
        if (b.count > res) res = b.count;
      }
    }
    return r.int(res);
  }));
}

function topkList(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 2 && args.length !== 3) throw wrongArity(args[0]);
  let withCount = false;
  if (args.length === 3) {
    const s = text(args[2]).toUpperCase();
    if (s.length <= 9 && "WITHCOUNT".startsWith(s)) withCount = true;
    else throw new RedisError("WITHCOUNT keyword expected");
  }
  const topk = loadTopK(ctx, args[1]);
  const sorted = topk.heap.toSorted((a, b) => b.count - a.count);
  const out: Array<Reply> = [];
  for (const h of sorted) {
    if (h.count === 0) break;
    out.push(r.bulk(h.item ? cString(h.item) : new Uint8Array(0)));
    if (withCount) out.push(r.int(h.count));
  }
  return r.array(out);
}

function topkInfo(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const topk = loadTopK(ctx, key);
  return r.map([
    [r.simple("k"), r.int(topk.k)],
    [r.simple("width"), r.int(topk.width)],
    [r.simple("depth"), r.int(topk.depth)],
    [r.simple("decay"), r.double(topk.decay)],
  ]);
}

export const topkCommands = {
  topkReserve,
  topkAdd,
  topkIncrby,
  topkQuery,
  topkCount,
  topkList,
  topkInfo,
};
