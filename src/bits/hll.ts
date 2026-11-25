import { RedisError } from "../resp/reply";

export const HLL_P = 14;
export const HLL_Q = 50;
export const HLL_REGISTERS = 16_384;
export const HLL_HDR_SIZE = 16;
export const HLL_DENSE_SIZE = HLL_HDR_SIZE + (HLL_REGISTERS * 6) / 8;
export const HLL_DENSE = 0;
export const HLL_SPARSE = 1;
export const HLL_SPARSE_VAL_MAX_VALUE = 32;
export const HLL_SPARSE_VAL_MAX_LEN = 4;
export const HLL_SPARSE_ZERO_MAX_LEN = 64;
export const HLL_SPARSE_XZERO_MAX_LEN = 16_384;
export const HLL_SPARSE_MAX_BYTES = 3000;
export const INVALID_HLL = "WRONGTYPE Key is not a valid HyperLogLog string value.";

export interface HllUpdate {
  buf: Uint8Array;
  updated: boolean;
}

const HLL_ALPHA_INF = 0.7213475204444817;
const MURMUR_SEED = 0xad_c8_3b_19n;
const MURMUR_M = 0xc6_a4_a7_93_5b_d1_e9_95n;
const MURMUR_R = 47n;
const MASK64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

const isZero = (b: number) => (b & 0xc0) === 0x00;
const isXzero = (b: number) => (b & 0xc0) === 0x40;
const isVal = (b: number) => (b & 0x80) !== 0;
const zeroLen = (b: number) => (b & 0x3f) + 1;
const xzeroLen = (b0: number, b1: number) => (((b0 & 0x3f) << 8) | b1) + 1;
const valValue = (b: number) => ((b >> 2) & 0x1f) + 1;
const valLen = (b: number) => (b & 0x03) + 1;
const encodeZero = (len: number) => (len - 1) & 0x3f;
const encodeVal = (val: number, len: number) => 0x80 | (((val - 1) & 0x1f) << 2) | ((len - 1) & 0x03);

function pushZeroRun(seq: Array<number>, len: number) {
  if (len <= HLL_SPARSE_ZERO_MAX_LEN) {
    seq.push(encodeZero(len));
    return;
  }
  const n = len - 1;
  seq.push(0x40 | ((n >> 8) & 0x3f), n & 0xff);
}

export function murmurHash64A(data: Uint8Array, seed = MURMUR_SEED): bigint {
  const len = data.length;
  let h = (seed ^ ((BigInt(len) * MURMUR_M) & MASK64)) & MASK64;
  const nblocks = len & ~7;
  for (let i = 0; i < nblocks; i += 8) {
    let k =
      BigInt(data[i]) |
      (BigInt(data[i + 1]) << 8n) |
      (BigInt(data[i + 2]) << 16n) |
      (BigInt(data[i + 3]) << 24n) |
      (BigInt(data[i + 4]) << 32n) |
      (BigInt(data[i + 5]) << 40n) |
      (BigInt(data[i + 6]) << 48n) |
      (BigInt(data[i + 7]) << 56n);
    k = (k * MURMUR_M) & MASK64;
    k ^= k >> MURMUR_R;
    k = (k * MURMUR_M) & MASK64;
    h ^= k;
    h = (h * MURMUR_M) & MASK64;
  }
  const rem = len & 7;
  if (rem >= 7) h ^= BigInt(data[nblocks + 6]) << 48n;
  if (rem >= 6) h ^= BigInt(data[nblocks + 5]) << 40n;
  if (rem >= 5) h ^= BigInt(data[nblocks + 4]) << 32n;
  if (rem >= 4) h ^= BigInt(data[nblocks + 3]) << 24n;
  if (rem >= 3) h ^= BigInt(data[nblocks + 2]) << 16n;
  if (rem >= 2) h ^= BigInt(data[nblocks + 1]) << 8n;
  if (rem >= 1) {
    h ^= BigInt(data[nblocks]);
    h = (h * MURMUR_M) & MASK64;
  }
  h ^= h >> MURMUR_R;
  h = (h * MURMUR_M) & MASK64;
  h ^= h >> MURMUR_R;
  return h;
}

export function hllPatLen(ele: Uint8Array): [number, number] {
  let hash = murmurHash64A(ele);
  const index = Number(hash & BigInt(HLL_REGISTERS - 1));
  hash = (hash >> BigInt(HLL_P)) | (1n << BigInt(HLL_Q));
  let bit = 1n;
  let count = 1;
  while ((hash & bit) === 0n) {
    count++;
    bit <<= 1n;
  }
  return [index, count];
}

export function createSparseHll(): Uint8Array {
  const out = new Uint8Array(HLL_HDR_SIZE + 2);
  out[0] = 0x48;
  out[1] = 0x59;
  out[2] = 0x4c;
  out[3] = 0x4c;
  out[4] = HLL_SPARSE;
  out[15] = 0x80;
  out[16] = 0x7f;
  out[17] = 0xff;
  return out;
}

export function assertValidHll(buf: Uint8Array) {
  if (
    buf.length < HLL_HDR_SIZE ||
    buf[0] !== 0x48 ||
    buf[1] !== 0x59 ||
    buf[2] !== 0x4c ||
    buf[3] !== 0x4c ||
    (buf[4] !== HLL_DENSE && buf[4] !== HLL_SPARSE) ||
    (buf[4] === HLL_DENSE && buf.length !== HLL_DENSE_SIZE)
  ) {
    throw new RedisError(INVALID_HLL);
  }
}

export function isCacheValid(buf: Uint8Array): boolean {
  return (buf[15] & 0x80) === 0;
}

export function invalidateCache(buf: Uint8Array) {
  buf[15] |= 0x80;
}

export function readCachedCard(buf: Uint8Array): bigint {
  let card = 0n;
  for (let i = 0; i < 8; i++) card |= BigInt(buf[8 + i]) << BigInt(i * 8);
  return card;
}

export function writeCachedCard(buf: Uint8Array, card: bigint) {
  for (let i = 0; i < 8; i++) buf[8 + i] = Number((card >> BigInt(i * 8)) & 0xffn);
  buf[15] &= 0x7f;
}

export function denseGetRegister(buf: Uint8Array, reg: number): number {
  const bit = reg * 6;
  const byteIdx = bit >> 3;
  const fb = bit & 7;
  const b0 = buf[HLL_HDR_SIZE + byteIdx];
  const b1 = byteIdx + 1 < HLL_DENSE_SIZE - HLL_HDR_SIZE ? buf[HLL_HDR_SIZE + byteIdx + 1] : 0;
  return ((b0 >> fb) | (b1 << (8 - fb))) & 63;
}

export function denseSetRegister(buf: Uint8Array, reg: number, val: number) {
  const bit = reg * 6;
  const byteIdx = bit >> 3;
  const fb = bit & 7;
  const b0Idx = HLL_HDR_SIZE + byteIdx;
  buf[b0Idx] = (buf[b0Idx] & ~(63 << fb)) | ((val << fb) & 0xff);
  if (fb > 2) {
    const b1Idx = b0Idx + 1;
    buf[b1Idx] = (buf[b1Idx] & ~(63 >> (8 - fb))) | (val >> (8 - fb));
  }
}

export function sparseToDense(buf: Uint8Array): Uint8Array {
  if (buf[4] === HLL_DENSE) return buf.slice();
  const out = new Uint8Array(HLL_DENSE_SIZE);
  out.set(buf.subarray(0, HLL_HDR_SIZE));
  out[4] = HLL_DENSE;
  let p = HLL_HDR_SIZE;
  let idx = 0;
  while (p < buf.length) {
    const b = buf[p];
    if (isZero(b)) {
      idx += zeroLen(b);
      p++;
    } else if (isXzero(b)) {
      if (p + 1 >= buf.length) throw new RedisError(INVALID_HLL);
      idx += xzeroLen(b, buf[p + 1]);
      p += 2;
    } else {
      const val = valValue(b);
      const len = valLen(b);
      if (idx + len > HLL_REGISTERS) throw new RedisError(INVALID_HLL);
      for (let j = 0; j < len; j++) denseSetRegister(out, idx++, val);
      p++;
    }
  }
  if (idx !== HLL_REGISTERS) throw new RedisError(INVALID_HLL);
  return out;
}

function mergeSparseAdjacent(buf: Uint8Array, start: number): Uint8Array {
  let scan = start;
  let len = buf.length;
  let steps = 0;
  while (scan < len && steps < 5) {
    if (isXzero(buf[scan])) {
      scan += 2;
      steps++;
      continue;
    }
    if (isZero(buf[scan])) {
      scan++;
      steps++;
      continue;
    }
    if (scan + 1 < len && isVal(buf[scan + 1])) {
      const v1 = valValue(buf[scan]);
      const v2 = valValue(buf[scan + 1]);
      if (v1 === v2) {
        const combined = valLen(buf[scan]) + valLen(buf[scan + 1]);
        if (combined <= HLL_SPARSE_VAL_MAX_LEN) {
          buf[scan] = encodeVal(v1, combined);
          buf.copyWithin(scan + 1, scan + 2, len);
          len--;
          continue;
        }
      }
    }
    scan++;
    steps++;
  }
  return len === buf.length ? buf : buf.subarray(0, len).slice();
}

export function hllSetRegister(buf: Uint8Array, index: number, count: number): HllUpdate {
  if (buf[4] === HLL_DENSE) {
    const old = denseGetRegister(buf, index);
    if (count <= old) return { buf, updated: false };
    denseSetRegister(buf, index, count);
    invalidateCache(buf);
    return { buf, updated: true };
  }
  if (count > HLL_SPARSE_VAL_MAX_VALUE) {
    const dense = sparseToDense(buf);
    denseSetRegister(dense, index, count);
    invalidateCache(dense);
    return { buf: dense, updated: true };
  }
  let p = HLL_HDR_SIZE;
  let idx = 0;
  let prev = -1;
  let runlen = 0;
  let oplen = 0;
  while (p < buf.length) {
    const b = buf[p];
    if (isZero(b)) {
      runlen = zeroLen(b);
      oplen = 1;
    } else if (isXzero(b)) {
      if (p + 1 >= buf.length) throw new RedisError(INVALID_HLL);
      runlen = xzeroLen(b, buf[p + 1]);
      oplen = 2;
    } else {
      runlen = valLen(b);
      oplen = 1;
    }
    if (idx + runlen > index) break;
    idx += runlen;
    prev = p;
    p += oplen;
  }
  if (p >= buf.length) throw new RedisError(INVALID_HLL);
  const op = buf[p];
  if (isVal(op)) {
    const oldVal = valValue(op);
    if (oldVal >= count) return { buf, updated: false };
    if (runlen === 1) {
      buf[p] = encodeVal(count, 1);
      const merged = mergeSparseAdjacent(buf, prev !== -1 ? prev : p);
      invalidateCache(merged);
      return { buf: merged, updated: true };
    }
  } else if (isZero(op) && runlen === 1) {
    buf[p] = encodeVal(count, 1);
    const merged = mergeSparseAdjacent(buf, prev !== -1 ? prev : p);
    invalidateCache(merged);
    return { buf: merged, updated: true };
  }
  const seq: Array<number> = [];
  const first = idx;
  const last = idx + runlen - 1;
  if (isZero(op) || isXzero(op)) {
    if (index !== first) pushZeroRun(seq, index - first);
    seq.push(encodeVal(count, 1));
    if (index !== last) pushZeroRun(seq, last - index);
  } else {
    const oldVal = valValue(op);
    if (index !== first) seq.push(encodeVal(oldVal, index - first));
    seq.push(encodeVal(count, 1));
    if (index !== last) seq.push(encodeVal(oldVal, last - index));
  }
  const newLen = buf.length - oplen + seq.length;
  if (newLen > HLL_SPARSE_MAX_BYTES) {
    const dense = sparseToDense(buf);
    denseSetRegister(dense, index, count);
    invalidateCache(dense);
    return { buf: dense, updated: true };
  }
  const out = new Uint8Array(newLen);
  out.set(buf.subarray(0, p), 0);
  out.set(seq, p);
  out.set(buf.subarray(p + oplen), p + seq.length);
  const merged = mergeSparseAdjacent(out, prev !== -1 ? prev : p);
  invalidateCache(merged);
  return { buf: merged, updated: true };
}

export function hllAdd(buf: Uint8Array, ele: Uint8Array): HllUpdate {
  const [index, count] = hllPatLen(ele);
  return hllSetRegister(buf, index, count);
}

function hllTau(x: number): number {
  if (x === 0 || x === 1) return 0;
  let zPrime: number;
  let y = 1;
  let z = 1 - x;
  let cur = x;
  do {
    cur = Math.sqrt(cur);
    zPrime = z;
    y *= 0.5;
    z -= (1 - cur) * (1 - cur) * y;
  } while (zPrime !== z);
  return z / 3;
}

function hllSigma(x: number): number {
  if (x === 1) return Infinity;
  let zPrime: number;
  let y = 1;
  let z = x;
  let cur = x;
  do {
    cur *= cur;
    zPrime = z;
    z += cur * y;
    y += y;
  } while (zPrime !== z);
  return z;
}

function hllCountFromHist(hist: Int32Array): number {
  const m = HLL_REGISTERS;
  let z = m * hllTau((m - hist[HLL_Q + 1]) / m);
  for (let j = HLL_Q; j >= 1; j--) {
    z += hist[j];
    z *= 0.5;
  }
  z += m * hllSigma(hist[0] / m);
  return Math.round((HLL_ALPHA_INF * m * m) / z);
}

export function hllCount(buf: Uint8Array): number {
  const hist = new Int32Array(64);
  if (buf[4] === HLL_DENSE) {
    for (let i = 0; i < HLL_REGISTERS; i++) hist[denseGetRegister(buf, i)]++;
    return hllCountFromHist(hist);
  }
  let p = HLL_HDR_SIZE;
  let total = 0;
  while (p < buf.length) {
    const b = buf[p];
    if (isZero(b)) {
      const len = zeroLen(b);
      hist[0] += len;
      total += len;
      p++;
    } else if (isXzero(b)) {
      if (p + 1 >= buf.length) throw new RedisError(INVALID_HLL);
      const len = xzeroLen(b, buf[p + 1]);
      hist[0] += len;
      total += len;
      p += 2;
    } else {
      const len = valLen(b);
      hist[valValue(b)] += len;
      total += len;
      p++;
    }
  }
  if (total !== HLL_REGISTERS) throw new RedisError(INVALID_HLL);
  return hllCountFromHist(hist);
}

export function hllCountFromRegisters(regs: Uint8Array): number {
  const hist = new Int32Array(64);
  for (let i = 0; i < HLL_REGISTERS; i++) hist[regs[i]]++;
  return hllCountFromHist(hist);
}

export function hllMergeInto(max: Uint8Array, buf: Uint8Array) {
  if (buf[4] === HLL_DENSE) {
    for (let i = 0; i < HLL_REGISTERS; i++) {
      const val = denseGetRegister(buf, i);
      if (val > max[i]) max[i] = val;
    }
    return;
  }
  let p = HLL_HDR_SIZE;
  let idx = 0;
  while (p < buf.length) {
    const b = buf[p];
    if (isZero(b)) {
      idx += zeroLen(b);
      p++;
    } else if (isXzero(b)) {
      if (p + 1 >= buf.length) throw new RedisError(INVALID_HLL);
      idx += xzeroLen(b, buf[p + 1]);
      p += 2;
    } else {
      const val = valValue(b);
      const len = valLen(b);
      if (idx + len > HLL_REGISTERS) throw new RedisError(INVALID_HLL);
      for (let j = 0; j < len; j++) {
        if (val > max[idx]) max[idx] = val;
        idx++;
      }
      p++;
    }
  }
  if (idx !== HLL_REGISTERS) throw new RedisError(INVALID_HLL);
}

export function hllDecodeSparse(buf: Uint8Array): string {
  const parts: Array<string> = [];
  let p = HLL_HDR_SIZE;
  let idx = 0;
  while (p < buf.length) {
    const b = buf[p];
    if (isZero(b)) {
      const len = zeroLen(b);
      parts.push(`z:${len}`);
      idx += len;
      p++;
    } else if (isXzero(b)) {
      if (p + 1 >= buf.length) throw new RedisError(INVALID_HLL);
      const len = xzeroLen(b, buf[p + 1]);
      parts.push(`Z:${len}`);
      idx += len;
      p += 2;
    } else {
      const val = valValue(b);
      const len = valLen(b);
      parts.push(`v:${val},${len}`);
      idx += len;
      p++;
    }
  }
  if (idx !== HLL_REGISTERS) throw new RedisError(INVALID_HLL);
  return parts.join(" ");
}

export function hllSelfTest() {
  let hll = createSparseHll();
  const enc = new TextEncoder();
  const items = 1000;
  for (let i = 0; i < items; i++) hll = hllAdd(hll, enc.encode(`item-${i}`)).buf;
  const sparseCard = hllCount(hll);
  const dense = sparseToDense(hll);
  const denseCard = hllCount(dense);
  if (sparseCard !== denseCard) throw new RedisError("ERR HLL sparse/dense count mismatch");
  if (Math.abs(sparseCard - items) > items * 0.1) throw new RedisError("ERR HLL estimate out of range");
  for (let i = 0; i < HLL_REGISTERS; i++) {
    const v = i % 64;
    denseSetRegister(dense, i, v);
    if (denseGetRegister(dense, i) !== v) throw new RedisError("ERR HLL dense register self-test failed");
  }
}
