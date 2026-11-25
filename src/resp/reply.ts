export type Reply =
  | { t: "simple"; s: string }
  | { t: "error"; s: string }
  | { t: "int"; n: number | bigint }
  | { t: "bulk"; b: Uint8Array | null }
  | { t: "array"; items: Array<Reply> | null }
  | { t: "map"; entries: Array<[Reply, Reply]> }
  | { t: "set"; items: Array<Reply> }
  | { t: "double"; n: number }
  | { t: "bool"; b: boolean }
  | { t: "verbatim"; s: string; format: string }
  | { t: "bignum"; s: string }
  | { t: "push"; items: Array<Reply> };

export type Proto = 2 | 3;

const enc = new TextEncoder();
const dec = new TextDecoder();
export const bytes = (s: string) => enc.encode(s);
export const text = (b: Uint8Array) => dec.decode(b);

export class RedisError extends Error {}

export const r = {
  ok: { t: "simple", s: "OK" } as Reply,
  queued: { t: "simple", s: "QUEUED" } as Reply,
  nil: { t: "bulk", b: null } as Reply,
  nilArray: { t: "array", items: null } as Reply,
  simple: (s: string): Reply => ({ t: "simple", s }),
  error: (s: string): Reply => ({ t: "error", s }),
  int: (n: number | bigint): Reply => ({ t: "int", n }),
  bulk: (b: Uint8Array | string | null): Reply => ({ t: "bulk", b: typeof b === "string" ? enc.encode(b) : b }),
  array: (items: Array<Reply> | null): Reply => ({ t: "array", items }),
  bulks: (items: Array<Uint8Array | string | null>): Reply => ({ t: "array", items: items.map((b) => r.bulk(b)) }),
  map: (entries: Array<[Reply, Reply]>): Reply => ({ t: "map", entries }),
  set: (items: Array<Reply>): Reply => ({ t: "set", items }),
  double: (n: number): Reply => ({ t: "double", n }),
  bool: (b: boolean): Reply => ({ t: "bool", b }),
  verbatim: (s: string, format = "txt"): Reply => ({ t: "verbatim", s, format }),
  bignum: (s: string): Reply => ({ t: "bignum", s }),
  push: (items: Array<Reply>): Reply => ({ t: "push", items }),
};

function scientific(digits: string, exponent: number): string {
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${mantissa}e${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
}

export function formatDouble(n: number): string {
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  if (Number.isNaN(n)) return "nan";
  if (Object.is(n, -0)) return "-0";
  if (Number.isInteger(n) && n > -(2 ** 52) && n < 2 ** 52) return n.toFixed(0);
  const sign = n < 0 ? "-" : "";
  const [mantissa, exp] = Math.abs(n).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exp);
  const k = exponent - (digits.length - 1);
  const magnitude = Math.abs(exponent);
  if (k >= 0 && magnitude < digits.length + 7) return `${sign}${digits}${"0".repeat(k)}`;
  if (k >= 0 || (k <= -7 && magnitude >= 4)) return `${sign}${scientific(digits, exponent)}`;
  const point = digits.length + k;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

const CRLF = enc.encode("\r\n");
const NULL3 = enc.encode("_\r\n");
const NULL_BULK = enc.encode("$-1\r\n");
const NULL_ARRAY = enc.encode("*-1\r\n");

export class Encoder {
  private chunks: Array<Uint8Array> = [];
  private size = 0;

  constructor(public proto: Proto) {}

  get empty(): boolean {
    return this.size === 0;
  }

  write(reply: Reply): this {
    const resp3 = this.proto === 3;
    switch (reply.t) {
      case "simple":
        return this.line("+", reply.s);
      case "error":
        return this.line("-", reply.s.replaceAll(/[\r\n]+/g, " "));
      case "int":
        return this.line(":", String(reply.n));
      case "bulk":
        if (!reply.b) return this.raw(resp3 ? NULL3 : NULL_BULK);
        return this.blob("$", reply.b);
      case "array":
        if (!reply.items) return this.raw(resp3 ? NULL3 : NULL_ARRAY);
        return this.aggregate("*", reply.items);
      case "map":
        if (!resp3) return this.aggregate("*", reply.entries.flat());
        this.line("%", String(reply.entries.length));
        for (const [k, v] of reply.entries) this.write(k).write(v);
        return this;
      case "set":
        return this.aggregate(resp3 ? "~" : "*", reply.items);
      case "double":
        if (resp3) return this.line(",", formatDouble(reply.n));
        return this.blob("$", enc.encode(formatDouble(reply.n)));
      case "bool":
        if (resp3) return this.line("#", reply.b ? "t" : "f");
        return this.line(":", reply.b ? "1" : "0");
      case "verbatim":
        if (resp3) return this.blob("=", enc.encode(`${reply.format}:${reply.s}`));
        return this.blob("$", enc.encode(reply.s));
      case "bignum":
        if (resp3) return this.line("(", reply.s);
        return this.blob("$", enc.encode(reply.s));
      case "push":
        return this.aggregate(resp3 ? ">" : "*", reply.items);
    }
  }

  take(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];
    this.size = 0;
    return out;
  }

  private raw(b: Uint8Array): this {
    this.chunks.push(b);
    this.size += b.length;
    return this;
  }

  private line(prefix: string, s: string): this {
    return this.raw(enc.encode(`${prefix}${s}\r\n`));
  }

  private blob(prefix: string, b: Uint8Array): this {
    return this.line(prefix, String(b.length)).raw(b).raw(CRLF);
  }

  private aggregate(prefix: string, items: Array<Reply>): this {
    this.line(prefix, String(items.length));
    for (const item of items) this.write(item);
    return this;
  }
}
