import { toFloat, toInt64 } from "../../commands/args";
import { bytes } from "../../resp/reply";

export const RDB_DUMP_VERSION = 17;

export const RDB_TYPE = {
  string: 0,
  list: 1,
  set: 2,
  zset: 3,
  hash: 4,
  zset2: 5,
  modulePreGa: 6,
  module2: 7,
  hashZipmap: 9,
  listZiplist: 10,
  setIntset: 11,
  zsetZiplist: 12,
  hashZiplist: 13,
  listQuicklist: 14,
  streamListpacks: 15,
  hashListpack: 16,
  zsetListpack: 17,
  listQuicklist2: 18,
  streamListpacks2: 19,
  setListpack: 20,
  streamListpacks3: 21,
  hashMetadataPreGa: 22,
  hashListpackExPreGa: 23,
  hashMetadata: 24,
  hashListpackEx: 25,
  streamListpacks4: 27,
  setListpackEx: 34,
  setMetadata: 35,
} as const;

export const RDB_ENCVAL = 3;
export const RDB_ENC_INT8 = 0;
export const RDB_ENC_INT16 = 1;
export const RDB_ENC_INT32 = 2;
export const RDB_ENC_LZF = 3;
export const QUICKLIST_PLAIN = 1;
export const QUICKLIST_PACKED = 2;
export const UINT64_MAX = (1n << 64n) - 1n;

const LZF_MIN_LENGTH = 20;
const MAX_LZF_OUT = 64 * 1024 * 1024;
const HLOG = 16;
const HSIZE = 1 << HLOG;
const MAX_LIT = 1 << 5;
const MAX_OFF = 1 << 13;
const MAX_REF = (1 << 8) + (1 << 3);

export class RdbFormatError extends Error {}

function reflectBits(val: bigint, bits: number): bigint {
  let out = 0n;
  for (let i = 0; i < bits; i++) {
    if (((val >> BigInt(i)) & 1n) !== 0n) out |= 1n << BigInt(bits - 1 - i);
  }
  return out;
}

const CRC64_POLY_REFLECTED = reflectBits(BigInt("0xad93d23594c935a9"), 64);

const CRC64_TABLE = (() => {
  const table = new BigUint64Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i);
    for (let j = 0; j < 8; j++) {
      if ((crc & 1n) !== 0n) crc = (crc >> 1n) ^ CRC64_POLY_REFLECTED;
      else crc >>= 1n;
    }
    table[i] = crc;
  }
  return table;
})();

export function crc64(data: Uint8Array): bigint {
  let crc = 0n;
  for (const byte of data) {
    crc = CRC64_TABLE[Number((crc ^ BigInt(byte)) & 0xffn)] ^ (crc >> 8n);
  }
  return crc;
}

const lzfFirst = (data: Uint8Array, p: number) => (data[p] << 8) | data[p + 1];
const lzfNext = (v: number, data: Uint8Array, p: number) => ((v << 8) | data[p + 2]) >>> 0;
const lzfIndex = (h: number) => (((h >>> (3 * 8 - HLOG)) - Math.imul(h, 5)) >>> 0) & (HSIZE - 1);

export function lzfCompress(input: Uint8Array, outLen: number): Uint8Array | undefined {
  if (!input.length || !outLen) return undefined;
  const table = new Int32Array(HSIZE);
  const out = new Uint8Array(outLen);
  const end = input.length;
  let ip = 0;
  let op = 1;
  let lit = 0;
  let hval = lzfFirst(input, ip);
  const emitLiteral = (): boolean => {
    if (op >= outLen) return false;
    lit++;
    out[op++] = input[ip++];
    if (lit !== MAX_LIT) return true;
    out[op - lit - 1] = lit - 1;
    lit = 0;
    op++;
    return true;
  };
  while (ip < end - 2) {
    hval = lzfNext(hval, input, ip);
    const slot = lzfIndex(hval);
    const ref = table[slot];
    table[slot] = ip;
    const off = ip - ref - 1;
    const matches = off < MAX_OFF && ref > 0 && input[ref + 2] === input[ip + 2] && input[ref] === input[ip] && input[ref + 1] === input[ip + 1];
    if (!matches) {
      if (!emitLiteral()) return undefined;
      continue;
    }
    let len = 2;
    const maxlen = Math.min(end - ip - len, MAX_REF);
    if (op + 3 + 1 >= outLen && op - (lit ? 0 : 1) + 3 + 1 >= outLen) return undefined;
    out[op - lit - 1] = lit - 1;
    if (!lit) op--;
    let done = false;
    if (maxlen > 16) {
      for (let k = 0; k < 16; k++) {
        len++;
        if (input[ref + len] !== input[ip + len]) {
          done = true;
          break;
        }
      }
    }
    if (!done) {
      do len++; while (len < maxlen && input[ref + len] === input[ip + len]);
    }
    len -= 2;
    ip++;
    if (len < 7) {
      out[op++] = (off >> 8) + (len << 5);
    } else {
      out[op++] = (off >> 8) + (7 << 5);
      out[op++] = len - 7;
    }
    out[op++] = off & 0xff;
    lit = 0;
    op++;
    ip += len + 1;
    if (ip >= end - 2) break;
    ip -= 2;
    hval = lzfFirst(input, ip);
    hval = lzfNext(hval, input, ip);
    table[lzfIndex(hval)] = ip;
    ip++;
    hval = lzfNext(hval, input, ip);
    table[lzfIndex(hval)] = ip;
    ip++;
  }
  if (op + 3 > outLen) return undefined;
  while (ip < end) if (!emitLiteral()) return undefined;
  out[op - lit - 1] = lit - 1;
  if (!lit) op--;
  return out.slice(0, op);
}

export function lzfDecompress(input: Uint8Array, outLen: number): Uint8Array | null {
  if (outLen < 0 || outLen > MAX_LZF_OUT) return null;
  const out = new Uint8Array(outLen);
  let ip = 0;
  let op = 0;
  while (ip < input.length) {
    let ctrl = input[ip++];
    if (ctrl < 32) {
      ctrl++;
      if (op + ctrl > outLen || ip + ctrl > input.length) return null;
      out.set(input.subarray(ip, ip + ctrl), op);
      ip += ctrl;
      op += ctrl;
    } else {
      let len = ctrl >> 5;
      let ref = op - ((ctrl & 0x1f) << 8) - 1;
      if (ip >= input.length) return null;
      if (len === 7) {
        len += input[ip++];
        if (ip >= input.length) return null;
      }
      ref -= input[ip++];
      if (op + len + 2 > outLen || ref < 0) return null;
      for (let i = 0; i < len + 2; i++) {
        out[op] = out[ref];
        op++;
        ref++;
      }
    }
  }
  return op === outLen ? out : null;
}

function toInt32(data: Uint8Array): number | undefined {
  if (data.length === 0 || data.length > 11) return undefined;
  const n = toInt64(data);
  if (n === undefined || n < -2_147_483_648n || n > 2_147_483_647n) return undefined;
  return Number(n);
}

export class RdbWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  private ensure(extra: number) {
    const needed = this.pos + extra;
    if (needed <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < needed) nextCap *= 2;
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u16le(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  i16le(v: number) {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  u32le(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  i32le(v: number) {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  u32be(v: number) {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, false);
    this.pos += 4;
  }

  i64le(v: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }

  u64le(v: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, true);
    this.pos += 8;
  }

  u64be(v: bigint) {
    this.ensure(8);
    this.view.setBigUint64(this.pos, v, false);
    this.pos += 8;
  }

  f64le(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  raw(b: Uint8Array) {
    if (!b.length) return;
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }

  patchU32le(offset: number, v: number) {
    this.view.setUint32(offset, v >>> 0, true);
  }

  len(n: number | bigint) {
    const v = BigInt.asUintN(64, typeof n === "bigint" ? n : BigInt(n));
    if (v < 64n) {
      this.u8(Number(v));
      return;
    }
    if (v < 16_384n) {
      this.u8(0x40 | Number(v >> 8n));
      this.u8(Number(v & 0xffn));
      return;
    }
    if (v <= 4_294_967_295n) {
      this.u8(0x80);
      this.u32be(Number(v));
      return;
    }
    this.u8(0x81);
    this.u64be(v);
  }

  rawString(data: Uint8Array, tryInt = true) {
    if (tryInt) {
      const iv = toInt32(data);
      if (iv !== undefined) {
        if (iv >= -128 && iv <= 127) {
          this.u8((RDB_ENCVAL << 6) | RDB_ENC_INT8);
          this.u8(iv & 0xff);
          return;
        }
        if (iv >= -32_768 && iv <= 32_767) {
          this.u8((RDB_ENCVAL << 6) | RDB_ENC_INT16);
          this.i16le(iv);
          return;
        }
        this.u8((RDB_ENCVAL << 6) | RDB_ENC_INT32);
        this.i32le(iv);
        return;
      }
    }
    const compressed = data.length > LZF_MIN_LENGTH ? lzfCompress(data, data.length - 4) : undefined;
    if (compressed) {
      this.u8((RDB_ENCVAL << 6) | RDB_ENC_LZF);
      this.len(compressed.length);
      this.len(data.length);
      this.raw(compressed);
      return;
    }
    this.len(data.length);
    this.raw(data);
  }

  blobString(data: Uint8Array) {
    this.rawString(data, false);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  finishDump(version = RDB_DUMP_VERSION): Uint8Array {
    this.u16le(version);
    const sum = crc64(this.buf.subarray(0, this.pos));
    this.u64le(sum);
    return this.bytes();
  }
}

export interface RdbLen {
  encoded: boolean;
  value: bigint;
}

export class RdbReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(
    private readonly buf: Uint8Array,
    private readonly end = buf.length,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get eof(): boolean {
    return this.pos >= this.end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number) {
    if (n < 0 || this.pos + n > this.end) throw new RdbFormatError("unexpected EOF");
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16le(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  i16le(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32le(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32le(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32be(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  i64le(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  u64be(): bigint {
    this.need(8);
    const v = this.view.getBigUint64(this.pos, false);
    this.pos += 8;
    return v;
  }

  f64le(): number {
    this.need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  slice(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  private viewSlice(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  len(): RdbLen {
    const first = this.u8();
    const kind = (first & 0xc0) >> 6;
    if (kind === RDB_ENCVAL) return { encoded: true, value: BigInt(first & 0x3f) };
    if (kind === 0) return { encoded: false, value: BigInt(first & 0x3f) };
    if (kind === 1) return { encoded: false, value: BigInt(((first & 0x3f) << 8) | this.u8()) };
    if (first === 0x80) return { encoded: false, value: BigInt(this.u32be()) };
    if (first === 0x81) return { encoded: false, value: this.u64be() };
    throw new RdbFormatError("invalid RDB length encoding");
  }

  lenBig(): bigint {
    const res = this.len();
    if (res.encoded) throw new RdbFormatError("unexpected encoded length");
    return res.value;
  }

  lenNum(): number {
    const v = this.lenBig();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RdbFormatError("length overflow");
    return Number(v);
  }

  string(): Uint8Array {
    const res = this.len();
    if (!res.encoded) {
      if (res.value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RdbFormatError("string length overflow");
      return this.slice(Number(res.value));
    }
    switch (Number(res.value)) {
      case RDB_ENC_INT8: {
        const v = (this.u8() << 24) >> 24;
        return bytes(String(v));
      }
      case RDB_ENC_INT16:
        return bytes(String(this.i16le()));
      case RDB_ENC_INT32:
        return bytes(String(this.i32le()));
      case RDB_ENC_LZF: {
        const clen = this.lenNum();
        const ulen = this.lenNum();
        const compressed = this.viewSlice(clen);
        const out = lzfDecompress(compressed, ulen);
        if (!out) throw new RdbFormatError("LZF decompression failed");
        return out;
      }
      default:
        throw new RdbFormatError("invalid RDB string encoding");
    }
  }

  legacyDouble(): number {
    const n = this.u8();
    if (n === 255) return -Infinity;
    if (n === 254) return Infinity;
    if (n === 253) return Number.NaN;
    const raw = this.viewSlice(n);
    const parsed = toFloat(raw);
    if (parsed === undefined) throw new RdbFormatError("invalid legacy double");
    return parsed;
  }
}

export function verifyDumpPayload(payload: Uint8Array): { reader: RdbReader; version: number } | null {
  if (payload.length < 10) return null;
  const footerPos = payload.length - 10;
  const version = payload[footerPos] | (payload[footerPos + 1] << 8);
  if (version > RDB_DUMP_VERSION) return null;
  let storedCrc = 0n;
  for (let i = 7; i >= 0; i--) storedCrc = (storedCrc << 8n) | BigInt(payload[footerPos + 2 + i]);
  if (crc64(payload.subarray(0, footerPos + 2)) !== storedCrc) return null;
  return { reader: new RdbReader(payload, footerPos), version };
}
