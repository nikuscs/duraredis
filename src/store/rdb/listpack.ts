import { toInt64 } from "../../commands/args";
import { bytes } from "../../resp/reply";
import { RdbFormatError, RdbWriter } from "./codec";

export interface ListpackItem {
  bytes: Uint8Array;
  int?: bigint;
}

const LP_HDR_SIZE = 6;
const LP_EOF = 0xff;
const LP_INT7_MAX = 127n;
const LP_INT13_MIN = -4096n;
const LP_INT13_MAX = 4095n;
const LP_INT16_MIN = -32_768n;
const LP_INT16_MAX = 32_767n;
const LP_INT24_MIN = -8_388_608n;
const LP_INT24_MAX = 8_388_607n;
const LP_INT32_MIN = -2_147_483_648n;
const LP_INT32_MAX = 2_147_483_647n;

export function backlenBytes(elen: number): number {
  if (elen <= 127) return 1;
  if (elen < 16_383) return 2;
  if (elen < 2_097_151) return 3;
  if (elen < 268_435_455) return 4;
  return 5;
}

function intSize(v: bigint): number {
  if (v >= 0n && v <= LP_INT7_MAX) return 1;
  if (v >= LP_INT13_MIN && v <= LP_INT13_MAX) return 2;
  if (v >= LP_INT16_MIN && v <= LP_INT16_MAX) return 3;
  if (v >= LP_INT24_MIN && v <= LP_INT24_MAX) return 4;
  if (v >= LP_INT32_MIN && v <= LP_INT32_MAX) return 5;
  return 9;
}

function strSize(len: number): number {
  if (len < 64) return 1 + len;
  if (len < 4096) return 2 + len;
  return 5 + len;
}

function asInt64(item: Uint8Array): bigint | undefined {
  if (item.length === 0 || item.length > 20) return undefined;
  return toInt64(item);
}

export function listpackEntrySize(item: Uint8Array | bigint): number {
  let elen: number;
  if (typeof item === "bigint") {
    elen = intSize(item);
  } else {
    const iv = asInt64(item);
    elen = iv !== undefined ? intSize(iv) : strSize(item.length);
  }
  return elen + backlenBytes(elen);
}

function writeBacklen(w: RdbWriter, elen: number) {
  if (elen <= 127) {
    w.u8(elen);
    return;
  }
  if (elen < 16_383) {
    w.u8(elen >> 7);
    w.u8((elen & 127) | 128);
    return;
  }
  if (elen < 2_097_151) {
    w.u8(elen >> 14);
    w.u8(((elen >> 7) & 127) | 128);
    w.u8((elen & 127) | 128);
    return;
  }
  if (elen < 268_435_455) {
    w.u8(elen >> 21);
    w.u8(((elen >> 14) & 127) | 128);
    w.u8(((elen >> 7) & 127) | 128);
    w.u8((elen & 127) | 128);
    return;
  }
  w.u8(Math.floor(elen / 268_435_456));
  w.u8(((elen >> 21) & 127) | 128);
  w.u8(((elen >> 14) & 127) | 128);
  w.u8(((elen >> 7) & 127) | 128);
  w.u8((elen & 127) | 128);
}

function writeInt(w: RdbWriter, v: bigint): number {
  if (v >= 0n && v <= LP_INT7_MAX) {
    w.u8(Number(v));
    return 1;
  }
  if (v >= LP_INT13_MIN && v <= LP_INT13_MAX) {
    const u = Number(v < 0n ? v + 8192n : v);
    w.u8(0xc0 | (u >> 8));
    w.u8(u & 0xff);
    return 2;
  }
  if (v >= LP_INT16_MIN && v <= LP_INT16_MAX) {
    w.u8(0xf1);
    w.i16le(Number(v));
    return 3;
  }
  if (v >= LP_INT24_MIN && v <= LP_INT24_MAX) {
    const u = Number(v < 0n ? v + 16_777_216n : v);
    w.u8(0xf2);
    w.u8(u & 0xff);
    w.u8((u >> 8) & 0xff);
    w.u8((u >> 16) & 0xff);
    return 4;
  }
  if (v >= LP_INT32_MIN && v <= LP_INT32_MAX) {
    w.u8(0xf3);
    w.i32le(Number(v));
    return 5;
  }
  w.u8(0xf4);
  w.i64le(v);
  return 9;
}

function writeStr(w: RdbWriter, s: Uint8Array): number {
  if (s.length < 64) {
    w.u8(0x80 | s.length);
    w.raw(s);
    return 1 + s.length;
  }
  if (s.length < 4096) {
    w.u8(0xe0 | (s.length >> 8));
    w.u8(s.length & 0xff);
    w.raw(s);
    return 2 + s.length;
  }
  w.u8(0xf0);
  w.u32le(s.length);
  w.raw(s);
  return 5 + s.length;
}

export function encodeListpack(items: Array<Uint8Array | bigint>): Uint8Array {
  const w = new RdbWriter(Math.max(32, items.length * 8 + LP_HDR_SIZE + 1));
  w.u32le(0);
  w.u16le(items.length >= 65_535 ? 65_535 : items.length);
  for (const item of items) {
    let elen: number;
    if (typeof item === "bigint") {
      elen = writeInt(w, item);
    } else {
      const iv = asInt64(item);
      elen = iv !== undefined ? writeInt(w, iv) : writeStr(w, item);
    }
    writeBacklen(w, elen);
  }
  w.u8(LP_EOF);
  w.patchU32le(0, w.length);
  return w.bytes();
}

function verifyBacklen(buf: Uint8Array, pos: number, end: number, expected: number): number {
  const size = backlenBytes(expected);
  if (pos + size > end) throw new RdbFormatError("truncated listpack backlen");
  if ((buf[pos] & 0x80) !== 0) throw new RdbFormatError("invalid listpack backlen");
  let decoded = 0;
  let shift = 0;
  for (let i = size - 1; i >= 0; i--) {
    const b = buf[pos + i];
    if (i > 0 && (b & 0x80) === 0) throw new RdbFormatError("invalid listpack backlen continuation");
    decoded += (b & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (decoded !== expected) throw new RdbFormatError("mismatched listpack backlen");
  return pos + size;
}

interface ReadEntryResult {
  item: ListpackItem;
  next: number;
}

function readEntry(buf: Uint8Array, view: DataView, pos: number, end: number): ReadEntryResult {
  const b = buf[pos];
  let elen: number;
  let intVal: bigint | undefined;
  let strBytes: Uint8Array | undefined;
  if ((b & 0x80) === 0) {
    elen = 1;
    intVal = BigInt(b);
  } else if ((b & 0xc0) === 0x80) {
    const len = b & 0x3f;
    elen = 1 + len;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack string");
    strBytes = buf.slice(pos + 1, pos + elen);
  } else if ((b & 0xe0) === 0xc0) {
    elen = 2;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack int13");
    const raw = ((b & 0x1f) << 8) | buf[pos + 1];
    intVal = BigInt(raw >= 4096 ? raw - 8192 : raw);
  } else if ((b & 0xf0) === 0xe0) {
    if (pos + 2 > end) throw new RdbFormatError("truncated listpack str12");
    const len = ((b & 0x0f) << 8) | buf[pos + 1];
    elen = 2 + len;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack str12 body");
    strBytes = buf.slice(pos + 2, pos + elen);
  } else if (b === 0xf0) {
    if (pos + 5 > end) throw new RdbFormatError("truncated listpack str32");
    const len = view.getUint32(pos + 1, true);
    elen = 5 + len;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack str32 body");
    strBytes = buf.slice(pos + 5, pos + elen);
  } else if (b === 0xf1) {
    elen = 3;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack int16");
    intVal = BigInt(view.getInt16(pos + 1, true));
  } else if (b === 0xf2) {
    elen = 4;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack int24");
    const raw = buf[pos + 1] | (buf[pos + 2] << 8) | (buf[pos + 3] << 16);
    intVal = BigInt(raw & 8_388_608 ? raw | ~16_777_215 : raw);
  } else if (b === 0xf3) {
    elen = 5;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack int32");
    intVal = BigInt(view.getInt32(pos + 1, true));
  } else if (b === 0xf4) {
    elen = 9;
    if (pos + elen > end) throw new RdbFormatError("truncated listpack int64");
    intVal = view.getBigInt64(pos + 1, true);
  } else {
    throw new RdbFormatError("unknown listpack encoding");
  }
  const next = verifyBacklen(buf, pos + elen, end, elen);
  if (intVal !== undefined) return { item: { bytes: bytes(String(intVal)), int: intVal }, next };
  return { item: { bytes: strBytes ?? new Uint8Array(0) }, next };
}

export function decodeListpackItems(buf: Uint8Array): Array<ListpackItem> {
  if (buf.length < LP_HDR_SIZE + 1) throw new RdbFormatError("listpack too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const totalBytes = view.getUint32(0, true);
  if (totalBytes !== buf.length || buf.at(-1) !== LP_EOF) throw new RdbFormatError("invalid listpack framing");
  const expectedCount = view.getUint16(4, true);
  const end = buf.length - 1;
  const items: Array<ListpackItem> = [];
  let pos = LP_HDR_SIZE;
  while (pos < end) {
    const parsed = readEntry(buf, view, pos, end);
    items.push(parsed.item);
    pos = parsed.next;
  }
  if (pos !== end) throw new RdbFormatError("listpack cursor mismatch");
  if (expectedCount !== 65_535 && items.length !== expectedCount) throw new RdbFormatError("listpack element count mismatch");
  return items;
}

export function decodeListpack(buf: Uint8Array): Array<Uint8Array> {
  return decodeListpackItems(buf).map((item) => item.bytes);
}

export function listpackInt(item: ListpackItem): bigint {
  if (item.int !== undefined) return item.int;
  const parsed = toInt64(item.bytes);
  if (parsed === undefined) throw new RdbFormatError("expected listpack integer");
  return parsed;
}
