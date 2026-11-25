const MASK = (1n << 64n) - 1n;
const PRIME32_1 = 0x9e_37_79_b1n;
const PRIME32_2 = 0x85_eb_ca_77n;
const PRIME32_3 = 0xc2_b2_ae_3dn;
const PRIME64_1 = 0x9e_37_79_b1_85_eb_ca_87n;
const PRIME64_2 = 0xc2_b2_ae_3d_27_d4_eb_4fn;
const PRIME64_3 = 0x16_56_67_b1_9e_37_79_f9n;
const PRIME64_4 = 0x85_eb_ca_77_c2_b2_ae_63n;
const PRIME64_5 = 0x27_d4_eb_2f_16_56_67_c5n;
const PRIME_MX1 = 0x16_56_67_91_9e_37_79_f9n;
const PRIME_MX2 = 0x9f_b2_1c_65_1e_98_df_25n;
const STRIPE = 64;
const SECRET = Uint8Array.from([
  0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c,
  0xde, 0xd4, 0x6d, 0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f,
  0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0, 0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21,
  0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0, 0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c,
  0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b, 0x1b, 0x53, 0x2e, 0xa3,
  0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac, 0xd8,
  0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d,
  0x8a, 0x51, 0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64,
  0xea, 0xc5, 0xac, 0x83, 0x34, 0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb,
  0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49, 0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e,
  0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8, 0xd1, 0x7a, 0xd0, 0x31, 0xce,
  0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b, 0x40, 0x7e,
]);

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const secret = view(SECRET);
const s64 = (i: number) => secret.getBigUint64(i, true);
const s32 = (i: number) => BigInt(secret.getUint32(i, true));
const mul = (a: bigint, b: bigint) => (a * b) & MASK;
const add = (a: bigint, b: bigint) => (a + b) & MASK;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & MASK;
const swap32 = (x: bigint) => ((x & 0xffn) << 24n) | ((x & 0xff_00n) << 8n) | ((x >> 8n) & 0xff_00n) | ((x >> 24n) & 0xffn);
const swap64 = (x: bigint) => (swap32(x & 0xff_ff_ff_ffn) << 32n) | swap32(x >> 32n);
const fold = (a: bigint, b: bigint) => {
  const p = a * b;
  return (p & MASK) ^ (p >> 64n);
};

function avalanche(h: bigint): bigint {
  const a = h ^ (h >> 37n);
  const b = mul(a, PRIME_MX1);
  return b ^ (b >> 32n);
}

function avalanche64(h: bigint): bigint {
  let x = h ^ (h >> 33n);
  x = mul(x, PRIME64_2);
  x ^= x >> 29n;
  x = mul(x, PRIME64_3);
  return x ^ (x >> 32n);
}

function rrmxmx(h: bigint, len: number): bigint {
  let x = h ^ rotl(h, 49n) ^ rotl(h, 24n);
  x = mul(x, PRIME_MX2);
  x ^= (x >> 35n) + BigInt(len);
  x = mul(x, PRIME_MX2);
  return x ^ (x >> 28n);
}

function mix16(input: DataView, at: number, secretAt: number): bigint {
  return fold(input.getBigUint64(at, true) ^ s64(secretAt), input.getBigUint64(at + 8, true) ^ s64(secretAt + 8));
}

function short(data: Uint8Array, input: DataView): bigint {
  const len = data.length;
  if (len === 0) return avalanche64(s64(56) ^ s64(64));
  if (len <= 3) {
    const combined = (BigInt(data[0]) << 16n) | (BigInt(data[len >> 1]) << 24n) | BigInt(data[len - 1]) | (BigInt(len) << 8n);
    return avalanche64(combined ^ (s32(0) ^ s32(4)));
  }
  if (len <= 8) {
    const value = add(BigInt(input.getUint32(len - 4, true)), BigInt(input.getUint32(0, true)) << 32n);
    return rrmxmx(value ^ (s64(8) ^ s64(16)), len);
  }
  const lo = input.getBigUint64(0, true) ^ (s64(24) ^ s64(32));
  const hi = input.getBigUint64(len - 8, true) ^ (s64(40) ^ s64(48));
  return avalanche(add(add(add(BigInt(len), swap64(lo)), hi), fold(lo, hi)));
}

function medium(len: number, input: DataView): bigint {
  let acc = mul(BigInt(len), PRIME64_1);
  const pairs: Array<[number, number]> = [[0, 0], [len - 16, 16]];
  if (len > 32) pairs.push([16, 32], [len - 32, 48]);
  if (len > 64) pairs.push([32, 64], [len - 48, 80]);
  if (len > 96) pairs.push([48, 96], [len - 64, 112]);
  for (const [at, s] of pairs) acc = add(acc, mix16(input, at, s));
  return avalanche(acc);
}

function midsize(len: number, input: DataView): bigint {
  let acc = mul(BigInt(len), PRIME64_1);
  const rounds = Math.floor(len / 16);
  for (let i = 0; i < 8; i++) acc = add(acc, mix16(input, 16 * i, 16 * i));
  acc = avalanche(acc);
  for (let i = 8; i < rounds; i++) acc = add(acc, mix16(input, 16 * i, 16 * (i - 8) + 3));
  return avalanche(add(acc, mix16(input, len - 16, 119)));
}

function accumulateStripe(acc: Array<bigint>, input: DataView, at: number, secretAt: number) {
  for (let i = 0; i < 8; i++) {
    const value = input.getBigUint64(at + 8 * i, true);
    const key = value ^ s64(secretAt + 8 * i);
    acc[i ^ 1] = add(acc[i ^ 1], value);
    acc[i] = add(acc[i], (key & 0xff_ff_ff_ffn) * (key >> 32n));
  }
}

function scramble(acc: Array<bigint>) {
  for (let i = 0; i < 8; i++) {
    const x = acc[i] ^ (acc[i] >> 47n) ^ s64(SECRET.length - STRIPE + 8 * i);
    acc[i] = mul(x, PRIME32_1);
  }
}

function long(len: number, input: DataView): bigint {
  const acc = [PRIME32_3, PRIME64_1, PRIME64_2, PRIME64_3, PRIME64_4, PRIME32_2, PRIME64_5, PRIME32_1];
  const stripesPerBlock = (SECRET.length - STRIPE) / 8;
  const blockLen = STRIPE * stripesPerBlock;
  const blocks = Math.floor((len - 1) / blockLen);
  for (let n = 0; n < blocks; n++) {
    for (let s = 0; s < stripesPerBlock; s++) accumulateStripe(acc, input, n * blockLen + s * STRIPE, s * 8);
    scramble(acc);
  }
  const stripes = Math.floor((len - 1 - blockLen * blocks) / STRIPE);
  for (let s = 0; s < stripes; s++) accumulateStripe(acc, input, blocks * blockLen + s * STRIPE, s * 8);
  accumulateStripe(acc, input, len - STRIPE, SECRET.length - STRIPE - 7);
  let result = mul(BigInt(len), PRIME64_1);
  for (let i = 0; i < 4; i++) result = add(result, fold(acc[2 * i] ^ s64(11 + 16 * i), acc[2 * i + 1] ^ s64(11 + 16 * i + 8)));
  return avalanche(result);
}

export function xxh3(data: Uint8Array): bigint {
  const input = view(data);
  if (data.length <= 16) return short(data, input);
  if (data.length <= 128) return medium(data.length, input);
  if (data.length <= 240) return midsize(data.length, input);
  return long(data.length, input);
}

export const xxh3Hex = (data: Uint8Array) => xxh3(data).toString(16).padStart(16, "0");
