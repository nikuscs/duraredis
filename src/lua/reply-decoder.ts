import { r, text } from "../resp/reply";
import type { Reply } from "../resp/reply";

interface Cursor {
  buf: Uint8Array;
  pos: number;
}

function findCrlf(buf: Uint8Array, start: number): number {
  for (let i = start; i < buf.length - 1; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function readLine(c: Cursor): string {
  const end = findCrlf(c.buf, c.pos);
  if (end === -1) throw new Error("Incomplete RESP line from Lua");
  const line = text(c.buf.subarray(c.pos, end));
  c.pos = end + 2;
  return line;
}

function parseDouble(line: string): number {
  if (line === "inf") return Infinity;
  if (line === "-inf") return -Infinity;
  if (line === "nan") return Number.NaN;
  if (line === "-0") return -0;
  return Number(line);
}

function decodeNext(c: Cursor): Reply {
  if (c.pos >= c.buf.length) throw new Error("Unexpected end of RESP from Lua");
  const prefix = c.buf[c.pos++];
  const line = readLine(c);

  switch (prefix) {
    case 43:
      return r.simple(line);
    case 45:
      return r.error(line);
    case 58:
      return r.int(BigInt(line));
    case 95:
      return r.nil;
    case 35:
      return r.bool(line === "t");
    case 44:
      return r.double(parseDouble(line));
    case 40:
      return r.bignum(line);
    case 36: {
      const len = Number(line);
      if (len < 0) return r.nil;
      const slice = c.buf.slice(c.pos, c.pos + len);
      c.pos += len + 2;
      return r.bulk(slice);
    }
    case 61: {
      const len = Number(line);
      const format = text(c.buf.subarray(c.pos, c.pos + 3));
      const payload = text(c.buf.subarray(c.pos + 4, c.pos + len));
      c.pos += len + 2;
      return r.verbatim(payload, format);
    }
    case 42: {
      const count = Number(line);
      if (count < 0) return r.nilArray;
      const items: Array<Reply> = [];
      for (let i = 0; i < count; i++) items.push(decodeNext(c));
      return r.array(items);
    }
    case 126: {
      const count = Number(line);
      const items: Array<Reply> = [];
      for (let i = 0; i < count; i++) items.push(decodeNext(c));
      return r.set(items);
    }
    case 37: {
      const count = Number(line);
      const entries: Array<[Reply, Reply]> = [];
      for (let i = 0; i < count; i++) entries.push([decodeNext(c), decodeNext(c)]);
      return r.map(entries);
    }
    case 62: {
      const count = Number(line);
      const items: Array<Reply> = [];
      for (let i = 0; i < count; i++) items.push(decodeNext(c));
      return { t: "push", items };
    }
    default:
      throw new Error(`Unknown RESP prefix 0x${prefix.toString(16)} from Lua`);
  }
}

export function decodeReply(buf: Uint8Array): Reply {
  return decodeNext({ buf, pos: 0 });
}
