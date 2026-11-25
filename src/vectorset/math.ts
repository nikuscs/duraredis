import { text } from "../resp/reply";

export const QUANT = { q8: 0, noquant: 1, bin: 2 } as const;
export type QuantType = (typeof QUANT)[keyof typeof QUANT];
export const QUANT_NAME: Record<QuantType, string> = { 0: "int8", 1: "f32", 2: "bin" };

export interface NormalizedVector {
  normalized: Float32Array;
  norm: number;
}

export interface EncodedVector {
  vec: Uint8Array;
  f32?: Float32Array;
  i8?: Int8Array;
  u32?: Uint32Array;
  norm: number;
  quantRange: number;
}

const f32 = Math.fround;
const INV_127_SQ = f32(1 / 16_129);
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const HEX_FLOAT_RE = /^([+-]?)0x([0-9a-f]+(?:\.[0-9a-f]*)?|\.[0-9a-f]+)(?:p([+-]?\d+))?$/i;

export function toQuant(n: number): QuantType {
  if (n === QUANT.q8 || n === QUANT.noquant || n === QUANT.bin) return n;
  throw new Error(`duraredis: unknown vectorset quant ${n}`);
}

export function popcount32(x: number): number {
  let n = x - ((x >>> 1) & 0x55_55_55_55);
  n = (n & 0x33_33_33_33) + ((n >>> 2) & 0x33_33_33_33);
  return Math.imul((n + (n >>> 4)) & 0x0f_0f_0f_0f, 0x01_01_01_01) >>> 24;
}

function parseHexFloat(s: string): number | undefined {
  const m = HEX_FLOAT_RE.exec(s);
  if (!m) return undefined;
  const [, sign, body, expStr] = m;
  const [whole = "", frac = ""] = body.split(".");
  let mantissa = 0;
  for (let i = 0; i < whole.length; i++) mantissa = mantissa * 16 + Number.parseInt(whole[i], 16);
  let scale = 1 / 16;
  for (let i = 0; i < frac.length; i++) {
    mantissa += Number.parseInt(frac[i], 16) * scale;
    scale /= 16;
  }
  const exp = expStr ? Number(expStr) : 0;
  const val = mantissa * 2 ** exp;
  return f32(sign === "-" ? -val : val);
}

export function parseVectorFloat(b: Uint8Array): number | undefined {
  const s = text(b);
  if (!s.length || s !== s.trim()) return undefined;
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (DECIMAL_RE.test(s)) {
    const n = f32(Number(s));
    return Number.isNaN(n) ? undefined : n;
  }
  return parseHexFloat(s);
}

export function parseFp32Blob(b: Uint8Array): Float32Array | undefined {
  if (b.byteLength === 0 || b.byteLength % 4 !== 0) return undefined;
  const dim = b.byteLength >>> 2;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

export function projectVector(input: Float32Array, outDim: number): Float32Array {
  const inDim = input.length;
  const scale = f32(1 / Math.sqrt(inDim));
  const out = new Float32Array(outDim);
  for (let row = 0; row < outDim; row++) {
    let sum = 0;
    for (let col = 0; col < inDim; col++) {
      sum = f32(sum + ((popcount32(row & col) & 1) !== 0 ? -input[col] : input[col]));
    }
    out[row] = f32(sum * scale);
  }
  return out;
}

export function normalizeVector(v: Float32Array, preciseDiv = false): NormalizedVector {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq = f32(sumSq + f32(v[i] * v[i]));
  const norm64 = Math.sqrt(sumSq);
  const norm = f32(norm64);
  if (norm === 0) return { normalized: new Float32Array(v.length), norm: 1 };
  const div = preciseDiv ? norm64 : norm;
  const normalized = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) normalized[i] = f32(v[i] / div);
  return { normalized, norm };
}

function readF32View(vec: Uint8Array, dim: number): Float32Array {
  const dv = new DataView(vec.buffer, vec.byteOffset, vec.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

function readU32View(vec: Uint8Array): Uint32Array {
  const n = vec.byteLength >>> 2;
  const dv = new DataView(vec.buffer, vec.byteOffset, vec.byteLength);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

export function encodeVector(raw: Float32Array, quant: QuantType, preciseDiv = false): EncodedVector {
  const dim = raw.length;
  const { normalized, norm } = normalizeVector(raw, preciseDiv);
  if (quant === QUANT.noquant) {
    const vec = new Uint8Array(dim * 4);
    const dv = new DataView(vec.buffer);
    for (let i = 0; i < dim; i++) dv.setFloat32(i * 4, normalized[i], true);
    return { vec, f32: normalized, norm, quantRange: 0 };
  }
  if (quant === QUANT.q8) {
    let range = 0;
    for (let i = 0; i < dim; i++) {
      const a = Math.abs(normalized[i]);
      if (a > range) range = a;
    }
    const i8 = new Int8Array(dim);
    if (range > 0) {
      for (let i = 0; i < dim; i++) {
        const scaled = f32(f32(normalized[i] / range) * 127);
        const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
        i8[i] = Math.max(-127, Math.min(127, rounded));
      }
    }
    const vec = new Uint8Array(i8.buffer, i8.byteOffset, i8.byteLength);
    return { vec, i8, norm, quantRange: range };
  }
  const words = Math.ceil(dim / 64);
  const vec = new Uint8Array(words * 8);
  for (let i = 0; i < dim; i++) {
    if (normalized[i] > 0) vec[i >>> 3] |= 1 << (i & 7);
  }
  return { vec, u32: readU32View(vec), norm, quantRange: 0 };
}

export function hydrateVector(vec: Uint8Array, quant: QuantType, dim: number, norm: number, quantRange: number): EncodedVector {
  if (quant === QUANT.noquant) return { vec, f32: readF32View(vec, dim), norm, quantRange };
  if (quant === QUANT.q8) return { vec, i8: new Int8Array(vec.buffer, vec.byteOffset, dim), norm, quantRange };
  return { vec, u32: readU32View(vec), norm, quantRange };
}

export function decodeVector(vec: Uint8Array, quant: QuantType, dim: number, norm: number, quantRange: number): Float32Array {
  const out = new Float32Array(dim);
  if (quant === QUANT.noquant) {
    const f = readF32View(vec, dim);
    for (let i = 0; i < dim; i++) out[i] = f32(f[i] * norm);
    return out;
  }
  if (quant === QUANT.q8) {
    const q = new Int8Array(vec.buffer, vec.byteOffset, dim);
    for (let i = 0; i < dim; i++) out[i] = f32(f32(f32(q[i] * quantRange) / 127) * norm);
    return out;
  }
  for (let i = 0; i < dim; i++) {
    out[i] = (vec[i >>> 3] & (1 << (i & 7))) !== 0 ? 1 : -1;
  }
  return out;
}

export function distance(quant: QuantType, dim: number, a: EncodedVector, b: EncodedVector): number {
  if (quant === QUANT.noquant) {
    const af = a.f32;
    const bf = b.f32;
    if (!af || !bf) return 1;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += af[i] * bf[i];
    return f32((1 - f32(dot)) / 2);
  }
  if (quant === QUANT.q8) {
    const ai = a.i8;
    const bi = b.i8;
    if (!ai || !bi) return 1;
    let dotInt = 0;
    for (let i = 0; i < dim; i++) dotInt += ai[i] * bi[i];
    const scale = f32(f32(a.quantRange * b.quantRange) * INV_127_SQ);
    const dot = dotInt * scale;
    if (dot >= 1) return 0;
    if (dot <= -1) return 1;
    return f32((1 - dot) / 2);
  }
  const au = a.u32;
  const bu = b.u32;
  if (!au || !bu) return 1;
  let h = 0;
  for (let i = 0; i < au.length; i++) h += popcount32(au[i] ^ bu[i]);
  return f32(h / dim);
}

export const vsimScore = (dist: number): number => 1 - dist;

export const vlinkScore = (dist: number): number => f32(1 - dist);
