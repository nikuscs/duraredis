import { text } from "../resp/reply";

export const FLAG_NO_WRITES = 1;
export const FLAG_ALLOW_OOM = 2;
export const FLAG_ALLOW_STALE = 4;
export const FLAG_NO_CLUSTER = 8;
export const FLAG_ALLOW_CROSS_SLOT = 16;
export const FLAG_EVAL_COMPAT = 32;

const FLAG_DEFS: ReadonlyArray<readonly [number, string]> = [
  [FLAG_NO_WRITES, "no-writes"],
  [FLAG_ALLOW_OOM, "allow-oom"],
  [FLAG_ALLOW_STALE, "allow-stale"],
  [FLAG_NO_CLUSTER, "no-cluster"],
  [FLAG_ALLOW_CROSS_SLOT, "allow-cross-slot-keys"],
];

function isSpace(b: number): boolean {
  return b === 32 || b === 9 || b === 10 || b === 11 || b === 12 || b === 13;
}

function hexVal(b: number): number {
  if (b >= 48 && b <= 57) return b - 48;
  if (b >= 97 && b <= 102) return b - 87;
  if (b >= 65 && b <= 70) return b - 55;
  return -1;
}

function escapeByte(b: number): number {
  switch (b) {
    case 110:
      return 10;
    case 114:
      return 13;
    case 116:
      return 9;
    case 98:
      return 8;
    case 97:
      return 7;
    default:
      return b;
  }
}

export function splitArgs(line: Uint8Array): Array<string> | null {
  const out: Array<string> = [];
  let p = 0;
  while (p < line.length) {
    while (p < line.length && isSpace(line[p])) p++;
    if (p >= line.length) break;
    const cur: Array<number> = [];
    let inq = false;
    let insq = false;
    let done = false;
    while (!done) {
      if (inq) {
        if (p >= line.length) return null;
        if (
          line[p] === 92 &&
          p + 3 < line.length &&
          line[p + 1] === 120 &&
          hexVal(line[p + 2]) >= 0 &&
          hexVal(line[p + 3]) >= 0
        ) {
          cur.push(hexVal(line[p + 2]) * 16 + hexVal(line[p + 3]));
          p += 3;
        } else if (line[p] === 92 && p + 1 < line.length) {
          p++;
          cur.push(escapeByte(line[p]));
        } else if (line[p] === 34) {
          if (p + 1 < line.length && !isSpace(line[p + 1])) return null;
          done = true;
        } else {
          cur.push(line[p]);
        }
      } else if (insq) {
        if (p >= line.length) return null;
        if (line[p] === 92 && p + 1 < line.length && line[p + 1] === 39) {
          p++;
          cur.push(39);
        } else if (line[p] === 39) {
          if (p + 1 < line.length && !isSpace(line[p + 1])) return null;
          done = true;
        } else {
          cur.push(line[p]);
        }
      } else if (p >= line.length || isSpace(line[p])) {
        done = true;
      } else if (line[p] === 34) {
        inq = true;
      } else if (line[p] === 39) {
        insq = true;
      } else {
        cur.push(line[p]);
      }
      if (p < line.length) p++;
    }
    out.push(text(new Uint8Array(cur)));
  }
  return out;
}

export type EvalShebangResult =
  | { ok: true; flags: number; shebangLen: number }
  | { ok: false; error: string };

export function extractEvalShebang(body: Uint8Array): EvalShebangResult {
  if (body.length < 2 || body[0] !== 35 || body[1] !== 33) {
    return { ok: true, flags: FLAG_EVAL_COMPAT, shebangLen: 0 };
  }
  const nl = body.indexOf(10);
  if (nl === -1) return { ok: false, error: "ERR Invalid script shebang" };
  const parts = splitArgs(body.subarray(0, nl));
  if (!parts || parts.length === 0) return { ok: false, error: "ERR Invalid engine in script shebang" };
  if (parts[0] !== "#!lua") return { ok: false, error: `ERR Unexpected engine in script shebang: ${parts[0]}` };
  let flags = 0;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith("flags=")) return { ok: false, error: `ERR Unknown lua shebang option: ${part}` };
    const raw = part.slice(6);
    if (raw.length === 0) continue;
    for (const f of raw.split(",")) {
      const def = FLAG_DEFS.find(([, name]) => name === f);
      if (!def) return { ok: false, error: `ERR Unexpected flag in script shebang: ${f}` };
      if ((flags & def[0]) === 0) flags += def[0];
    }
  }
  return { ok: true, flags, shebangLen: nl };
}

export type FunctionMetaResult =
  | { ok: true; engine: string; name: string; codeOffset: number }
  | { ok: false; error: string };

export function extractFunctionMeta(code: Uint8Array): FunctionMetaResult {
  if (code.length < 2 || code[0] !== 35 || code[1] !== 33) {
    return { ok: false, error: "ERR Missing library metadata" };
  }
  const nl = code.indexOf(10);
  if (nl === -1) return { ok: false, error: "ERR Invalid library metadata" };
  const parts = splitArgs(code.subarray(0, nl));
  if (!parts || parts.length === 0) return { ok: false, error: "ERR Invalid library metadata" };
  const engine = parts[0].slice(2);
  let name: string | null = null;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.toLowerCase().startsWith("name=")) {
      if (name !== null) return { ok: false, error: "ERR Invalid metadata value, name argument was given multiple times" };
      name = part.slice(5);
      continue;
    }
    return { ok: false, error: `ERR Invalid metadata value given: ${part}` };
  }
  if (name === null) return { ok: false, error: "ERR Library name was not given" };
  return { ok: true, engine, name, codeOffset: nl };
}

export function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(name);
}

export function flagNames(flags: number): Array<string> {
  const names: Array<string> = [];
  for (const [bit, name] of FLAG_DEFS) {
    if ((flags & bit) !== 0) names.push(name);
  }
  return names;
}
