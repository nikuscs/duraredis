import net from "node:net";

export type RespArg = string | Uint8Array;

export type RespValue =
  | { kind: "simple"; value: string }
  | { kind: "error"; value: string }
  | { kind: "int"; value: bigint }
  | { kind: "bulk"; value: Uint8Array }
  | { kind: "null-bulk" }
  | { kind: "null-array" }
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "double"; value: string }
  | { kind: "bignum"; value: string }
  | { kind: "verbatim"; value: Uint8Array }
  | { kind: "blob-error"; value: Uint8Array }
  | { kind: "array"; items: Array<RespValue> }
  | { kind: "set"; items: Array<RespValue> }
  | { kind: "map"; entries: Array<[RespValue, RespValue]> }
  | { kind: "push"; items: Array<RespValue> };

const enc = new TextEncoder();
const dec = new TextDecoder();
const CRLF = enc.encode("\r\n");

const toBytes = (arg: RespArg): Uint8Array => (typeof arg === "string" ? enc.encode(arg) : arg);

function concat(parts: Array<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function encodeCommand(args: Array<RespArg>): Uint8Array {
  const parts: Array<Uint8Array> = [enc.encode(`*${args.length}\r\n`)];
  for (const arg of args) {
    const b = toBytes(arg);
    parts.push(enc.encode(`$${b.length}\r\n`), b, CRLF);
  }
  return concat(parts);
}

function findCrlf(buf: Uint8Array, start: number): number {
  for (let i = start; i < buf.length - 1; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function parseIntLine(buf: Uint8Array, start: number, end: number): number {
  const raw = dec.decode(buf.subarray(start, end));
  if (!/^-?\d+$/.test(raw)) throw new Error(`Malformed RESP integer: ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`Out-of-range RESP length: ${raw}`);
  return n;
}

function decodeAt(buf: Uint8Array, offset: number): { value: RespValue; next: number } | null {
  if (offset >= buf.length) return null;
  const prefix = buf[offset];
  const crlf = findCrlf(buf, offset + 1);
  if (crlf === -1) return null;
  const line = dec.decode(buf.subarray(offset + 1, crlf));
  let pos = crlf + 2;

  switch (prefix) {
    case 43: return { value: { kind: "simple", value: line }, next: pos };
    case 45: return { value: { kind: "error", value: line }, next: pos };
    case 58: return { value: { kind: "int", value: BigInt(line) }, next: pos };
    case 44: return { value: { kind: "double", value: line }, next: pos };
    case 40: return { value: { kind: "bignum", value: line }, next: pos };
    case 95:
      if (line !== "") throw new Error(`Invalid RESP null: ${JSON.stringify(line)}`);
      return { value: { kind: "null" }, next: pos };
    case 35:
      if (line !== "t" && line !== "f") throw new Error(`Invalid RESP bool: ${JSON.stringify(line)}`);
      return { value: { kind: "bool", value: line === "t" }, next: pos };
    case 36:
    case 33:
    case 61: {
      const len = parseIntLine(buf, offset + 1, crlf);
      if (prefix === 36 && len === -1) return { value: { kind: "null-bulk" }, next: pos };
      if (len < 0) throw new Error(`Invalid RESP bulk length: ${len}`);
      const end = pos + len;
      if (end + 2 > buf.length) return null;
      if (buf[end] !== 13 || buf[end + 1] !== 10) throw new Error("Missing CRLF after RESP bulk payload");
      const kind = prefix === 36 ? "bulk" : prefix === 33 ? "blob-error" : "verbatim";
      return { value: { kind, value: buf.slice(pos, end) }, next: end + 2 };
    }
    case 42:
    case 126:
    case 62: {
      const count = parseIntLine(buf, offset + 1, crlf);
      if (prefix === 42 && count === -1) return { value: { kind: "null-array" }, next: pos };
      if (count < 0) throw new Error(`Invalid RESP aggregate count: ${count}`);
      const items: Array<RespValue> = [];
      for (let i = 0; i < count; i++) {
        const child = decodeAt(buf, pos);
        if (!child) return null;
        items.push(child.value);
        pos = child.next;
      }
      const kind = prefix === 42 ? "array" : prefix === 126 ? "set" : "push";
      return { value: { kind, items }, next: pos };
    }
    case 37: {
      const count = parseIntLine(buf, offset + 1, crlf);
      if (count < 0) throw new Error(`Invalid RESP map count: ${count}`);
      const entries: Array<[RespValue, RespValue]> = [];
      for (let i = 0; i < count; i++) {
        const k = decodeAt(buf, pos);
        if (!k) return null;
        const v = decodeAt(buf, k.next);
        if (!v) return null;
        entries.push([k.value, v.value]);
        pos = v.next;
      }
      return { value: { kind: "map", entries }, next: pos };
    }
    case 124: {
      const count = parseIntLine(buf, offset + 1, crlf);
      if (count < 0) throw new Error(`Invalid RESP attribute count: ${count}`);
      for (let i = 0; i < count; i++) {
        const k = decodeAt(buf, pos);
        if (!k) return null;
        const v = decodeAt(buf, k.next);
        if (!v) return null;
        pos = v.next;
      }
      return decodeAt(buf, pos);
    }
    default:
      throw new Error(`Unknown RESP prefix byte: 0x${prefix.toString(16)}`);
  }
}

export function decodeResp(raw: Uint8Array): RespValue {
  const res = decodeAt(raw, 0);
  if (!res) throw new Error("Incomplete RESP frame");
  if (res.next !== raw.length) throw new Error(`Trailing bytes after RESP frame: ${res.next} of ${raw.length}`);
  return res.value;
}

export function formatBytes(b: Uint8Array): string {
  let out = '"';
  for (const byte of b) {
    if (byte === 13) out += String.raw`\r`;
    else if (byte === 10) out += String.raw`\n`;
    else if (byte === 92) out += String.raw`\\`;
    else if (byte === 34) out += String.raw`\"`;
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return `${out}"`;
}

interface Waiter {
  resolve: (frame: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WireClient {
  private socket: net.Socket;
  private buf: Uint8Array = new Uint8Array(0);
  private waiters: Array<Waiter> = [];
  private closed = false;
  private lastError: Error | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.setNoDelay(true);
    this.socket.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? new Uint8Array(chunk) : concat([this.buf, chunk]);
      this.drain();
    });
    this.socket.on("error", (err: Error) => {
      if (!this.lastError) this.lastError = err;
    });
    this.socket.on("end", () => {
      this.drain();
      if (!this.closed) this.socket.end();
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.drain();
      this.rejectAll(this.lastError ?? new Error("Connection closed before reply"));
    });
  }

  static connect(host: string, port: number, timeoutMs = 5000): Promise<WireClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`TCP connect to ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const onError = (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(new WireClient(socket));
      });
    });
  }

  private rejectAll(err: Error) {
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (!w) continue;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private takeNextFrame(): Uint8Array | null {
    const res = decodeAt(this.buf, 0);
    if (!res) return null;
    const frame = this.buf.slice(0, res.next);
    this.buf = res.next === this.buf.length ? new Uint8Array(0) : this.buf.slice(res.next);
    return frame;
  }

  private drain() {
    while (this.waiters.length > 0) {
      let frame: Uint8Array | null;
      try {
        frame = this.takeNextFrame();
      } catch (error: unknown) {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!frame) break;
      const w = this.waiters.shift();
      if (!w) continue;
      clearTimeout(w.timer);
      w.resolve(frame);
    }
  }

  private writeBytes(payload: Uint8Array): Promise<void> {
    if (this.closed || this.socket.destroyed) return Promise.reject(this.lastError ?? new Error("Socket is closed"));
    return new Promise((resolve, reject) => {
      this.socket.write(payload, (err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }

  readReply(timeoutMs = 10_000): Promise<Uint8Array> {
    try {
      const immediate = this.takeNextFrame();
      if (immediate) return Promise.resolve(immediate);
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.closed) return Promise.reject(this.lastError ?? new Error("Connection closed"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for RESP reply after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  send(args: Array<RespArg>): Promise<void> {
    return this.writeBytes(encodeCommand(args));
  }

  async cmd(...args: Array<RespArg>): Promise<Uint8Array> {
    await this.send(args);
    return this.readReply();
  }

  async inline(line: RespArg): Promise<Uint8Array> {
    const b = toBytes(line);
    const payload = b.length >= 2 && b.at(-2) === 13 && b.at(-1) === 10 ? b : concat([b, CRLF]);
    await this.writeBytes(payload);
    return this.readReply();
  }

  async pipeline(commands: Array<Array<RespArg>>): Promise<Array<Uint8Array>> {
    if (commands.length === 0) return [];
    return this.rawPipeline(concat(commands.map(encodeCommand)), commands.length);
  }

  async rawPipeline(payload: Uint8Array, count: number): Promise<Array<Uint8Array>> {
    await this.writeBytes(payload);
    const replies: Array<Uint8Array> = [];
    for (let i = 0; i < count; i++) replies.push(await this.readReply());
    return replies;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.destroy();
    });
  }
}
