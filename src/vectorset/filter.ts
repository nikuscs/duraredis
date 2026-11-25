import { RedisError, text } from "../resp/reply";

type FilterValue =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "null" }
  | { t: "arr"; v: Array<FilterValue> };

type OpCode = "or" | "and" | "not" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "in" | "add" | "sub" | "mul" | "div" | "mod" | "pow";

type Instruction =
  | { t: "val"; v: FilterValue }
  | { t: "sel"; key: string }
  | { t: "op"; op: OpCode };

interface OpMeta {
  code: OpCode;
  prec: number;
  unary: boolean;
  rightAssoc: boolean;
}

type StackToken =
  | { t: "lparen" }
  | ({ t: "op" } & OpMeta);

interface ParsedString {
  val: string;
  next: number;
}

interface ParsedNumber {
  val: number;
  next: number;
}

interface ParsedArray {
  items: Array<FilterValue>;
  next: number;
}

export interface CompiledFilter {
  ops: Array<Instruction>;
  hasSelectors: boolean;
}

const OP_META = new Map<string, OpMeta>(Object.entries({
  or: { code: "or", prec: 1, unary: false, rightAssoc: false },
  "||": { code: "or", prec: 1, unary: false, rightAssoc: false },
  and: { code: "and", prec: 2, unary: false, rightAssoc: false },
  "&&": { code: "and", prec: 2, unary: false, rightAssoc: false },
  "==": { code: "eq", prec: 3, unary: false, rightAssoc: false },
  "!=": { code: "ne", prec: 3, unary: false, rightAssoc: false },
  "<": { code: "lt", prec: 3, unary: false, rightAssoc: false },
  "<=": { code: "le", prec: 3, unary: false, rightAssoc: false },
  ">": { code: "gt", prec: 3, unary: false, rightAssoc: false },
  ">=": { code: "ge", prec: 3, unary: false, rightAssoc: false },
  in: { code: "in", prec: 3, unary: false, rightAssoc: false },
  "+": { code: "add", prec: 4, unary: false, rightAssoc: false },
  "-": { code: "sub", prec: 4, unary: false, rightAssoc: false },
  "*": { code: "mul", prec: 5, unary: false, rightAssoc: false },
  "/": { code: "div", prec: 5, unary: false, rightAssoc: false },
  "%": { code: "mod", prec: 5, unary: false, rightAssoc: false },
  "**": { code: "pow", prec: 6, unary: false, rightAssoc: true },
  "!": { code: "not", prec: 7, unary: true, rightAssoc: false },
  not: { code: "not", prec: 7, unary: true, rightAssoc: false },
} satisfies Record<string, OpMeta>));

const NUM_RE = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i;
const SEL_CHAR_RE = /[A-Za-z0-9_-]/;
const ALPHA_RE = /^[A-Za-z]+/;
const LEADING_FLOAT_RE = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

function syntaxError(near: string): never {
  throw new RedisError(`ERR syntax error in FILTER expression near: ${near}`);
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function skipSpace(s: string, i: number): number {
  let pos = i;
  while (pos < s.length && isSpace(s[pos])) pos++;
  return pos;
}

function readString(expr: string, start: number): ParsedString {
  const quote = expr[start];
  let out = "";
  let i = start + 1;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "\\" && i + 1 < expr.length) {
      out += ch + expr[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { val: out, next: i + 1 };
    out += ch;
    i++;
  }
  syntaxError(expr.slice(start));
}

function readNumber(expr: string, start: number, allowNeg: boolean): ParsedNumber | undefined {
  let i = start;
  let neg = false;
  if (allowNeg && expr[i] === "-") {
    neg = true;
    i++;
  }
  const m = NUM_RE.exec(expr.slice(i));
  if (!m) return undefined;
  const end = i + m[0].length;
  const raw = Number(m[0]);
  return { val: neg ? -raw : raw, next: end };
}

function readArray(expr: string, start: number): ParsedArray {
  let i = skipSpace(expr, start + 1);
  const items: Array<FilterValue> = [];
  if (i < expr.length && expr[i] === "]") return { items, next: i + 1 };
  while (i < expr.length) {
    if (expr[i] === '"' || expr[i] === "'") {
      const str = readString(expr, i);
      items.push({ t: "str", v: str.val });
      i = skipSpace(expr, str.next);
    } else {
      const num = readNumber(expr, i, true);
      if (!num) syntaxError(expr.slice(i));
      items.push({ t: "num", v: num.val });
      i = skipSpace(expr, num.next);
    }
    if (i < expr.length && expr[i] === "]") return { items, next: i + 1 };
    if (i >= expr.length || expr[i] !== ",") syntaxError(expr.slice(i));
    i = skipSpace(expr, i + 1);
    if (i < expr.length && expr[i] === "]") return { items, next: i + 1 };
  }
  syntaxError(expr.slice(start));
}

function validateStack(ops: Array<Instruction>, expr: string) {
  let depth = 0;
  for (const ins of ops) {
    if (ins.t === "val" || ins.t === "sel") {
      depth++;
      continue;
    }
    if (ins.op === "not") {
      if (depth < 1) syntaxError(expr);
      continue;
    }
    if (depth < 2) syntaxError(expr);
    depth--;
  }
  if (depth !== 1) syntaxError(expr);
}

export function compileFilter(expr: string): CompiledFilter {
  const out: Array<Instruction> = [];
  const stack: Array<StackToken> = [];
  let hasSelectors = false;
  let prevKind: "start" | "val" | "lparen" | "binop" | "not" = "start";
  let i = skipSpace(expr, 0);
  if (i >= expr.length) syntaxError(expr);

  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "(") {
      if (prevKind === "val") syntaxError(expr);
      stack.push({ t: "lparen" });
      prevKind = "lparen";
      i = skipSpace(expr, i + 1);
      continue;
    }
    if (ch === ")") {
      if (prevKind !== "val") syntaxError(expr);
      while (stack.length) {
        const peek = stack.at(-1);
        if (!peek || peek.t === "lparen") break;
        stack.pop();
        out.push({ t: "op", op: peek.code });
      }
      if (!stack.length) syntaxError(expr);
      stack.pop();
      prevKind = "val";
      i = skipSpace(expr, i + 1);
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (prevKind === "val") syntaxError(expr);
      const str = readString(expr, i);
      out.push({ t: "val", v: { t: "str", v: str.val } });
      prevKind = "val";
      i = skipSpace(expr, str.next);
      continue;
    }
    if (ch === "[") {
      if (prevKind === "val") syntaxError(expr);
      const arr = readArray(expr, i);
      out.push({ t: "val", v: { t: "arr", v: arr.items } });
      prevKind = "val";
      i = skipSpace(expr, arr.next);
      continue;
    }
    if (ch === ".") {
      if (prevKind === "val") syntaxError(expr);
      let end = i + 1;
      while (end < expr.length && SEL_CHAR_RE.test(expr[end])) end++;
      if (end === i + 1) syntaxError(expr);
      out.push({ t: "sel", key: expr.slice(i + 1, end) });
      hasSelectors = true;
      prevKind = "val";
      i = skipSpace(expr, end);
      continue;
    }
    const num = readNumber(expr, i, prevKind !== "val");
    if (num) {
      if (prevKind === "val") syntaxError(expr);
      out.push({ t: "val", v: { t: "num", v: num.val } });
      prevKind = "val";
      i = skipSpace(expr, num.next);
      continue;
    }
    let sym = "";
    const two = expr.slice(i, i + 2);
    if (OP_META.has(two)) sym = two;
    else if (OP_META.has(ch)) sym = ch;
    else {
      const m = ALPHA_RE.exec(expr.slice(i));
      if (m) sym = m[0];
    }
    if (!sym) {
      const rest = expr.slice(i + 1);
      syntaxError(rest.length ? rest : expr);
    }
    if (sym === "null") {
      if (prevKind === "val") syntaxError(expr);
      out.push({ t: "val", v: { t: "null" } });
      prevKind = "val";
      i = skipSpace(expr, i + sym.length);
      continue;
    }
    const meta = OP_META.get(sym);
    if (!meta) {
      const rest = expr.slice(i + sym.length);
      syntaxError(rest.length ? rest : expr);
    }
    if (meta.unary) {
      if (prevKind === "not") syntaxError(expr);
      while (stack.length) {
        const top = stack.at(-1);
        if (!top || top.t !== "op" || top.prec <= meta.prec) break;
        stack.pop();
        out.push({ t: "op", op: top.code });
      }
      stack.push({ t: "op", ...meta });
      prevKind = prevKind === "val" ? "val" : "not";
      i = skipSpace(expr, i + sym.length);
      continue;
    }
    if (prevKind !== "val") syntaxError(expr);
    while (stack.length) {
      const top = stack.at(-1);
      if (!top || top.t !== "op") break;
      if (top.prec < meta.prec || (top.prec === meta.prec && meta.rightAssoc)) break;
      stack.pop();
      out.push({ t: "op", op: top.code });
    }
    stack.push({ t: "op", ...meta });
    prevKind = "binop";
    i = skipSpace(expr, i + sym.length);
  }

  while (stack.length) {
    const top = stack.pop();
    if (!top || top.t === "lparen") syntaxError(expr);
    out.push({ t: "op", op: top.code });
  }
  validateStack(out, expr);
  return { ops: out, hasSelectors };
}

function toFilterValue(v: unknown): FilterValue | undefined {
  if (v === null) return { t: "null" };
  if (typeof v === "number") return { t: "num", v };
  if (typeof v === "boolean") return { t: "num", v: v ? 1 : 0 };
  if (typeof v === "string") return { t: "str", v };
  if (Array.isArray(v)) {
    const items: Array<FilterValue> = [];
    for (const item of v) {
      const converted = toFilterValue(item);
      if (converted) items.push(converted);
    }
    return { t: "arr", v: items };
  }
  return undefined;
}

function toNum(v: FilterValue): number {
  if (v.t === "num") return v.v;
  if (v.t === "str") {
    const m = LEADING_FLOAT_RE.exec(v.v);
    return m ? Number(m[0]) : 0;
  }
  return 0;
}

function toBool(v: FilterValue): boolean {
  if (v.t === "num") return v.v !== 0;
  if (v.t === "str") return v.v.length > 0;
  if (v.t === "null") return false;
  return true;
}

function valEquals(a: FilterValue, b: FilterValue): boolean {
  if (a.t === "null" || b.t === "null") return a.t === "null" && b.t === "null";
  if (a.t === "str" && b.t === "str") return a.v === b.v;
  return toNum(a) === toNum(b);
}

function applyBinary(op: Exclude<OpCode, "not">, a: FilterValue, b: FilterValue): FilterValue {
  switch (op) {
    case "or": return { t: "num", v: toBool(a) || toBool(b) ? 1 : 0 };
    case "and": return { t: "num", v: toBool(a) && toBool(b) ? 1 : 0 };
    case "eq": return { t: "num", v: valEquals(a, b) ? 1 : 0 };
    case "ne": return { t: "num", v: valEquals(a, b) ? 0 : 1 };
    case "lt": return { t: "num", v: toNum(a) < toNum(b) ? 1 : 0 };
    case "le": return { t: "num", v: toNum(a) <= toNum(b) ? 1 : 0 };
    case "gt": return { t: "num", v: toNum(a) > toNum(b) ? 1 : 0 };
    case "ge": return { t: "num", v: toNum(a) >= toNum(b) ? 1 : 0 };
    case "in":
      if (b.t === "arr") return { t: "num", v: b.v.some((item) => valEquals(a, item)) ? 1 : 0 };
      if (b.t === "str" && a.t === "str") return { t: "num", v: b.v.includes(a.v) ? 1 : 0 };
      return { t: "num", v: 0 };
    case "add": return { t: "num", v: toNum(a) + toNum(b) };
    case "sub": return { t: "num", v: toNum(a) - toNum(b) };
    case "mul": return { t: "num", v: toNum(a) * toNum(b) };
    case "div": return { t: "num", v: toNum(a) / toNum(b) };
    case "mod": return { t: "num", v: toNum(a) % toNum(b) };
    case "pow": return { t: "num", v: toNum(a) ** toNum(b) };
  }
}

export function evalFilter(program: CompiledFilter, attrs: Uint8Array | null): boolean {
  if (attrs === null || attrs.length === 0) return false;
  let obj: Map<string, unknown> | null = null;
  if (program.hasSelectors) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text(attrs));
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    obj = new Map(Object.entries(parsed));
  }
  const stack: Array<FilterValue> = [];
  for (const ins of program.ops) {
    if (ins.t === "val") {
      stack.push(ins.v);
      continue;
    }
    if (ins.t === "sel") {
      if (!obj || !obj.has(ins.key)) return false;
      const v = toFilterValue(obj.get(ins.key));
      if (!v) return false;
      stack.push(v);
      continue;
    }
    if (ins.op === "not") {
      const a = stack.pop();
      if (!a) return false;
      stack.push({ t: "num", v: toBool(a) ? 0 : 1 });
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    if (!a || !b) return false;
    stack.push(applyBinary(ins.op, a, b));
  }
  const res = stack[0];
  return res ? toBool(res) : false;
}
