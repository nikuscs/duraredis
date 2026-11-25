import { RedisError } from "./reply";

export type Command = Array<Uint8Array>;

const MAX_BULK = 512 * 1024 * 1024;
const MAX_MULTIBULK = 1024 * 1024;
const MAX_INLINE = 64 * 1024;
const CR = 13;
const LF = 10;
const STAR = 42;
const DOLLAR = 36;
const BACKSLASH = 92;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const ESCAPES = new Map([[110, 10], [114, 13], [116, 9], [98, 8], [97, 7]]);
const UNBALANCED = "ERR Protocol error: unbalanced quotes in request";

const isSpace = (c: number | undefined) => c === 32 || (c !== undefined && c >= 9 && c <= 13);
const isHex = (c: number | undefined) => c !== undefined && /[0-9a-f]/i.test(String.fromCharCode(c));

export class Parser {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;

  push(chunk: Uint8Array) {
    const rest = this.buf.subarray(this.pos);
    this.pos = 0;
    if (!rest.length) {
      this.buf = chunk;
      return;
    }
    this.buf = new Uint8Array(rest.length + chunk.length);
    this.buf.set(rest);
    this.buf.set(chunk, rest.length);
  }

  rest(): Uint8Array {
    return this.buf.subarray(this.pos);
  }

  next(): Command | undefined {
    while (this.pos < this.buf.length) {
      const start = this.pos;
      const cmd = this.buf[start] === STAR ? this.multibulk() : this.inline();
      if (!cmd) {
        this.pos = start;
        return undefined;
      }
      if (cmd.length) return cmd;
    }
    return undefined;
  }

  private lineEnd(from: number): number {
    for (let i = from; i < this.buf.length - 1; i++) if (this.buf[i] === CR && this.buf[i + 1] === LF) return i;
    return -1;
  }

  private int(from: number, to: number, what: string): number {
    const s = String.fromCharCode(...this.buf.subarray(from, to));
    if (!/^-?\d+$/.test(s)) throw new RedisError(`ERR Protocol error: invalid ${what}`);
    return Number(s);
  }

  private multibulk(): Command | undefined {
    const end = this.lineEnd(this.pos);
    if (end < 0 && this.buf.length - this.pos > MAX_INLINE) throw new RedisError("ERR Protocol error: too big mbulk count string");
    if (end < 0) return undefined;
    const count = this.int(this.pos + 1, end, "multibulk length");
    if (count > MAX_MULTIBULK) throw new RedisError("ERR Protocol error: invalid multibulk length");
    let p = end + 2;
    const args: Command = [];
    for (let i = 0; i < count; i++) {
      if (p >= this.buf.length) return undefined;
      if (this.buf[p] !== DOLLAR) throw new RedisError(`ERR Protocol error: expected '$', got '${String.fromCharCode(this.buf[p])}'`);
      const e = this.lineEnd(p);
      if (e < 0) return undefined;
      const len = this.int(p + 1, e, "bulk length");
      if (len < 0 || len > MAX_BULK) throw new RedisError("ERR Protocol error: invalid bulk length");
      const data = e + 2;
      if (data + len + 2 > this.buf.length) return undefined;
      args.push(this.buf.slice(data, data + len));
      p = data + len + 2;
    }
    this.pos = p;
    return args;
  }

  private inline(): Command | undefined {
    const end = this.buf.indexOf(LF, this.pos);
    if (end < 0 && this.buf.length - this.pos > MAX_INLINE) throw new RedisError("ERR Protocol error: too big inline request");
    if (end < 0) return undefined;
    const stop = end > this.pos && this.buf[end - 1] === CR ? end - 1 : end;
    const line = this.buf.subarray(this.pos, stop);
    this.pos = end + 1;
    return splitArgs(line);
  }
}

function quoted(line: Uint8Array, start: number, quote: number, out: Array<number>): number {
  for (let i = start; i < line.length; i++) {
    const c = line[i];
    if (c === quote) {
      if (i + 1 < line.length && !isSpace(line[i + 1])) throw new RedisError(UNBALANCED);
      return i + 1;
    }
    if (c !== BACKSLASH || i + 1 >= line.length) {
      out.push(c);
      continue;
    }
    if (quote === SINGLE_QUOTE) {
      out.push(line[i + 1] === SINGLE_QUOTE ? SINGLE_QUOTE : c);
      if (line[i + 1] === SINGLE_QUOTE) i++;
      continue;
    }
    if (line[i + 1] === 120 && isHex(line[i + 2]) && isHex(line[i + 3])) {
      out.push(Number.parseInt(String.fromCharCode(line[i + 2], line[i + 3]), 16));
      i += 3;
      continue;
    }
    out.push(ESCAPES.get(line[i + 1]) ?? line[i + 1]);
    i++;
  }
  throw new RedisError(UNBALANCED);
}

export function splitArgs(line: Uint8Array): Command {
  const args: Command = [];
  let i = 0;
  for (;;) {
    while (isSpace(line[i])) i++;
    if (i >= line.length) return args;
    const out: Array<number> = [];
    while (i < line.length && !isSpace(line[i])) {
      const c = line[i];
      if (c === DOUBLE_QUOTE || c === SINGLE_QUOTE) {
        i = quoted(line, i + 1, c, out);
        break;
      }
      out.push(c);
      i++;
    }
    args.push(Uint8Array.from(out));
  }
}
