import { RedisError } from "../resp/reply";
import { I64_MAX, I64_MIN, U64_MAX, jClone, jFilterEq, jNum, objDelete, objFind, objGet, objSet, utf8Len } from "./value";
import type { JVal } from "./value";

export type Step =
  | { k: "key"; name: string }
  | { k: "keys"; names: Array<string> }
  | { k: "index"; index: number }
  | { k: "indices"; indices: Array<number> }
  | { k: "slice"; start: number | undefined; end: number | undefined; step: number }
  | { k: "wild" }
  | { k: "filter"; expr: FilterExpr }
  | { k: "descend"; step: Step }
  | { k: "getKeys" }
  | { k: "func"; name: string; arg: JVal | undefined };

export type PathExpr =
  | { k: "path"; root: "$" | "@"; steps: Array<Step> }
  | { k: "lit"; val: JVal }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "%"; left: PathExpr; right: PathExpr };

export type FilterExpr =
  | { k: "or"; left: FilterExpr; right: FilterExpr }
  | { k: "and"; left: FilterExpr; right: FilterExpr }
  | { k: "not"; expr: FilterExpr }
  | { k: "cmp"; op: string; left: FilterExpr; right: FilterExpr }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "%"; left: FilterExpr; right: FilterExpr }
  | { k: "neg"; expr: FilterExpr }
  | { k: "path"; expr: PathExpr }
  | { k: "lit"; val: JVal };

export interface ParsedPath {
  raw: string;
  isV2: boolean;
  expr: PathExpr;
  isRoot: boolean;
  isStatic: boolean;
}

export interface Target {
  kind: "root" | "obj" | "arr" | "computed";
  numericArr?: boolean;
  get: () => JVal;
  set: (v: JVal) => void;
}

const V2_NEXT = new Set([".", "[", "~", " ", "\t", "\n", "\r", "+", "-", "*", "/", "%"]);
const KEYWORD_OPS = ["subsetof", "anyof", "noneof", "empty", "size", "nin", "in"];

function isIdentChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === 0x24;
}

function isDigitChar(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function normalizePath(raw: string) {
  const isV2 = raw === "$" || (raw.startsWith("$") && raw.length > 1 && V2_NEXT.has(raw[1]));
  if (isV2) return { isV2: true as boolean, norm: raw };
  if (raw === ".") return { isV2: false as boolean, norm: "$" };
  if (raw.startsWith(".[")) return { isV2: false as boolean, norm: `$${raw.slice(1)}` };
  if (raw.startsWith(".") || raw.startsWith("[")) return { isV2: false as boolean, norm: `$${raw}` };
  return { isV2: false as boolean, norm: `$.${raw}` };
}

export function parsePath(raw: string): ParsedPath {
  const { isV2, norm } = normalizePath(raw);
  let pos = 0;

  function fail(expected: string, at = pos): never {
    throw new RedisError(`Error occurred at position ${at}, Error at position ${at}: expected one of the following: ${expected}`);
  }

  const skipWs = () => {
    while (pos < norm.length && isWs(norm[pos])) pos++;
  };

  const parseQuoted = (quote: string, errAt: number): string => {
    pos++;
    let out = "";
    while (pos < norm.length) {
      const ch = norm[pos++];
      if (ch === quote) return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      if (pos >= norm.length) fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", errAt);
      const esc = norm[pos++];
      if (esc === quote || esc === "\\" || esc === "/") out += esc;
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "u" && pos + 4 <= norm.length) {
        const hex = norm.slice(pos, pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", errAt);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 4;
      } else {
        out += esc;
      }
    }
    return fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", errAt);
  };

  const parseSignedInt = (): number | undefined => {
    const start = pos;
    if (norm[pos] === "-" || norm[pos] === "+") pos++;
    if (!isDigitChar(norm[pos])) {
      pos = start;
      return undefined;
    }
    while (pos < norm.length && isDigitChar(norm[pos])) pos++;
    return Number.parseInt(norm.slice(start, pos), 10);
  };

  const parseLitNumber = (): JVal | undefined => {
    const start = pos;
    if (norm[pos] === "-") pos++;
    if (!isDigitChar(norm[pos])) {
      pos = start;
      return undefined;
    }
    while (pos < norm.length && isDigitChar(norm[pos])) pos++;
    let isFloat = false;
    if (norm[pos] === "." && isDigitChar(norm[pos + 1])) {
      isFloat = true;
      pos++;
      while (pos < norm.length && isDigitChar(norm[pos])) pos++;
    }
    if (norm[pos] === "e" || norm[pos] === "E") {
      isFloat = true;
      pos++;
      if (norm[pos] === "+" || norm[pos] === "-") pos++;
      if (!isDigitChar(norm[pos])) {
        pos = start;
        return undefined;
      }
      while (pos < norm.length && isDigitChar(norm[pos])) pos++;
    }
    const rawNum = norm.slice(start, pos);
    if (!isFloat && rawNum !== "-0") {
      const n = BigInt(rawNum);
      if (n >= I64_MIN && n <= U64_MAX) return { t: "int", v: n };
    }
    return { t: "float", v: Number(rawNum) };
  };

  const parseJsonLit = (): JVal => {
    skipWs();
    const ch = norm[pos];
    if (ch === '"' || ch === "'") return { t: "str", v: parseQuoted(ch, pos) };
    if (norm.startsWith("true", pos) && !isIdentChar(norm[pos + 4])) {
      pos += 4;
      return { t: "bool", v: true };
    }
    if (norm.startsWith("false", pos) && !isIdentChar(norm[pos + 5])) {
      pos += 5;
      return { t: "bool", v: false };
    }
    if (norm.startsWith("null", pos) && !isIdentChar(norm[pos + 4])) {
      pos += 4;
      return { t: "null" };
    }
    if (ch === "[") {
      pos++;
      skipWs();
      const items: Array<JVal> = [];
      if (norm[pos] === "]") {
        pos++;
        return { t: "arr", v: items };
      }
      while (true) {
        items.push(parseJsonLit());
        skipWs();
        if (norm[pos] === ",") {
          pos++;
          continue;
        }
        if (norm[pos] === "]") {
          pos++;
          return { t: "arr", v: items };
        }
        fail("']'");
      }
    }
    if (ch === "{") {
      pos++;
      skipWs();
      const entries: Array<[string, JVal]> = [];
      if (norm[pos] === "}") {
        pos++;
        return { t: "obj", v: entries };
      }
      while (true) {
        skipWs();
        if (norm[pos] !== '"' && norm[pos] !== "'") fail("key");
        const k = parseQuoted(norm[pos], pos);
        skipWs();
        if (norm[pos] !== ":") fail("':'");
        pos++;
        objSet(entries, k, parseJsonLit());
        skipWs();
        if (norm[pos] === ",") {
          pos++;
          continue;
        }
        if (norm[pos] === "}") {
          pos++;
          return { t: "obj", v: entries };
        }
        fail("'}'");
      }
    }
    const num = parseLitNumber();
    if (num) return num;
    return fail("value");
  };

  const matchOp = (): string | undefined => {
    skipWs();
    for (const sym of ["==", "!=", "<=", ">=", "=~", "<", ">"]) {
      if (norm.startsWith(sym, pos)) {
        pos += sym.length;
        return sym;
      }
    }
    for (const kw of KEYWORD_OPS) {
      if (norm.startsWith(kw, pos) && !isIdentChar(norm[pos + kw.length])) {
        pos += kw.length;
        return kw;
      }
    }
    return undefined;
  };

  const parseFilter = (): FilterExpr => {
    const parseOr = (): FilterExpr => {
      let left = parseAnd();
      while (true) {
        skipWs();
        if (!norm.startsWith("||", pos)) return left;
        pos += 2;
        left = { k: "or", left, right: parseAnd() };
      }
    };

    const parseAnd = (): FilterExpr => {
      let left = parseNot();
      while (true) {
        skipWs();
        if (!norm.startsWith("&&", pos)) return left;
        pos += 2;
        left = { k: "and", left, right: parseNot() };
      }
    };

    const parseNot = (): FilterExpr => {
      skipWs();
      if (norm[pos] === "!" && norm[pos + 1] !== "=") {
        pos++;
        return { k: "not", expr: parseNot() };
      }
      return parseCmp();
    };

    const parseCmp = (): FilterExpr => {
      const left = parseAdd();
      const op = matchOp();
      if (!op) return left;
      return { k: "cmp", op, left, right: parseAdd() };
    };

    const parseAdd = (): FilterExpr => {
      let left = parseMul();
      while (true) {
        skipWs();
        const op = norm[pos];
        if (op !== "+" && op !== "-") return left;
        pos++;
        left = { k: "bin", op, left, right: parseMul() };
      }
    };

    const parseMul = (): FilterExpr => {
      let left = parseUnary();
      while (true) {
        skipWs();
        const op = norm[pos];
        if (op !== "*" && op !== "/" && op !== "%") return left;
        pos++;
        left = { k: "bin", op, left, right: parseUnary() };
      }
    };

    const parseUnary = (): FilterExpr => {
      skipWs();
      if (norm[pos] === "-") {
        pos++;
        return { k: "neg", expr: parseUnary() };
      }
      if (norm[pos] === "+") {
        pos++;
        return parseUnary();
      }
      return parsePrimary();
    };

    const parsePrimary = (): FilterExpr => {
      skipWs();
      const ch = norm[pos];
      if (ch === "(") {
        pos++;
        const inner = parseOr();
        skipWs();
        if (norm[pos] !== ")") fail("')'");
        pos++;
        return inner;
      }
      if (ch === "$" || ch === "@") return { k: "path", expr: parsePathOnly() };
      return { k: "lit", val: parseJsonLit() };
    };

    return parseOr();
  };

  const parseBracket = (): Step => {
    const bracketPos = pos;
    pos++;
    skipWs();
    const ch = norm[pos];
    if (ch === "*") {
      pos++;
      skipWs();
      if (norm[pos] !== "]") fail("']'", bracketPos);
      pos++;
      return { k: "wild" };
    }
    if (ch === "?") {
      pos++;
      skipWs();
      const expr = parseFilter();
      skipWs();
      if (norm[pos] !== "]") fail("']'", bracketPos);
      pos++;
      return { k: "filter", expr };
    }
    if (ch === "'" || ch === '"') {
      const names = [parseQuoted(ch, bracketPos)];
      skipWs();
      while (norm[pos] === ",") {
        pos++;
        skipWs();
        const q = norm[pos];
        if (q !== "'" && q !== '"') fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", bracketPos);
        names.push(parseQuoted(q, bracketPos));
        skipWs();
      }
      if (norm[pos] !== "]") fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", bracketPos);
      pos++;
      return names.length === 1 ? { k: "key", name: names[0] } : { k: "keys", names };
    }
    if (ch === ":" || ch === "-" || isDigitChar(ch)) {
      const firstPos = pos;
      const first = parseSignedInt();
      skipWs();
      if (norm[pos] === ":") {
        pos++;
        skipWs();
        const end = parseSignedInt();
        skipWs();
        let step = 1;
        if (norm[pos] === ":") {
          pos++;
          skipWs();
          const stepPos = pos;
          const parsedStep = parseSignedInt();
          if (parsedStep !== undefined) {
            if (parsedStep <= 0) fail("pos_number", stepPos);
            step = parsedStep;
          } else if (norm[pos] !== "]") {
            fail("pos_number", stepPos);
          }
          skipWs();
        }
        if (norm[pos] !== "]") fail("EOI, add, sub, mul, div, rem, postfix_method, get_keys_op, '..'", bracketPos);
        pos++;
        return { k: "slice", start: first, end, step };
      }
      if (first === undefined) fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", firstPos);
      const indices = [first];
      while (norm[pos] === ",") {
        pos++;
        skipWs();
        const n = parseSignedInt();
        if (n === undefined) fail("'<number>'", bracketPos);
        indices.push(n);
        skipWs();
      }
      if (norm[pos] !== "]") fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", bracketPos);
      pos++;
      return indices.length === 1 ? { k: "index", index: indices[0] } : { k: "indices", indices };
    }
    return fail("'<string>[,<string>,...]', '<number>', ['start:end:steps'], '*'", pos);
  };

  const parseMemberOrFunc = (): Step => {
    if (norm[pos] === "*") {
      pos++;
      return { k: "wild" };
    }
    const start = pos;
    while (pos < norm.length && isIdentChar(norm[pos])) pos++;
    if (pos === start) fail("<string>, function_name, '*'");
    const name = norm.slice(start, pos);
    if (norm[pos] !== "(") return { k: "key", name };
    pos++;
    skipWs();
    if (norm[pos] === ")") {
      pos++;
      return { k: "func", name, arg: undefined };
    }
    const arg = parseJsonLit();
    skipWs();
    if (norm[pos] !== ")") fail("')'");
    pos++;
    return { k: "func", name, arg };
  };

  const parsePathOnly = (): PathExpr => {
    const root: "$" | "@" = norm[pos] === "@" ? "@" : "$";
    pos++;
    const steps: Array<Step> = [];
    while (pos < norm.length) {
      const ch = norm[pos];
      if (ch === ".") {
        pos++;
        if (norm[pos] === ".") {
          pos++;
          const step = norm[pos] === "[" ? parseBracket() : parseMemberOrFunc();
          steps.push({ k: "descend", step });
          continue;
        }
        steps.push(parseMemberOrFunc());
        continue;
      }
      if (ch === "[") {
        steps.push(parseBracket());
        continue;
      }
      if (ch === "~") {
        pos++;
        steps.push({ k: "getKeys" });
        continue;
      }
      break;
    }
    return { k: "path", root, steps };
  };

  const parseTopAdd = (): PathExpr => {
    let left = parseTopMul();
    while (true) {
      skipWs();
      const op = norm[pos];
      if (op !== "+" && op !== "-") return left;
      pos++;
      left = { k: "bin", op, left, right: parseTopMul() };
    }
  };

  const parseTopMul = (): PathExpr => {
    let left = parseTopAtom();
    while (true) {
      skipWs();
      const op = norm[pos];
      if (op !== "*" && op !== "/" && op !== "%") return left;
      pos++;
      left = { k: "bin", op, left, right: parseTopAtom() };
    }
  };

  const parseTopAtom = (): PathExpr => {
    skipWs();
    if (norm[pos] === "$") return parsePathOnly();
    const num = parseLitNumber();
    if (num) return { k: "lit", val: num };
    return fail("'$'");
  };

  const expr = parseTopAdd();
  skipWs();
  if (pos < norm.length) fail("EOI, add, sub, mul, div, rem, postfix_method, get_keys_op, '..'");

  const isRoot = expr.k === "path" && expr.steps.length === 0;
  const isStatic = expr.k === "path" && expr.steps.every((s) => s.k === "key" || s.k === "index");
  return { raw, isV2, expr, isRoot, isStatic };
}

function sliceBounds(len: number, start: number | undefined, end: number | undefined): [number, number] {
  const s0 = start === undefined ? 0 : start < 0 ? len + start : start;
  const e0 = end === undefined ? len : end < 0 ? len + end : end;
  const s = Math.max(0, Math.min(len, s0));
  const e = Math.max(0, Math.min(len, e0));
  return [s, e];
}

function arrTarget(arr: Array<JVal>, idx: number): Target {
  const numericArr = arr.every((x) => x.t === "int" || x.t === "float");
  return { kind: "arr", numericArr, get: () => arr[idx], set: (v) => { arr[idx] = v; } };
}

function objTarget(entries: Array<[string, JVal]>, key: string): Target {
  return { kind: "obj", get: () => objGet(entries, key) ?? { t: "null" }, set: (v) => objSet(entries, key, v) };
}

function computedTarget(v: JVal): Target {
  return { kind: "computed", get: () => v, set: () => {} };
}

function applyFunc(v: JVal, name: string): Target | undefined {
  if (name === "length") {
    if (v.t === "arr" || v.t === "obj") return computedTarget({ t: "int", v: BigInt(v.v.length) });
    if (v.t === "str") return computedTarget({ t: "int", v: BigInt(utf8Len(v.v)) });
    return undefined;
  }
  if (v.t !== "arr" || !v.v.length) return undefined;
  const nums = v.v.map(jNum);
  if (nums.some(Number.isNaN)) return undefined;
  if (name === "min") return computedTarget({ t: "float", v: Math.min(...nums) });
  if (name === "max") return computedTarget({ t: "float", v: Math.max(...nums) });
  const sum = nums.reduce((a, b) => a + b, 0);
  if (name === "sum") return computedTarget({ t: "float", v: sum });
  const avg = sum / nums.length;
  if (name === "avg") return computedTarget({ t: "float", v: avg });
  if (name === "stddev") {
    const variance = nums.reduce((a, b) => a + (b - avg) ** 2, 0) / nums.length;
    return computedTarget({ t: "float", v: Math.sqrt(variance) });
  }
  return undefined;
}

function evalNumOp(op: "+" | "-" | "*" | "/" | "%", a: JVal, b: JVal): JVal | undefined {
  if ((a.t !== "int" && a.t !== "float") || (b.t !== "int" && b.t !== "float")) return undefined;
  if (op !== "/" && a.t === "int" && b.t === "int") {
    if (op === "%") {
      if (b.v === 0n) return undefined;
      return { t: "int", v: a.v % b.v };
    }
    const res = op === "+" ? a.v + b.v : op === "-" ? a.v - b.v : a.v * b.v;
    if (res >= I64_MIN && res <= I64_MAX) return { t: "int", v: res };
  }
  const res = op === "+" ? jNum(a) + jNum(b) : op === "-" ? jNum(a) - jNum(b) : op === "*" ? jNum(a) * jNum(b) : op === "/" ? jNum(a) / jNum(b) : jNum(a) % jNum(b);
  return Number.isFinite(res) ? { t: "float", v: res } : undefined;
}

function compileRegex(pat: string): RegExp | undefined {
  let flags = "";
  let body = pat;
  const m = /^\(\?([imsux-]+)\)/.exec(body);
  if (m) {
    for (const ch of m[1]) if (ch === "i" || ch === "m" || ch === "s") flags += ch;
    body = body.slice(m[0].length);
  }
  try {
    return new RegExp(body, flags);
  } catch {
    return undefined;
  }
}

function cmpValues(op: string, l: JVal, r: JVal): boolean {
  if (op === "==") return jFilterEq(l, r);
  if (op === "<" || op === "<=" || op === ">" || op === ">=") {
    if ((l.t === "int" || l.t === "float") && (r.t === "int" || r.t === "float")) {
      if (l.t === "int" && r.t === "int") {
        if (op === "<") return l.v < r.v;
        if (op === "<=") return l.v <= r.v;
        return op === ">" ? l.v > r.v : l.v >= r.v;
      }
      const a = jNum(l);
      const b = jNum(r);
      if (op === "<") return a < b;
      if (op === "<=") return a <= b;
      return op === ">" ? a > b : a >= b;
    }
    if (l.t === "str" && r.t === "str") {
      if (op === "<") return l.v < r.v;
      if (op === "<=") return l.v <= r.v;
      return op === ">" ? l.v > r.v : l.v >= r.v;
    }
    return false;
  }
  if (op === "=~") {
    if (l.t !== "str" || r.t !== "str") return false;
    return compileRegex(r.v)?.test(l.v) ?? false;
  }
  if (op === "in") return r.t === "arr" && r.v.some((x) => jFilterEq(l, x));
  if (op === "nin") return r.t === "arr" && !r.v.some((x) => jFilterEq(l, x));
  if (op === "subsetof") return l.t === "arr" && r.t === "arr" && l.v.every((x) => r.v.some((y) => jFilterEq(x, y)));
  if (op === "anyof") return l.t === "arr" && r.t === "arr" && l.v.some((x) => r.v.some((y) => jFilterEq(x, y)));
  if (op === "size") {
    if (r.t !== "int" && r.t !== "float") return false;
    const len = l.t === "arr" || l.t === "obj" ? l.v.length : l.t === "str" ? utf8Len(l.v) : -1;
    return len >= 0 && len === jNum(r);
  }
  if (op === "empty") {
    if (r.t !== "bool") return false;
    const len = l.t === "arr" || l.t === "obj" ? l.v.length : l.t === "str" ? utf8Len(l.v) : -1;
    return len >= 0 && (len === 0) === r.v;
  }
  return false;
}

function evalFilterVals(expr: FilterExpr, root: JVal, cur: JVal): Array<JVal> {
  if (expr.k === "lit") return [expr.val];
  if (expr.k === "path") return evalExprTargets(expr.expr, root, cur).map((t) => t.get());
  if (expr.k === "neg") {
    const vals = evalFilterVals(expr.expr, root, cur);
    if (!vals.length) return [];
    const v = vals[0];
    if (v.t === "int") return [{ t: "int", v: -v.v }];
    if (v.t === "float") return [{ t: "float", v: -v.v }];
    return [];
  }
  if (expr.k === "bin") {
    const lv = evalFilterVals(expr.left, root, cur);
    const rv = evalFilterVals(expr.right, root, cur);
    if (!lv.length || !rv.length) return [];
    const res = evalNumOp(expr.op, lv[0], rv[0]);
    return res ? [res] : [];
  }
  return [{ t: "bool", v: evalFilterBool(expr, root, cur) }];
}

function evalFilterBool(expr: FilterExpr, root: JVal, cur: JVal): boolean {
  if (expr.k === "or") return evalFilterBool(expr.left, root, cur) || evalFilterBool(expr.right, root, cur);
  if (expr.k === "and") return evalFilterBool(expr.left, root, cur) && evalFilterBool(expr.right, root, cur);
  if (expr.k === "not") return !evalFilterBool(expr.expr, root, cur);
  if (expr.k === "lit") return expr.val.t === "bool" ? expr.val.v : true;
  if (expr.k === "cmp") {
    const lv = evalFilterVals(expr.left, root, cur);
    const rv = evalFilterVals(expr.right, root, cur);
    if (expr.op === "noneof") {
      const r0 = rv[0];
      if (!r0 || r0.t !== "arr") return false;
      if (!lv.length) return true;
      return lv[0].t !== "arr" || !lv[0].v.some((x) => r0.v.some((y) => jFilterEq(x, y)));
    }
    if (expr.op === "!=") {
      if (!lv.length || !rv.length) return lv.length !== rv.length;
      return !jFilterEq(lv[0], rv[0]);
    }
    if (!lv.length || !rv.length) return false;
    return lv.some((l) => rv.some((r) => cmpValues(expr.op, l, r)));
  }
  return evalFilterVals(expr, root, cur).length > 0;
}

function stepTarget(t: Target, step: Step, root: JVal, out: Array<Target>): void {
  const v = t.get();
  if (step.k === "key") {
    if (v.t === "obj" && objFind(v.v, step.name) !== -1) out.push(objTarget(v.v, step.name));
    return;
  }
  if (step.k === "keys") {
    if (v.t === "obj") for (const name of step.names) if (objFind(v.v, name) !== -1) out.push(objTarget(v.v, name));
    return;
  }
  if (step.k === "index") {
    if (v.t !== "arr" || !v.v.length) return;
    const idx = step.index < 0 ? Math.max(0, v.v.length + step.index) : step.index;
    if (idx < v.v.length) out.push(arrTarget(v.v, idx));
    return;
  }
  if (step.k === "indices") {
    if (v.t !== "arr" || !v.v.length) return;
    for (const rawIdx of step.indices) {
      const idx = rawIdx < 0 ? Math.max(0, v.v.length + rawIdx) : rawIdx;
      if (idx < v.v.length) out.push(arrTarget(v.v, idx));
    }
    return;
  }
  if (step.k === "slice") {
    if (v.t !== "arr") return;
    const [s, e] = sliceBounds(v.v.length, step.start, step.end);
    for (let i = s; i < e; i += step.step) out.push(arrTarget(v.v, i));
    return;
  }
  if (step.k === "wild") {
    if (v.t === "obj") for (const [k] of v.v) out.push(objTarget(v.v, k));
    else if (v.t === "arr") for (let i = 0; i < v.v.length; i++) out.push(arrTarget(v.v, i));
    return;
  }
  if (step.k === "filter") {
    if (v.t === "arr") {
      for (let i = 0; i < v.v.length; i++) if (evalFilterBool(step.expr, root, v.v[i])) out.push(arrTarget(v.v, i));
    } else if (v.t === "obj") {
      for (const [k, child] of v.v) if (evalFilterBool(step.expr, root, child)) out.push(objTarget(v.v, k));
    }
    return;
  }
  if (step.k === "descend") {
    stepTarget(t, step.step, root, out);
    if (v.t === "obj") for (const [k] of v.v) stepTarget(objTarget(v.v, k), step, root, out);
    else if (v.t === "arr") for (let i = 0; i < v.v.length; i++) stepTarget(arrTarget(v.v, i), step, root, out);
    return;
  }
  if (step.k === "getKeys") {
    if (v.t === "obj") for (const [k] of v.v) out.push(computedTarget({ t: "str", v: k }));
    return;
  }
  if (step.name === "keys") {
    if (v.t === "obj") for (const [k] of v.v) out.push(computedTarget({ t: "str", v: k }));
    return;
  }
  const fnRes = applyFunc(v, step.name);
  if (fnRes) out.push(fnRes);
}

function evalSteps(root: JVal, cur: JVal, steps: Array<Step>, onRoot: (v: JVal) => void): Array<Target> {
  let current: Array<Target> = [{ kind: "root", get: () => cur, set: onRoot }];
  for (const step of steps) {
    const next: Array<Target> = [];
    for (const t of current) stepTarget(t, step, root, next);
    current = next;
  }
  return current;
}

function evalExprTargets(expr: PathExpr, root: JVal, cur: JVal, onRoot: (v: JVal) => void = () => {}): Array<Target> {
  if (expr.k === "lit") return [computedTarget(expr.val)];
  if (expr.k === "bin") {
    const lv = evalExprTargets(expr.left, root, cur);
    const rv = evalExprTargets(expr.right, root, cur);
    if (!lv.length || !rv.length) return [];
    const res = evalNumOp(expr.op, lv[0].get(), rv[0].get());
    return res ? [computedTarget(res)] : [];
  }
  const base = expr.root === "$" ? root : cur;
  return evalSteps(root, base, expr.steps, onRoot);
}

export function evalTargets(doc: JVal, parsed: ParsedPath, onRoot: (v: JVal) => void = () => {}): Array<Target> {
  return evalExprTargets(parsed.expr, doc, doc, onRoot);
}

export function evalValues(doc: JVal, parsed: ParsedPath): Array<JVal> {
  return evalTargets(doc, parsed).map((t) => t.get());
}

function deleteFromNode(node: JVal, step: Step, root: JVal): number {
  if (step.k === "descend") {
    let deleted = deleteFromNode(node, step.step, root);
    if (node.t === "obj") for (const [, child] of node.v) deleted += deleteFromNode(child, step, root);
    else if (node.t === "arr") for (const child of node.v) deleted += deleteFromNode(child, step, root);
    return deleted;
  }
  if (node.t === "obj") {
    if (step.k === "key") return objDelete(node.v, step.name) ? 1 : 0;
    if (step.k === "keys") {
      let deleted = 0;
      for (const name of step.names) if (objDelete(node.v, name)) deleted++;
      return deleted;
    }
    if (step.k === "wild") {
      const n = node.v.length;
      node.v.length = 0;
      return n;
    }
    if (step.k === "filter") {
      const doomed = node.v.filter(([, child]) => evalFilterBool(step.expr, root, child)).map(([k]) => k);
      for (const k of doomed) objDelete(node.v, k);
      return doomed.length;
    }
    return 0;
  }
  if (node.t === "arr") {
    const indices: Array<number> = [];
    if (step.k === "index") {
      if (node.v.length) {
        const idx = step.index < 0 ? Math.max(0, node.v.length + step.index) : step.index;
        if (idx < node.v.length) indices.push(idx);
      }
    } else if (step.k === "indices") {
      if (node.v.length) {
        for (const rawIdx of step.indices) {
          const idx = rawIdx < 0 ? Math.max(0, node.v.length + rawIdx) : rawIdx;
          if (idx < node.v.length) indices.push(idx);
        }
      }
    } else if (step.k === "slice") {
      const [s, e] = sliceBounds(node.v.length, step.start, step.end);
      for (let i = s; i < e; i += step.step) indices.push(i);
    } else if (step.k === "wild") {
      const n = node.v.length;
      node.v.length = 0;
      return n;
    } else if (step.k === "filter") {
      for (let i = 0; i < node.v.length; i++) if (evalFilterBool(step.expr, root, node.v[i])) indices.push(i);
    }
    indices.sort((a, b) => b - a);
    let deleted = 0;
    for (const idx of indices) {
      if (idx < node.v.length) {
        node.v.splice(idx, 1);
        deleted++;
      }
    }
    return deleted;
  }
  return 0;
}

export function deleteAtPath(doc: JVal, parsed: ParsedPath): number {
  if (parsed.expr.k !== "path" || !parsed.expr.steps.length) return 0;
  const steps = parsed.expr.steps;
  const parents = evalSteps(doc, doc, steps.slice(0, -1), () => {});
  const last = steps.at(-1);
  if (!last) return 0;
  let deleted = 0;
  for (const p of parents) deleted += deleteFromNode(p.get(), last, doc);
  return deleted;
}

export function setAtPath(doc: JVal, parsed: ParsedPath, val: JVal, cond?: "NX" | "XX", onMutate?: (t: Target) => JVal): boolean {
  if (parsed.expr.k !== "path") throw new RedisError("ERR wrong static path");
  const targets = evalTargets(doc, parsed);
  if (targets.length > 0) {
    if (cond === "NX") {
      if (!parsed.isStatic) throw new RedisError("ERR wrong static path");
      return false;
    }
    for (const t of targets) {
      if (t.kind === "computed") throw new RedisError("ERR wrong static path");
      t.set(onMutate ? onMutate(t) : jClone(val));
    }
    return true;
  }
  if (cond === "XX") return false;
  if (!parsed.isStatic) throw new RedisError("ERR wrong static path");
  const steps = parsed.expr.steps;
  const parents = evalSteps(doc, doc, steps.slice(0, -1), () => {});
  if (!parents.length) return false;
  const parent = parents[0].get();
  const last = steps.at(-1);
  if (!last) return false;
  if (last.k === "key") {
    if (parent.t !== "obj") return false;
    objSet(parent.v, last.name, jClone(val));
    return true;
  }
  if (last.k === "index") throw new RedisError("ERR array index out of range");
  return false;
}
