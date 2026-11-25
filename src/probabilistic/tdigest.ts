import { toInt64 } from "../commands/args";
import type { Ctx } from "../commands/types";
import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { fromBlob, sameBytes } from "../store/keyspace";
import { TYPE } from "../store/schema";
import { CHUNK_BYTES, CHUNK_MASK, ChunkStore, MAX_ALLOC_BYTES } from "./chunks";
import { argIndex, parseDoubleStrict, wrongArity } from "./hash";

const TD_DEFAULT_COMPRESSION = 100;
const TD_INSORT_THRESHOLD = 16;
const TD_STRUCT_SIZE = 80;
const INT32_MAX = 2_147_483_647;
const INT64_MAX = (1n << 63n) - 1n;

interface TDigest {
  keyId: number;
  compression: number;
  min: number;
  max: number;
  cap: number;
  mergedNodes: number;
  unmergedNodes: number;
  totalCompressions: bigint;
  mergedWeight: bigint;
  unmergedWeight: bigint;
  chunks: ChunkStore;
  compressedDirty: boolean;
}

function encodeBounds(min: number, max: number): ArrayBuffer {
  const b = new ArrayBuffer(16);
  const v = new DataView(b);
  v.setFloat64(0, min, true);
  v.setFloat64(8, max, true);
  return b;
}

function decodeBounds(raw: ArrayBuffer): [number, number] {
  const b = fromBlob(raw);
  const v = new DataView(b.buffer, b.byteOffset, 16);
  return [v.getFloat64(0, true), v.getFloat64(8, true)];
}

function getMean(td: TDigest, i: number): number {
  const off = i * 16;
  const buf = td.chunks.get(Math.floor(off / CHUNK_BYTES));
  return new DataView(buf.buffer, buf.byteOffset + (off & CHUNK_MASK), 16).getFloat64(0, true);
}

function getWeight(td: TDigest, i: number): bigint {
  const off = i * 16;
  const buf = td.chunks.get(Math.floor(off / CHUNK_BYTES));
  return new DataView(buf.buffer, buf.byteOffset + (off & CHUNK_MASK), 16).getBigInt64(8, true);
}

function setNode(td: TDigest, i: number, mean: number, weight: bigint) {
  const off = i * 16;
  const chunkIdx = Math.floor(off / CHUNK_BYTES);
  const buf = td.chunks.get(chunkIdx);
  const v = new DataView(buf.buffer, buf.byteOffset + (off & CHUNK_MASK), 16);
  v.setFloat64(0, mean, true);
  v.setBigInt64(8, weight, true);
  td.chunks.markDirty(chunkIdx);
}

function swapNodes(td: TDigest, i: number, j: number) {
  if (i === j) return;
  const mi = getMean(td, i);
  const wi = getWeight(td, i);
  setNode(td, i, getMean(td, j), getWeight(td, j));
  setNode(td, j, mi, wi);
}

function tdInsertionSort(td: TDigest, lo: number, hi: number) {
  for (let i = lo + 1; i <= hi; i++) {
    const m = getMean(td, i);
    const w = getWeight(td, i);
    let j = i - 1;
    while (j >= lo && m < getMean(td, j)) {
      setNode(td, j + 1, getMean(td, j), getWeight(td, j));
      j--;
    }
    setNode(td, j + 1, m, w);
  }
}

function tdSiftDown(td: TDigest, lo: number, i: number, n: number) {
  while (i < Math.floor(n / 2)) {
    let child = 2 * i + 1;
    if (child + 1 < n && getMean(td, lo + child) < getMean(td, lo + child + 1)) child++;
    if (!(getMean(td, lo + i) < getMean(td, lo + child))) break;
    swapNodes(td, lo + i, lo + child);
    i = child;
  }
}

function tdHeapSort(td: TDigest, lo: number, hi: number) {
  const n = hi - lo + 1;
  for (let i = Math.floor(n / 2) - 1; i >= 0; i--) tdSiftDown(td, lo, i, n);
  for (let end = n - 1; end > 0; end--) {
    swapNodes(td, lo, lo + end);
    tdSiftDown(td, lo, 0, end);
  }
}

function tdMedian3(td: TDigest, lo: number, mid: number, hi: number): number {
  if (getMean(td, mid) < getMean(td, lo)) swapNodes(td, lo, mid);
  if (getMean(td, hi) < getMean(td, lo)) swapNodes(td, lo, hi);
  if (getMean(td, hi) < getMean(td, mid)) swapNodes(td, mid, hi);
  return getMean(td, mid);
}

function tdIntrosort(td: TDigest, lo: number, hi: number, depthLimit: number) {
  while (hi - lo > TD_INSORT_THRESHOLD) {
    if (depthLimit === 0) {
      tdHeapSort(td, lo, hi);
      return;
    }
    depthLimit--;
    const mid = lo + Math.floor((hi - lo) / 2);
    const pivot = tdMedian3(td, lo, mid, hi);
    let lt = lo;
    let i = lo;
    let gt = hi;
    while (i <= gt) {
      const v = getMean(td, i);
      if (v < pivot) {
        swapNodes(td, i, lt);
        lt++;
        i++;
      } else if (pivot < v) {
        swapNodes(td, i, gt);
        gt--;
      } else {
        i++;
      }
    }
    const leftSize = lt - lo;
    const rightSize = hi - gt;
    if (leftSize < rightSize) {
      if (leftSize > 1) tdIntrosort(td, lo, lt - 1, depthLimit);
      lo = gt + 1;
    } else {
      if (rightSize > 1) tdIntrosort(td, gt + 1, hi, depthLimit);
      hi = lt - 1;
    }
  }
  tdInsertionSort(td, lo, hi);
}

function tdSort(td: TDigest, lo: number, hi: number) {
  if (lo >= hi) return;
  let depthLimit = 0;
  for (let t = hi - lo + 1; t > 1; t >>= 1) depthLimit += 2;
  tdIntrosort(td, lo, hi, depthLimit);
}

function checkTdOverflow(unmergedWeight: number, totalWeight: number): boolean {
  if (!Number.isFinite(unmergedWeight) || !Number.isFinite(totalWeight)) return true;
  const denom = 2 * Math.PI * totalWeight * Math.log(totalWeight);
  return denom === Infinity;
}

function tdCompress(td: TDigest): boolean {
  if (td.unmergedNodes === 0) return true;
  const n = td.mergedNodes + td.unmergedNodes;
  tdSort(td, 0, n - 1);
  const totalWeight = td.mergedWeight + td.unmergedWeight;
  const totalWeightD = Number(totalWeight);
  if (checkTdOverflow(Number(td.unmergedWeight), totalWeightD)) return false;
  if (totalWeight <= 1n) {
    td.mergedNodes += td.unmergedNodes;
    td.mergedWeight = totalWeight;
    td.unmergedNodes = 0;
    td.unmergedWeight = 0n;
    td.totalCompressions += 1n;
    td.compressedDirty = true;
    return true;
  }
  const denom = 2 * Math.PI * totalWeightD * Math.log(totalWeightD);
  if (!Number.isFinite(denom)) return false;
  const normalizer = td.compression / denom;
  if (!Number.isFinite(normalizer)) return false;
  let cur = 0;
  let weightSoFar = 0;
  for (let i = 1; i < n; i++) {
    const wi = getWeight(td, i);
    const wCur = getWeight(td, cur);
    const proposedWeight = Number(wCur) + Number(wi);
    const z = proposedWeight * normalizer;
    const q0 = weightSoFar / totalWeightD;
    const q2 = (weightSoFar + proposedWeight) / totalWeightD;
    if (z <= q0 * (1 - q0) && z <= q2 * (1 - q2)) {
      const nextW = wCur + wi;
      const delta = getMean(td, i) - getMean(td, cur);
      const weightedDelta = (delta * Number(wi)) / Number(nextW);
      setNode(td, cur, getMean(td, cur) + weightedDelta, nextW);
    } else {
      weightSoFar += Number(wCur);
      cur++;
      setNode(td, cur, getMean(td, i), wi);
    }
    if (cur !== i) setNode(td, i, 0.0, 0n);
  }
  td.mergedNodes = cur + 1;
  td.mergedWeight = totalWeight;
  td.unmergedNodes = 0;
  td.unmergedWeight = 0n;
  td.totalCompressions += 1n;
  td.compressedDirty = true;
  return true;
}

function tdAdd(td: TDigest, mean: number, weight: bigint): boolean {
  if (!Number.isFinite(mean)) return false;
  if (td.mergedNodes + td.unmergedNodes >= td.cap - 1 && !tdCompress(td)) return false;
  const pos = td.mergedNodes + td.unmergedNodes;
  if (pos >= td.cap) return false;
  if (weight > INT64_MAX - td.unmergedWeight) return false;
  const newUnmerged = td.unmergedWeight + weight;
  if (newUnmerged > INT64_MAX - td.mergedWeight) return false;
  const newTotal = newUnmerged + td.mergedWeight;
  if (checkTdOverflow(Number(newUnmerged), Number(newTotal))) return false;
  if (mean < td.min) td.min = mean;
  if (mean > td.max) td.max = mean;
  setNode(td, pos, mean, weight);
  td.unmergedNodes++;
  td.unmergedWeight = newUnmerged;
  return true;
}

function tdMerge(into: TDigest, from: TDigest): boolean {
  if (!tdCompress(into) || !tdCompress(from)) return false;
  const pos = from.mergedNodes + from.unmergedNodes;
  for (let i = 0; i < pos; i++) {
    if (!tdAdd(into, getMean(from, i), getWeight(from, i))) return false;
  }
  return true;
}

function weightedAvg(x1: number, w1: number, x2: number, w2: number): number {
  const lo = x1 <= x2 ? x1 : x2;
  const hi = x1 <= x2 ? x2 : x1;
  const wl = x1 <= x2 ? w1 : w2;
  const wh = x1 <= x2 ? w2 : w1;
  const x = (lo * wl + hi * wh) / (wl + wh);
  return Math.max(lo, Math.min(x, hi));
}

function tdCdf(td: TDigest, val: number): number {
  tdCompress(td);
  if (td.mergedNodes === 0) return Number.NaN;
  if (val < td.min) return 0;
  if (val > td.max) return 1;
  if (td.mergedNodes === 1) {
    const width = td.max - td.min;
    return val - td.min <= width ? 0.5 : (val - td.min) / width;
  }
  const n = td.mergedNodes;
  const leftMean = getMean(td, 0);
  const leftWeight = Number(getWeight(td, 0));
  const mergedW = Number(td.mergedWeight);
  if (val < leftMean) {
    const width = leftMean - td.min;
    if (width <= 0) return 0;
    if (val === td.min) return 0.5 / mergedW;
    return (1 + ((val - td.min) / width) * (leftWeight / 2 - 1)) / mergedW;
  }
  const rightMean = getMean(td, n - 1);
  const rightWeight = Number(getWeight(td, n - 1));
  if (val > rightMean) {
    const width = td.max - rightMean;
    if (width <= 0) return 1;
    if (val === td.max) return 1 - 0.5 / mergedW;
    return 1 - (1 + ((td.max - val) / width) * (rightWeight / 2 - 1)) / mergedW;
  }
  let weightSoFar = 0;
  for (let it = 0; it < n - 1; it++) {
    const mean = getMean(td, it);
    if (mean === val) {
      let dw = 0;
      while (it < n && getMean(td, it) === val) {
        dw += Number(getWeight(td, it));
        it++;
      }
      return (weightSoFar + dw / 2) / mergedW;
    }
    const nextMean = getMean(td, it + 1);
    const w = Number(getWeight(td, it));
    const nextW = Number(getWeight(td, it + 1));
    if (mean <= val && val < nextMean) {
      if (nextMean - mean > 0) {
        let leftExcl = 0;
        let rightExcl = 0;
        if (w === 1) {
          if (nextW === 1) return (weightSoFar + 1) / mergedW;
          leftExcl = 0.5;
        } else if (nextW === 1) {
          rightExcl = 0.5;
        }
        const dw = (w + nextW) / 2;
        const dwNoSing = dw - leftExcl - rightExcl;
        const base = weightSoFar + w / 2 + leftExcl;
        return (base + (dwNoSing * (val - mean)) / (nextMean - mean)) / mergedW;
      }
      return (weightSoFar + (w + nextW) / 2) / mergedW;
    }
    weightSoFar += w;
  }
  return 1 - 0.5 / mergedW;
}

function iterateToIndex(td: TDigest, index: number, leftWeight: number, n: number, state: { weightSoFar: number; nodePos: number }): number {
  if (leftWeight > 1 && index < leftWeight / 2) {
    return td.min + ((index - 1) / (leftWeight / 2 - 1)) * (getMean(td, 0) - td.min);
  }
  const mergedW = Number(td.mergedWeight);
  if (index > mergedW - 1) return td.max;
  const rightWeight = Number(getWeight(td, n - 1));
  const rightMean = getMean(td, n - 1);
  if (rightWeight > 1 && mergedW - index <= rightWeight / 2) {
    return td.max - ((mergedW - index - 1) / (rightWeight / 2 - 1)) * (td.max - rightMean);
  }
  for (; state.nodePos < n - 1; state.nodePos++) {
    const i = state.nodePos;
    const nw = Number(getWeight(td, i));
    const nwn = Number(getWeight(td, i + 1));
    const nm = getMean(td, i);
    const nmn = getMean(td, i + 1);
    const dw = (nw + nwn) / 2;
    if (state.weightSoFar + dw > index) {
      let leftUnit = 0;
      if (nw === 1) {
        if (index - state.weightSoFar < 0.5) return nm;
        leftUnit = 0.5;
      }
      let rightUnit = 0;
      if (nwn === 1) {
        if (state.weightSoFar + dw - index <= 0.5) return nmn;
        rightUnit = 0.5;
      }
      const z1 = index - state.weightSoFar - leftUnit;
      const z2 = state.weightSoFar + dw - index - rightUnit;
      return weightedAvg(nm, z2, nmn, z1);
    }
    state.weightSoFar += dw;
  }
  const z1 = index - mergedW - rightWeight / 2;
  const z2 = rightWeight / 2 - z1;
  return weightedAvg(rightMean, z1, td.max, z2);
}

function tdQuantile(td: TDigest, q: number): number {
  tdCompress(td);
  if (q < 0 || q > 1 || td.mergedNodes === 0) return Number.NaN;
  if (td.mergedNodes === 1) return getMean(td, 0);
  const index = q * Number(td.mergedWeight);
  if (index < 1) return td.min;
  const leftWeight = Number(getWeight(td, 0));
  return iterateToIndex(td, index, leftWeight, td.mergedNodes, { weightSoFar: leftWeight / 2, nodePos: 0 });
}

function tdQuantiles(td: TDigest, quantiles: Array<number>, out: Array<number>, start: number, len: number) {
  tdCompress(td);
  const n = td.mergedNodes;
  if (n === 0) {
    for (let i = 0; i < len; i++) out[start + i] = Number.NaN;
    return;
  }
  if (n === 1) {
    const m0 = getMean(td, 0);
    for (let i = 0; i < len; i++) {
      const q = quantiles[start + i];
      out[start + i] = q < 0 || q > 1 ? Number.NaN : m0;
    }
    return;
  }
  const leftWeight = Number(getWeight(td, 0));
  const state = { weightSoFar: leftWeight / 2, nodePos: 0 };
  const mergedW = Number(td.mergedWeight);
  for (let i = 0; i < len; i++) {
    out[start + i] = iterateToIndex(td, quantiles[start + i] * mergedW, leftWeight, n, state);
  }
}

function tdTrimmedMean(td: TDigest, leftCut: number, rightCut: number): number {
  tdCompress(td);
  if (td.mergedNodes === 0 || leftCut < 0 || leftCut > 1 || rightCut < 0 || rightCut > 1) return Number.NaN;
  if (td.mergedNodes === 1) return getMean(td, 0);
  const mergedW = Number(td.mergedWeight);
  const leftW = Math.floor(mergedW * leftCut);
  const rightW = Math.ceil(mergedW * rightCut);
  let countDone = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < td.mergedNodes; i++) {
    const nw = Number(getWeight(td, i));
    let add = nw - Math.min(Math.max(0, leftW - countDone), nw);
    add = Math.min(Math.max(0, rightW - countDone), add);
    countDone += nw;
    sum += getMean(td, i) * add;
    count += add;
    if (countDone >= rightW) break;
  }
  return sum / count;
}

function cRound(x: number): number {
  const intPart = Math.trunc(x);
  return Math.abs(x - intPart) < 0.5 ? intPart : intPart >= 0 ? intPart + 1 : intPart - 1;
}

function halfRoundDown(f: number): number {
  const intPart = Math.trunc(f);
  return Math.abs(f - intPart) <= 0.5 ? intPart : intPart >= 0 ? intPart + 1 : intPart - 1;
}

function capacityFromCompression(compression: number): number {
  if (!Number.isFinite(compression) || compression <= 0 || compression > INT32_MAX) throw new RedisError("ERR T-Digest: allocation failed");
  const cap64 = 6n * BigInt(Math.trunc(compression)) + 10n;
  if (cap64 > BigInt(INT32_MAX) || cap64 * 16n > BigInt(MAX_ALLOC_BYTES)) throw new RedisError("ERR T-Digest: allocation failed");
  return Number(cap64);
}

function newTDigest(sql: SqlStorage, keyId: number, compression: number): TDigest {
  const cap = capacityFromCompression(compression);
  return {
    keyId,
    compression,
    min: Number.MAX_VALUE,
    max: -Number.MAX_VALUE,
    cap,
    mergedNodes: 0,
    unmergedNodes: 0,
    totalCompressions: 0n,
    mergedWeight: 0n,
    unmergedWeight: 0n,
    chunks: new ChunkStore(sql, keyId, "tdigest_chunks", cap * 16),
    compressedDirty: false,
  };
}

function loadTDigest(ctx: Ctx, key: Uint8Array): TDigest {
  const row = ctx.ks.getTyped(key, TYPE.tdigest);
  if (!row) throw new RedisError("ERR T-Digest: key does not exist");
  const m = ctx.ks.sql.exec<{
    compression: number;
    bounds: ArrayBuffer;
    cap: number;
    merged_nodes: number;
    unmerged_nodes: number;
    total_compressions: string;
    merged_weight: string;
    unmerged_weight: string;
  }>("SELECT compression, bounds, cap, merged_nodes, unmerged_nodes, total_compressions, merged_weight, unmerged_weight FROM tdigest_meta WHERE key_id = ?", row.id).one();
  const [min, max] = decodeBounds(m.bounds);
  return {
    keyId: row.id,
    compression: m.compression,
    min,
    max,
    cap: m.cap,
    mergedNodes: m.merged_nodes,
    unmergedNodes: m.unmerged_nodes,
    totalCompressions: BigInt(m.total_compressions),
    mergedWeight: BigInt(m.merged_weight),
    unmergedWeight: BigInt(m.unmerged_weight),
    chunks: new ChunkStore(ctx.ks.sql, row.id, "tdigest_chunks", m.cap * 16),
    compressedDirty: false,
  };
}

function saveTDigest(sql: SqlStorage, td: TDigest) {
  sql.exec(
    "INSERT INTO tdigest_meta (key_id, compression, bounds, cap, merged_nodes, unmerged_nodes, total_compressions, merged_weight, unmerged_weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id) DO UPDATE SET compression = excluded.compression, bounds = excluded.bounds, cap = excluded.cap, merged_nodes = excluded.merged_nodes, unmerged_nodes = excluded.unmerged_nodes, total_compressions = excluded.total_compressions, merged_weight = excluded.merged_weight, unmerged_weight = excluded.unmerged_weight",
    td.keyId, td.compression, encodeBounds(td.min, td.max), td.cap, td.mergedNodes, td.unmergedNodes,
    String(td.totalCompressions), String(td.mergedWeight), String(td.unmergedWeight));
  td.chunks.flush();
}

function persistIfCompressed(sql: SqlStorage, td: TDigest) {
  if (!td.compressedDirty) return;
  saveTDigest(sql, td);
  td.compressedDirty = false;
}

function parseCompression(arg: Uint8Array): number {
  const v = toInt64(arg);
  if (v === undefined) throw new RedisError("ERR T-Digest: error parsing compression parameter");
  if (v <= 0n) throw new RedisError("ERR T-Digest: compression parameter needs to be a positive integer");
  return Number(v);
}

function tdigestCreate(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length !== 2 && args.length !== 4) throw wrongArity(args[0]);
  const existing = ctx.ks.getTyped(args[1], TYPE.tdigest);
  if (existing) throw new RedisError("ERR T-Digest: key already exists");
  let compression = TD_DEFAULT_COMPRESSION;
  if (args.length === 4) {
    if (argIndex("COMPRESSION", args, 2) !== 2) throw new RedisError("ERR T-Digest: wrong keyword");
    compression = parseCompression(args[3]);
  }
  const td = newTDigest(ctx.ks.sql, 0, compression);
  const keyId = ctx.ks.create(args[1], TYPE.tdigest);
  td.keyId = keyId;
  td.chunks = new ChunkStore(ctx.ks.sql, keyId, "tdigest_chunks", td.cap * 16);
  saveTDigest(ctx.ks.sql, td);
  return r.ok;
}

function tdigestReset(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, key);
  td.min = Number.MAX_VALUE;
  td.max = -Number.MAX_VALUE;
  td.mergedNodes = 0;
  td.unmergedNodes = 0;
  td.totalCompressions = 0n;
  td.mergedWeight = 0n;
  td.unmergedWeight = 0n;
  ctx.ks.sql.exec("DELETE FROM tdigest_chunks WHERE key_id = ?", td.keyId);
  saveTDigest(ctx.ks.sql, td);
  ctx.ks.onChange(key);
  return r.ok;
}

function tdigestAdd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, args[1]);
  const vals: Array<number> = [];
  for (let i = 2; i < args.length; i++) {
    const v = parseDoubleStrict(args[i]);
    if (v === undefined) throw new RedisError("ERR T-Digest: error parsing val parameter");
    if (!Number.isFinite(v)) throw new RedisError("ERR T-Digest: val parameter needs to be a finite number");
    vals.push(v);
  }
  for (const v of vals) {
    if (!tdAdd(td, v, 1n)) throw new RedisError("ERR T-Digest: overflow detected");
  }
  saveTDigest(ctx.ks.sql, td);
  ctx.ks.onChange(args[1]);
  return r.ok;
}

function tdigestMerge(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const destKey = args[1];
  const destRow = ctx.ks.getTyped(destKey, TYPE.tdigest);
  const toExists = destRow !== undefined;
  const startTd = toExists ? loadTDigest(ctx, destKey) : undefined;
  const numkeys64 = toInt64(args[2]);
  if (numkeys64 === undefined) throw new RedisError("ERR T-Digest: error parsing numkeys");
  if (numkeys64 <= 0n) throw new RedisError("ERR T-Digest: numkeys needs to be a positive integer");
  if (numkeys64 > BigInt(args.length - 3)) throw wrongArity(args[0]);
  const numkeys = Number(numkeys64);

  let compression = startTd ? startTd.compression : 0;
  let useMax = !toExists;
  let override = false;
  const remStart = numkeys + 3;
  if (remStart < args.length) {
    const compLoc = argIndex("COMPRESSION", args, remStart);
    if (compLoc !== -1) {
      useMax = false;
      if (compLoc + 1 >= args.length) throw wrongArity(args[0]);
      compression = parseCompression(args[compLoc + 1]);
    }
    const overLoc = argIndex("OVERRIDE", args, remStart);
    if (overLoc !== -1) {
      override = true;
      if (compLoc === -1) {
        useMax = true;
        compression = 0;
      }
    }
    if (compLoc === -1 && overLoc === -1) throw new RedisError("ERR T-Digest: wrong keyword");
  }

  const byKey: Array<{ key: Uint8Array; td: TDigest }> = [];
  const srcs: Array<TDigest> = [];
  for (let i = 0; i < numkeys; i++) {
    const k = args[3 + i];
    let src: TDigest;
    if (sameBytes(destKey, k)) {
      if (!startTd) throw new RedisError("ERR T-Digest: key does not exist");
      src = startTd;
    } else {
      const cached = byKey.find((e) => sameBytes(e.key, k));
      if (cached) src = cached.td;
      else {
        src = loadTDigest(ctx, k);
        byKey.push({ key: k, td: src });
      }
    }
    if (useMax && src.compression > compression) compression = src.compression;
    srcs.push(src);
  }

  let dest: TDigest;
  try {
    dest = newTDigest(ctx.ks.sql, -1, compression);
  } catch {
    throw new RedisError("ERR T-Digest: allocation of destination digest failed");
  }
  if (startTd && !override && !tdMerge(dest, startTd)) throw new RedisError("ERR T-Digest: overflow detected");
  for (const s of srcs) if (!tdMerge(dest, s)) throw new RedisError("ERR T-Digest: overflow detected");
  for (const { td } of byKey) persistIfCompressed(ctx.ks.sql, td);

  const keyId = destRow ? destRow.id : ctx.ks.create(destKey, TYPE.tdigest);
  if (destRow) {
    ctx.ks.sql.exec("DELETE FROM tdigest_chunks WHERE key_id = ?", keyId);
  }
  const finalDest: TDigest = { ...dest, keyId, chunks: new ChunkStore(ctx.ks.sql, keyId, "tdigest_chunks", dest.cap * 16) };
  const n = dest.mergedNodes + dest.unmergedNodes;
  for (let i = 0; i < n; i++) setNode(finalDest, i, getMean(dest, i), getWeight(dest, i));
  saveTDigest(ctx.ks.sql, finalDest);
  ctx.ks.onChange(destKey);
  return r.ok;
}

function tdigestMinMax(ctx: Ctx, [, key]: Array<Uint8Array>, isMax: boolean): Reply {
  const td = loadTDigest(ctx, key);
  const size = td.mergedWeight + td.unmergedWeight;
  return r.double(size > 0n ? (isMax ? td.max : td.min) : Number.NaN);
}

function tdigestQuantile(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, args[1]);
  const qs: Array<number> = [];
  for (let i = 2; i < args.length; i++) {
    const q = parseDoubleStrict(args[i]);
    if (q === undefined) throw new RedisError("ERR T-Digest: error parsing quantile");
    if (q < 0 || q > 1) throw new RedisError("ERR T-Digest: quantile should be in [0,1]");
    qs.push(q);
  }
  const vals = new Array<number>(qs.length);
  for (let i = 0; i < qs.length; i++) {
    const start = i;
    while (i < qs.length - 1 && qs[i] <= qs[i + 1]) i++;
    tdQuantiles(td, qs, vals, start, i - start + 1);
  }
  persistIfCompressed(ctx.ks.sql, td);
  return r.array(vals.map((v) => r.double(v)));
}

function tdigestCdf(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, args[1]);
  const xs: Array<number> = [];
  for (let i = 2; i < args.length; i++) {
    const x = parseDoubleStrict(args[i]);
    if (x === undefined) throw new RedisError("ERR T-Digest: error parsing cdf");
    xs.push(x);
  }
  const vals = xs.map((x) => tdCdf(td, x));
  persistIfCompressed(ctx.ks.sql, td);
  return r.array(vals.map((v) => r.double(v)));
}

function tdigestRank(ctx: Ctx, args: Array<Uint8Array>, reverse: boolean): Reply {
  const td = loadTDigest(ctx, args[1]);
  const vals: Array<number> = [];
  for (let i = 2; i < args.length; i++) {
    const v = parseDoubleStrict(args[i]);
    if (v === undefined) throw new RedisError("ERR T-Digest: error parsing value");
    vals.push(v);
  }
  const size = Number(td.mergedWeight + td.unmergedWeight);
  const out = vals.map((v) => {
    if (size === 0) return -2;
    if (v < td.min) return reverse ? size : -1;
    if (v > td.max) return reverse ? -1 : size;
    const cdfPrior = tdCdf(td, v) * size;
    const abs = reverse ? cRound(cdfPrior) : halfRoundDown(cdfPrior);
    return reverse ? cRound(size - abs) : abs;
  });
  persistIfCompressed(ctx.ks.sql, td);
  return r.array(out.map((n) => r.int(n)));
}

function tdigestByRank(ctx: Ctx, args: Array<Uint8Array>, reverse: boolean): Reply {
  const td = loadTDigest(ctx, args[1]);
  const ranks: Array<bigint> = [];
  for (let i = 2; i < args.length; i++) {
    const rk = toInt64(args[i]);
    if (rk === undefined) throw new RedisError("ERR T-Digest: error parsing rank");
    if (rk < 0n) throw new RedisError("ERR T-Digest: rank needs to be non negative");
    ranks.push(rk);
  }
  const size = Number(td.mergedWeight + td.unmergedWeight);
  const out = ranks.map((rk) => {
    const rank = Number(rk);
    if (size === 0) return Number.NaN;
    if (rank === 0) return reverse ? td.max : td.min;
    if (rank >= size) return reverse ? -Infinity : Infinity;
    return tdQuantile(td, (reverse ? size - rank - 1 : rank) / size);
  });
  persistIfCompressed(ctx.ks.sql, td);
  return r.array(out.map((v) => r.double(v)));
}

function tdigestTrimmedMean(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, args[1]);
  const low = parseDoubleStrict(args[2]);
  if (low === undefined) throw new RedisError("ERR T-Digest: error parsing low_cut_percentile");
  const high = parseDoubleStrict(args[3]);
  if (high === undefined) throw new RedisError("ERR T-Digest: error parsing high_cut_percentile");
  if (low < 0 || low > 1 || high < 0 || high > 1) {
    throw new RedisError("ERR T-Digest: low_cut_percentile and high_cut_percentile should be in [0,1]");
  }
  if (low >= high) throw new RedisError("ERR T-Digest: low_cut_percentile should be lower than high_cut_percentile");
  const res = tdTrimmedMean(td, low, high);
  persistIfCompressed(ctx.ks.sql, td);
  return r.double(res);
}

function tdigestInfo(ctx: Ctx, [, key]: Array<Uint8Array>): Reply {
  const td = loadTDigest(ctx, key);
  const mem = TD_STRUCT_SIZE + 16 * td.cap;
  return r.map([
    [r.simple("Compression"), r.int(td.compression)],
    [r.simple("Capacity"), r.int(td.cap)],
    [r.simple("Merged nodes"), r.int(td.mergedNodes)],
    [r.simple("Unmerged nodes"), r.int(td.unmergedNodes)],
    [r.simple("Merged weight"), r.int(td.mergedWeight)],
    [r.simple("Unmerged weight"), r.int(td.unmergedWeight)],
    [r.simple("Observations"), r.int(td.mergedWeight + td.unmergedWeight)],
    [r.simple("Total compressions"), r.int(td.totalCompressions)],
    [r.simple("Memory usage"), r.int(mem)],
  ]);
}

export const tdigestCommands = {
  tdigestCreate,
  tdigestReset,
  tdigestAdd,
  tdigestMerge,
  tdigestMinMax,
  tdigestQuantile,
  tdigestCdf,
  tdigestRank,
  tdigestByRank,
  tdigestTrimmedMean,
  tdigestInfo,
};
