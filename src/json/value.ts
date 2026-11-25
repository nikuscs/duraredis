import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";

export type JVal =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: bigint }
  | { t: "float"; v: number }
  | { t: "str"; v: string }
  | { t: "arr"; v: Array<JVal> }
  | { t: "obj"; v: Array<[string, JVal]> };

export interface JsonFmt {
  indent: string;
  newline: string;
  space: string;
}

export const DEFAULT_FMT: JsonFmt = { indent: "", newline: "", space: "" };
export const I64_MIN = -(2n ** 63n);
export const I64_MAX = 2n ** 63n - 1n;
export const U64_MAX = 2n ** 64n - 1n;

const enc = new TextEncoder();

export function utf8Len(s: string): number {
  return enc.encode(s).length;
}

export function objFind(entries: Array<[string, JVal]>, key: string): number {
  for (let i = 0; i < entries.length; i++) if (entries[i][0] === key) return i;
  return -1;
}

export function objGet(entries: Array<[string, JVal]>, key: string): JVal | undefined {
  const i = objFind(entries, key);
  return i === -1 ? undefined : entries[i][1];
}

export function objSet(entries: Array<[string, JVal]>, key: string, val: JVal): void {
  const i = objFind(entries, key);
  if (i === -1) entries.push([key, val]);
  else entries[i][1] = val;
}

export function objDelete(entries: Array<[string, JVal]>, key: string): boolean {
  const i = objFind(entries, key);
  if (i === -1) return false;
  const last = entries.pop();
  if (last && i < entries.length) entries[i] = last;
  return true;
}

export function jType(v: JVal): string {
  if (v.t === "bool") return "boolean";
  if (v.t === "int") return "integer";
  if (v.t === "float") return "number";
  if (v.t === "str") return "string";
  if (v.t === "arr") return "array";
  if (v.t === "obj") return "object";
  return "null";
}

export function jClone(v: JVal): JVal {
  if (v.t === "arr") return { t: "arr", v: v.v.map(jClone) };
  if (v.t === "obj") return { t: "obj", v: v.v.map(([k, x]) => [k, jClone(x)]) };
  return v;
}

export function jNum(v: JVal): number {
  if (v.t === "int") return Number(v.v);
  if (v.t === "float") return v.v;
  return Number.NaN;
}

export function formatJsonFloat(n: number): string {
  if (Object.is(n, -0)) return "-0.0";
  if (n === 0) return "0.0";
  const sign = n < 0 ? "-" : "";
  const [mantissa, expStr] = Math.abs(n).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exp = Number(expStr);
  if (exp >= 16 || exp <= -6) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${m}e${exp}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  const intLen = exp + 1;
  if (digits.length <= intLen) return `${sign}${digits}${"0".repeat(intLen - digits.length)}.0`;
  return `${sign}${digits.slice(0, intLen)}.${digits.slice(intLen)}`;
}

export function escapeJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += String.raw`\"`;
    else if (c === 0x5c) out += String.raw`\\`;
    else if (c === 0x08) out += String.raw`\b`;
    else if (c === 0x0c) out += String.raw`\f`;
    else if (c === 0x0a) out += String.raw`\n`;
    else if (c === 0x0d) out += String.raw`\r`;
    else if (c === 0x09) out += String.raw`\t`;
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  return `${out}"`;
}

export function stringifyJson(v: JVal, fmt: JsonFmt = DEFAULT_FMT, depth = 0): string {
  if (v.t === "null") return "null";
  if (v.t === "bool") return v.v ? "true" : "false";
  if (v.t === "int") return String(v.v);
  if (v.t === "float") return formatJsonFloat(v.v);
  if (v.t === "str") return escapeJsonString(v.v);
  if (v.t === "arr") {
    if (!v.v.length) return "[]";
    const pad = fmt.indent.repeat(depth + 1);
    const body = v.v.map((x) => `${pad}${stringifyJson(x, fmt, depth + 1)}`).join(`,${fmt.newline}`);
    return `[${fmt.newline}${body}${fmt.newline}${fmt.indent.repeat(depth)}]`;
  }
  if (!v.v.length) return "{}";
  const pad = fmt.indent.repeat(depth + 1);
  const body = v.v.map(([k, x]) => `${pad}${escapeJsonString(k)}:${fmt.space}${stringifyJson(x, fmt, depth + 1)}`).join(`,${fmt.newline}`);
  return `{${fmt.newline}${body}${fmt.newline}${fmt.indent.repeat(depth)}}`;
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

export function parseJson(src: string, errPrefix = ""): JVal {
  let pos = 0;
  let line = 1;
  let col = 1;

  const fail = (msg: string, l = line, c = col): never => {
    throw new RedisError(`${errPrefix}${msg} at line ${l} column ${c}`);
  };

  const advance = () => {
    if (src[pos] === "\n") {
      line++;
      col = 1;
    } else {
      col++;
    }
    pos++;
  };

  const skipWs = () => {
    while (pos < src.length) {
      const ch = src[pos];
      if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
      advance();
    }
  };

  const parseIdent = (lit: string, val: JVal): JVal => {
    for (let i = 0; i < lit.length; i++) {
      if (pos >= src.length) fail("EOF while parsing a value");
      if (src[pos] !== lit[i]) fail("expected ident");
      advance();
    }
    return val;
  };

  const hex4 = (): number => {
    if (pos + 4 > src.length) fail("EOF while parsing a string");
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const code = src.charCodeAt(pos);
      const digit =
        code >= 0x30 && code <= 0x39 ? code - 0x30 :
        code >= 0x41 && code <= 0x46 ? code - 0x37 :
        code >= 0x61 && code <= 0x66 ? code - 0x57 : -1;
      if (digit === -1) fail("invalid escape");
      n = (n << 4) | digit;
      advance();
    }
    return n;
  };

  const parseString = (): string => {
    advance();
    let out = "";
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '"') {
        advance();
        return out;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) fail(String.raw`control character (\u0000-\u001F) found while parsing a string`);
      if (ch !== "\\") {
        out += ch;
        advance();
        continue;
      }
      advance();
      if (pos >= src.length) fail("EOF while parsing a string");
      const esc = src[pos];
      advance();
      if (esc === '"') out += '"';
      else if (esc === "\\") out += "\\";
      else if (esc === "/") out += "/";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "u") out += String.fromCharCode(hex4());
      else fail("invalid escape");
    }
    return fail("EOF while parsing a string");
  };

  const parseNumber = (): JVal => {
    const start = pos;
    if (src[pos] === "-") advance();
    if (pos >= src.length) fail("EOF while parsing a value");
    if (src[pos] === "0") {
      advance();
    } else if (src[pos] >= "1" && src[pos] <= "9") {
      while (pos < src.length && isDigit(src[pos])) advance();
    } else {
      fail("invalid number");
    }
    let isFloat = false;
    if (src[pos] === ".") {
      isFloat = true;
      advance();
      if (!isDigit(src[pos])) fail("invalid number");
      while (pos < src.length && isDigit(src[pos])) advance();
    }
    if (src[pos] === "e" || src[pos] === "E") {
      isFloat = true;
      advance();
      if (src[pos] === "+" || src[pos] === "-") advance();
      if (!isDigit(src[pos])) fail("invalid number");
      while (pos < src.length && isDigit(src[pos])) advance();
    }
    const raw = src.slice(start, pos);
    if (raw === "-0") return { t: "float", v: -0 };
    if (!isFloat) {
      const n = BigInt(raw);
      if (n >= I64_MIN && n <= U64_MAX) return { t: "int", v: n };
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) fail("number out of range", line, col - 1);
    return { t: "float", v: num };
  };

  const parseValue = (): JVal => {
    skipWs();
    if (pos >= src.length) fail("EOF while parsing a value");
    const ch = src[pos];
    if (ch === "n") return parseIdent("null", { t: "null" });
    if (ch === "t") return parseIdent("true", { t: "bool", v: true });
    if (ch === "f") return parseIdent("false", { t: "bool", v: false });
    if (ch === '"') return { t: "str", v: parseString() };
    if (ch === "[") return parseArray();
    if (ch === "{") return parseObject();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    return fail("expected value");
  };

  const parseArray = (): JVal => {
    advance();
    skipWs();
    const items: Array<JVal> = [];
    if (src[pos] === "]") {
      advance();
      return { t: "arr", v: items };
    }
    while (true) {
      items.push(parseValue());
      skipWs();
      if (src[pos] === ",") {
        advance();
        continue;
      }
      if (src[pos] === "]") {
        advance();
        return { t: "arr", v: items };
      }
      if (pos >= src.length) fail("EOF while parsing a list");
      fail("expected `,` or `]`");
    }
  };

  const parseObject = (): JVal => {
    advance();
    skipWs();
    const entries: Array<[string, JVal]> = [];
    if (src[pos] === "}") {
      advance();
      return { t: "obj", v: entries };
    }
    while (true) {
      skipWs();
      if (pos >= src.length) fail("EOF while parsing an object");
      if (src[pos] !== '"') fail("key must be a string");
      const k = parseString();
      skipWs();
      if (pos >= src.length) fail("EOF while parsing an object");
      if (src[pos] !== ":") fail("expected `:`");
      advance();
      objSet(entries, k, parseValue());
      skipWs();
      if (src[pos] === ",") {
        advance();
        continue;
      }
      if (src[pos] === "}") {
        advance();
        return { t: "obj", v: entries };
      }
      if (pos >= src.length) fail("EOF while parsing an object");
      fail("expected `,` or `}`");
    }
  };

  const root = parseValue();
  skipWs();
  if (pos < src.length) fail("trailing characters");
  return root;
}

export function jStrictEq(a: JVal, b: JVal): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "null") return true;
  if (a.t === "bool" && b.t === "bool") return a.v === b.v;
  if (a.t === "int" && b.t === "int") return a.v === b.v;
  if (a.t === "float" && b.t === "float") return a.v === b.v;
  if (a.t === "str" && b.t === "str") return a.v === b.v;
  if (a.t === "arr" && b.t === "arr") return a.v.length === b.v.length && a.v.every((x, i) => jStrictEq(x, b.v[i]));
  if (a.t === "obj" && b.t === "obj") {
    if (a.v.length !== b.v.length) return false;
    return a.v.every(([k, x]) => {
      const y = objGet(b.v, k);
      return y !== undefined && jStrictEq(x, y);
    });
  }
  return false;
}

function intFloatEq(i: bigint, f: number): boolean {
  if (!Number.isFinite(f) || !Number.isInteger(f)) return false;
  if (f < Number.MIN_SAFE_INTEGER || f > Number.MAX_SAFE_INTEGER) return Number(i) === f;
  return BigInt(f) === i;
}

export function jFilterEq(a: JVal, b: JVal): boolean {
  if (a.t === "int" && b.t === "float") return intFloatEq(a.v, b.v);
  if (a.t === "float" && b.t === "int") return intFloatEq(b.v, a.v);
  if (a.t !== b.t) return false;
  if (a.t === "null") return true;
  if (a.t === "bool" && b.t === "bool") return a.v === b.v;
  if (a.t === "int" && b.t === "int") return a.v === b.v;
  if (a.t === "float" && b.t === "float") return a.v === b.v;
  if (a.t === "str" && b.t === "str") return a.v === b.v;
  if (a.t === "arr" && b.t === "arr") return a.v.length === b.v.length && a.v.every((x, i) => jFilterEq(x, b.v[i]));
  if (a.t === "obj" && b.t === "obj") {
    if (a.v.length !== b.v.length) return false;
    return a.v.every(([k, x]) => {
      const y = objGet(b.v, k);
      return y !== undefined && jFilterEq(x, y);
    });
  }
  return false;
}

export function mergePatch(target: JVal, patch: JVal): JVal {
  if (patch.t !== "obj") return jClone(patch);
  const out: { t: "obj"; v: Array<[string, JVal]> } = target.t === "obj" ? target : { t: "obj", v: [] };
  for (const [k, pv] of patch.v) {
    if (pv.t === "null") objDelete(out.v, k);
    else objSet(out.v, k, mergePatch(objGet(out.v, k) ?? { t: "obj", v: [] }, pv));
  }
  return out;
}

export function jToResp(v: JVal): Reply {
  if (v.t === "null") return r.nil;
  if (v.t === "bool") return r.simple(v.v ? "true" : "false");
  if (v.t === "int") return v.v <= I64_MAX ? r.int(v.v) : r.double(Number(v.v));
  if (v.t === "float") return r.double(v.v);
  if (v.t === "str") return r.bulk(v.v);
  if (v.t === "arr") return r.array([r.simple("["), ...v.v.map(jToResp)]);
  return r.array([r.simple("{"), ...v.v.flatMap(([k, x]) => [r.bulk(k), jToResp(x)])]);
}

export function jToExpand(v: JVal): Reply {
  if (v.t === "null") return r.nil;
  if (v.t === "bool") return r.bool(v.v);
  if (v.t === "int") return v.v <= I64_MAX ? r.int(v.v) : r.double(Number(v.v));
  if (v.t === "float") return r.double(v.v);
  if (v.t === "str") return r.bulk(v.v);
  if (v.t === "arr") return r.array(v.v.map(jToExpand));
  return r.map(v.v.map(([k, x]) => [r.bulk(k), jToExpand(x)]));
}

export function jMemBytes(v: JVal): number {
  if (v.t === "float") return 16;
  if (v.t === "str") {
    const n = utf8Len(v.v);
    return n <= 7 ? 8 : Math.ceil((n + 9) / 8) * 8;
  }
  if (v.t === "arr") {
    if (!v.v.length) return 8;
    let sum = 0;
    for (const x of v.v) sum += jMemBytes(x);
    return Math.max(8, sum);
  }
  if (v.t === "obj") {
    if (!v.v.length) return 8;
    let sum = 8;
    for (const [k, x] of v.v) sum += 16 + utf8Len(k) + jMemBytes(x);
    return Math.ceil(sum / 8) * 8;
  }
  return 8;
}
