import { bytes } from "../../resp/reply";
import { RdbFormatError } from "./codec";

const ZIP_HDR_SIZE = 10;
const ZIP_EOF = 0xff;
const ZIP_BIG_PREVLEN = 0xfe;

function skipPrevlen(buf: Uint8Array, pos: number, end: number): number {
  if (pos >= end) throw new RdbFormatError("truncated ziplist prevlen");
  const first = buf[pos];
  if (first < ZIP_BIG_PREVLEN) return pos + 1;
  if (first === ZIP_BIG_PREVLEN) {
    if (pos + 5 > end) throw new RdbFormatError("truncated ziplist large prevlen");
    return pos + 5;
  }
  throw new RdbFormatError("invalid ziplist prevlen");
}

function readInt24(buf: Uint8Array, pos: number): number {
  const raw = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
  return raw & 8_388_608 ? raw | ~16_777_215 : raw;
}

export function decodeZiplist(buf: Uint8Array): Array<Uint8Array> {
  if (buf.length < ZIP_HDR_SIZE + 1) throw new RdbFormatError("ziplist too short");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const zlbytes = view.getUint32(0, true);
  if (zlbytes !== buf.length || buf.at(-1) !== ZIP_EOF) throw new RdbFormatError("invalid ziplist framing");
  const zllen = view.getUint16(8, true);
  const end = buf.length - 1;
  const out: Array<Uint8Array> = [];
  let pos = ZIP_HDR_SIZE;
  while (pos < end) {
    pos = skipPrevlen(buf, pos, end);
    if (pos >= end) throw new RdbFormatError("truncated ziplist encoding");
    const enc = buf[pos++];
    const strType = enc & 0xc0;
    if (strType === 0x00) {
      const len = enc & 0x3f;
      if (pos + len > end) throw new RdbFormatError("truncated ziplist string6");
      out.push(buf.slice(pos, pos + len));
      pos += len;
      continue;
    }
    if (strType === 0x40) {
      if (pos >= end) throw new RdbFormatError("truncated ziplist string14");
      const len = ((enc & 0x3f) << 8) | buf[pos++];
      if (pos + len > end) throw new RdbFormatError("truncated ziplist string14 body");
      out.push(buf.slice(pos, pos + len));
      pos += len;
      continue;
    }
    if (strType === 0x80) {
      if (enc !== 0x80 || pos + 4 > end) throw new RdbFormatError("invalid ziplist string32");
      const len = view.getUint32(pos, false);
      pos += 4;
      if (pos + len > end) throw new RdbFormatError("truncated ziplist string32 body");
      out.push(buf.slice(pos, pos + len));
      pos += len;
      continue;
    }
    if (enc === 0xc0) {
      if (pos + 2 > end) throw new RdbFormatError("truncated ziplist int16");
      out.push(bytes(String(view.getInt16(pos, true))));
      pos += 2;
    } else if (enc === 0xd0) {
      if (pos + 4 > end) throw new RdbFormatError("truncated ziplist int32");
      out.push(bytes(String(view.getInt32(pos, true))));
      pos += 4;
    } else if (enc === 0xe0) {
      if (pos + 8 > end) throw new RdbFormatError("truncated ziplist int64");
      out.push(bytes(String(view.getBigInt64(pos, true))));
      pos += 8;
    } else if (enc === 0xf0) {
      if (pos + 3 > end) throw new RdbFormatError("truncated ziplist int24");
      out.push(bytes(String(readInt24(buf, pos))));
      pos += 3;
    } else if (enc === 0xfe) {
      if (pos + 1 > end) throw new RdbFormatError("truncated ziplist int8");
      out.push(bytes(String((buf[pos++] << 24) >> 24)));
    } else if (enc >= 0xf1 && enc <= 0xfd) {
      out.push(bytes(String((enc & 0x0f) - 1)));
    } else {
      throw new RdbFormatError("unknown ziplist encoding");
    }
  }
  if (pos !== end) throw new RdbFormatError("ziplist cursor mismatch");
  if (zllen !== 65_535 && out.length !== zllen) throw new RdbFormatError("ziplist element count mismatch");
  return out;
}
