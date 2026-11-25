import { bytes } from "../../resp/reply";
import { RdbFormatError, RdbWriter } from "./codec";

const INT16_MIN = -32_768n;
const INT16_MAX = 32_767n;
const INT32_MIN = -2_147_483_648n;
const INT32_MAX = 2_147_483_647n;

export function encodeIntset(values: Array<bigint>): Uint8Array {
  const sorted = values.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let width = 2;
  for (const v of sorted) {
    if (v < INT32_MIN || v > INT32_MAX) {
      width = 8;
      break;
    }
    if (v < INT16_MIN || v > INT16_MAX) width = 4;
  }
  const w = new RdbWriter(8 + sorted.length * width);
  w.u32le(width);
  w.u32le(sorted.length);
  for (const v of sorted) {
    if (width === 2) w.i16le(Number(v));
    else if (width === 4) w.i32le(Number(v));
    else w.i64le(v);
  }
  return w.bytes();
}

export function decodeIntset(buf: Uint8Array): Array<Uint8Array> {
  if (buf.length < 8) throw new RdbFormatError("intset too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const enc = view.getUint32(0, true);
  const len = view.getUint32(4, true);
  if (enc !== 2 && enc !== 4 && enc !== 8) throw new RdbFormatError("invalid intset encoding");
  if (len === 0 || buf.length !== 8 + len * enc) throw new RdbFormatError("invalid intset length");
  const out: Array<Uint8Array> = [];
  for (let i = 0; i < len; i++) {
    const off = 8 + i * enc;
    const v = enc === 2 ? BigInt(view.getInt16(off, true)) : enc === 4 ? BigInt(view.getInt32(off, true)) : view.getBigInt64(off, true);
    out.push(bytes(String(v)));
  }
  return out;
}
