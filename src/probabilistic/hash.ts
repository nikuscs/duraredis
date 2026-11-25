import { opt, toFloat } from "../commands/args";
import { RedisError, text } from "../resp/reply";

export const MASK64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;
export const UINT64_MAX = MASK64;

export function wrongArity(cmd: Uint8Array): RedisError {
  return new RedisError(`ERR wrong number of arguments for '${text(cmd).toLowerCase()}' command`);
}

export function argIndex(needle: string, args: Array<Uint8Array>, start = 0): number {
  const upper = needle.toUpperCase();
  for (let i = start; i < args.length; i++) if (opt(args[i]) === upper) return i;
  return -1;
}

export function parseDoubleStrict(b: Uint8Array): number | undefined {
  const n = toFloat(b);
  if (n === undefined) return undefined;
  const s = text(b);
  if (/^[+-]?inf(inity)?$/i.test(s)) return n;
  return Number.isFinite(n) ? n : undefined;
}

export function formatPrintfG(n: number): string {
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  if (!Number.isFinite(n)) return String(n).toLowerCase();
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const [mant, expStr] = abs.toExponential(5).split("e");
  const exp = Number(expStr);
  if (exp < -4 || exp >= 6) {
    const trimmed = mant.replace(/\.?0+$/, "");
    const expSign = exp < 0 ? "-" : "+";
    return `${sign}${trimmed}e${expSign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return `${sign}${Number(abs.toPrecision(6))}`;
}

export function murmurHash2(data: Uint8Array, seed: number): number {
  const m = 0x5b_d1_e9_95;
  const len = data.length;
  let h = (seed ^ len) >>> 0;
  const n4 = len & ~3;
  for (let i = 0; i < n4; i += 4) {
    let k = (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    k = (k ^ (k >>> 24)) >>> 0;
    k = Math.imul(k, m) >>> 0;
    h = Math.imul(h, m) >>> 0;
    h = (h ^ k) >>> 0;
  }
  const rem = len & 3;
  if (rem === 3) h = (h ^ (data[n4 + 2] << 16)) >>> 0;
  if (rem >= 2) h = (h ^ (data[n4 + 1] << 8)) >>> 0;
  if (rem >= 1) {
    h = (h ^ data[n4]) >>> 0;
    h = Math.imul(h, m) >>> 0;
  }
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, m) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}

export function murmurHash64A(data: Uint8Array, seed: bigint): bigint {
  const m = 0xc6_a4_a7_93_5b_d1_e9_95n;
  const r = 47n;
  const len = data.length;
  let h = (seed ^ ((BigInt(len) * m) & MASK64)) & MASK64;
  const view = new DataView(data.buffer, data.byteOffset, len);
  const n8 = len & ~7;
  for (let i = 0; i < n8; i += 8) {
    let k = view.getBigUint64(i, true);
    k = (k * m) & MASK64;
    k = (k ^ (k >> r)) & MASK64;
    k = (k * m) & MASK64;
    h = (h ^ k) & MASK64;
    h = (h * m) & MASK64;
  }
  const rem = len & 7;
  if (rem > 0) {
    for (let j = rem - 1; j >= 0; j--) h = (h ^ (BigInt(data[n8 + j]) << BigInt(j * 8))) & MASK64;
    h = (h * m) & MASK64;
  }
  h = (h ^ (h >> r)) & MASK64;
  h = (h * m) & MASK64;
  h = (h ^ (h >> r)) & MASK64;
  return h;
}
