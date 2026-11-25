import { RedisError } from "../resp/reply";

type AssertKind = "bol" | "eol" | "wb" | "nwb";

type Ast =
  | { t: "empty" }
  | { t: "any" }
  | { t: "mask"; mask: Uint32Array }
  | { t: "assert"; kind: AssertKind }
  | { t: "seq"; items: Array<Ast> }
  | { t: "alt"; branches: Array<Ast> }
  | { t: "rep"; inner: Ast; min: number; max: number | null };

type State =
  | { t: "match" }
  | { t: "any"; out: number }
  | { t: "mask"; mask: Uint32Array; out: number }
  | { t: "assert"; kind: AssertKind; out: number }
  | { t: "split"; a: number; b: number };

const MAX_STATES = 100_000;
const HEX = new Set(Array.from("0123456789abcdefABCDEF").map((c) => c.charCodeAt(0)));

const errInvalid = (msg: string) => new RedisError(`ERR invalid regular expression: ${msg}`);

function isWordByte(b: number): boolean {
  return (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95;
}

function setBit(mask: Uint32Array, b: number) {
  mask[b >>> 5] |= 1 << (b & 31);
}

function hasBit(mask: Uint32Array, b: number): boolean {
  return (mask[b >>> 5] & (1 << (b & 31))) !== 0;
}

function setChar(mask: Uint32Array, b: number, icase: boolean) {
  setBit(mask, b);
  if (!icase) return;
  if (b >= 65 && b <= 90) setBit(mask, b + 32);
  else if (b >= 97 && b <= 122) setBit(mask, b - 32);
}

function setRange(mask: Uint32Array, lo: number, hi: number, icase: boolean) {
  if (lo > hi) throw errInvalid("Invalid character range");
  for (let c = lo; c <= hi; c++) setChar(mask, c, icase);
}

function invertMask(mask: Uint32Array): Uint32Array {
  for (let i = 0; i < 8; i++) mask[i] = ~mask[i];
  return mask;
}

function addBuiltinClass(mask: Uint32Array, code: number) {
  const neg = code === 68 || code === 87 || code === 83;
  const lower = code | 32;
  const tmp = new Uint32Array(8);
  if (lower === 100) {
    setRange(tmp, 48, 57, false);
  } else if (lower === 119) {
    setRange(tmp, 48, 57, false);
    setRange(tmp, 65, 90, false);
    setRange(tmp, 97, 122, false);
    setBit(tmp, 95);
  } else {
    for (const c of [9, 10, 11, 12, 13, 32]) setBit(tmp, c);
  }
  if (neg) invertMask(tmp);
  for (let i = 0; i < 8; i++) mask[i] = (mask[i] | tmp[i]) >>> 0;
}

function addPosixClass(mask: Uint32Array, name: string, icase: boolean): boolean {
  const ranges = (pairs: Array<[number, number]>) => {
    for (const [lo, hi] of pairs) setRange(mask, lo, hi, icase);
  };
  switch (name) {
    case "digit":
      ranges([[48, 57]]);
      return true;
    case "lower":
      ranges([[97, 122]]);
      return true;
    case "upper":
      ranges([[65, 90]]);
      return true;
    case "alpha":
      ranges([[65, 90], [97, 122]]);
      return true;
    case "alnum":
      ranges([[48, 57], [65, 90], [97, 122]]);
      return true;
    case "xdigit":
      ranges([[48, 57], [65, 70], [97, 102]]);
      return true;
    case "blank":
      setBit(mask, 9);
      setBit(mask, 32);
      return true;
    case "space":
      for (const c of [9, 10, 11, 12, 13, 32]) setBit(mask, c);
      return true;
    case "cntrl":
      ranges([[0, 31]]);
      setBit(mask, 127);
      return true;
    case "punct":
      ranges([[33, 47], [58, 64], [91, 96], [123, 126]]);
      return true;
    case "graph":
      ranges([[33, 126]]);
      return true;
    case "print":
      ranges([[32, 126]]);
      return true;
    default:
      return false;
  }
}

function singleEscape(pat: Uint8Array, pos: number): [number, number] {
  if (pos >= pat.length) throw errInvalid("Trailing backslash");
  const c = pat[pos];
  if (c >= 49 && c <= 57) throw new RedisError("ERR regular expression backreferences are not supported");
  if (c === 116) return [9, pos + 1];
  if (c === 110) return [10, pos + 1];
  if (c === 114) return [13, pos + 1];
  if (c === 102) return [12, pos + 1];
  if (c === 118) return [11, pos + 1];
  if (c === 120 && pos + 2 < pat.length && HEX.has(pat[pos + 1]) && HEX.has(pat[pos + 2])) {
    const val = Number.parseInt(String.fromCharCode(pat[pos + 1], pat[pos + 2]), 16);
    return [val, pos + 3];
  }
  return [c, pos + 1];
}

function popRepeatable(items: Array<Ast>): Ast {
  const last = items.at(-1);
  if (!last || (last.t === "assert" && (last.kind === "bol" || last.kind === "eol"))) return { t: "empty" };
  return items.pop() ?? { t: "empty" };
}

class Parser {
  pos = 0;

  constructor(private readonly pat: Uint8Array, private readonly baseIcase: boolean) {}

  parse(): Ast {
    const ast = this.parseAlt(0, this.baseIcase);
    return ast;
  }

  private parseAlt(depth: number, icase: boolean): Ast {
    const branches: Array<Ast> = [this.parseSeq(depth, icase)];
    while (this.pos < this.pat.length && this.pat[this.pos] === 124) {
      this.pos++;
      branches.push(this.parseSeq(depth, icase));
    }
    return branches.length === 1 ? branches[0] : { t: "alt", branches };
  }

  private parseSeq(depth: number, startIcase: boolean): Ast {
    const items: Array<Ast> = [];
    let icase = startIcase;
    let justQuantified = false;

    while (this.pos < this.pat.length) {
      const b = this.pat[this.pos];
      if (b === 124) break;
      if (depth > 0 && b === 41) break;

      if (b === 42 || b === 43 || b === 63) {
        if (justQuantified) throw errInvalid("Invalid use of repetition operators");
        this.pos++;
        const prev = popRepeatable(items);
        const min = b === 43 ? 1 : 0;
        const max = b === 63 ? 1 : null;
        if (this.pos < this.pat.length && this.pat[this.pos] === 63) this.pos++;
        items.push({ t: "rep", inner: prev, min, max });
        justQuantified = true;
        continue;
      }

      if (b === 123) {
        const parsedBrace = this.tryParseBrace();
        if (parsedBrace !== null) {
          const prev = popRepeatable(items);
          if (this.pos < this.pat.length && this.pat[this.pos] === 63) this.pos++;
          items.push({ t: "rep", inner: prev, min: parsedBrace[0], max: parsedBrace[1] });
          justQuantified = true;
          continue;
        }
      }

      justQuantified = false;
      if (b === 40) {
        const mod = this.tryGroupModifier();
        if (mod !== undefined) {
          icase = mod;
          continue;
        }
        items.push(this.parseGroup(depth, icase));
        continue;
      }
      if (b === 91) {
        items.push(this.parseBracket(icase));
        continue;
      }
      if (b === 94) {
        this.pos++;
        items.push({ t: "assert", kind: "bol" });
        continue;
      }
      if (b === 36) {
        this.pos++;
        items.push({ t: "assert", kind: "eol" });
        continue;
      }
      if (b === 46) {
        this.pos++;
        items.push({ t: "any" });
        continue;
      }
      if (b === 92) {
        items.push(this.parseEscape(icase));
        continue;
      }
      this.pos++;
      const mask = new Uint32Array(8);
      setChar(mask, b, icase);
      items.push({ t: "mask", mask });
    }

    if (items.length === 0) return { t: "empty" };
    return items.length === 1 ? items[0] : { t: "seq", items };
  }

  private tryGroupModifier(): boolean | undefined {
    if (this.pos + 2 >= this.pat.length || this.pat[this.pos + 1] !== 63) return undefined;
    if (this.pat[this.pos + 2] === 105 && this.pat[this.pos + 3] === 41) {
      this.pos += 4;
      return true;
    }
    if (this.pat[this.pos + 2] === 45 && this.pat[this.pos + 3] === 105 && this.pat[this.pos + 4] === 41) {
      this.pos += 5;
      return false;
    }
    return undefined;
  }

  private parseGroup(depth: number, icase: boolean): Ast {
    this.pos++;
    let innerIcase = icase;
    if (this.pos < this.pat.length && this.pat[this.pos] === 63) {
      this.pos++;
      if (this.pos < this.pat.length && this.pat[this.pos] === 58) {
        this.pos++;
      } else if (this.pos + 1 < this.pat.length && this.pat[this.pos] === 105 && this.pat[this.pos + 1] === 58) {
        this.pos += 2;
        innerIcase = true;
      } else if (this.pos + 2 < this.pat.length && this.pat[this.pos] === 45 && this.pat[this.pos + 1] === 105 && this.pat[this.pos + 2] === 58) {
        this.pos += 3;
        innerIcase = false;
      } else {
        throw errInvalid("Invalid regexp");
      }
    }
    const inner = this.parseAlt(depth + 1, innerIcase);
    if (this.pos >= this.pat.length || this.pat[this.pos] !== 41) throw errInvalid("Missing ')'");
    this.pos++;
    return inner;
  }

  private tryParseBrace(): [number, number | null] | null {
    const start = this.pos + 1;
    let end = start;
    while (end < this.pat.length && this.pat[end] !== 125) end++;
    if (end >= this.pat.length) throw errInvalid("Missing '}'");
    const inner = String.fromCharCode(...this.pat.subarray(start, end));
    if (inner.length === 0) throw errInvalid("Invalid contents of {}");
    const m = /^(\d*)(?:,(\d*))?$/.exec(inner);
    if (!m || (!m[1] && !m[2])) throw errInvalid("Invalid contents of {}");
    const min = m[1] ? Number(m[1]) : 0;
    const max = inner.includes(",") ? (m[2] ? Number(m[2]) : null) : min;
    if (min > 255 || (max !== null && max > 255)) throw errInvalid("Maximum repetition in {} larger than 255");
    if (max !== null && min > max) throw errInvalid("Invalid contents of {}");
    this.pos = end + 1;
    return [min, max];
  }

  private parseEscape(icase: boolean): Ast {
    this.pos++;
    if (this.pos >= this.pat.length) throw errInvalid("Trailing backslash");
    const c = this.pat[this.pos];
    if (c === 98) {
      this.pos++;
      return { t: "assert", kind: "wb" };
    }
    if (c === 66) {
      this.pos++;
      return { t: "assert", kind: "nwb" };
    }
    if (c === 100 || c === 68 || c === 119 || c === 87 || c === 115 || c === 83) {
      this.pos++;
      const mask = new Uint32Array(8);
      addBuiltinClass(mask, c);
      return { t: "mask", mask };
    }
    const [ch, next] = singleEscape(this.pat, this.pos);
    this.pos = next;
    const mask = new Uint32Array(8);
    setChar(mask, ch, icase);
    return { t: "mask", mask };
  }

  private parseBracket(icase: boolean): Ast {
    this.pos++;
    let neg = false;
    if (this.pos < this.pat.length && this.pat[this.pos] === 94) {
      neg = true;
      this.pos++;
    }
    const mask = new Uint32Array(8);
    let first = true;
    let lastLit: number | null = null;
    let justRange = false;
    while (this.pos < this.pat.length) {
      const b = this.pat[this.pos];
      if (b === 93 && !first) {
        this.pos++;
        if (neg) invertMask(mask);
        return { t: "mask", mask };
      }
      first = false;
      if (b === 91 && this.pos + 1 < this.pat.length && this.pat[this.pos + 1] === 58) {
        const close = this.findPosixEnd(this.pos + 2);
        if (close !== -1) {
          const name = String.fromCharCode(...this.pat.subarray(this.pos + 2, close));
          if (!addPosixClass(mask, name, icase)) throw errInvalid("Invalid character class name");
          this.pos = close + 2;
          lastLit = null;
          justRange = false;
          continue;
        }
      }
      if (b === 45 && justRange && this.pos + 1 < this.pat.length && this.pat[this.pos + 1] !== 93) {
        throw errInvalid("Invalid character range");
      }
      if (b === 45 && lastLit !== null && this.pos + 1 < this.pat.length && this.pat[this.pos + 1] !== 93) {
        this.pos++;
        const hi = this.readClassAtom(mask);
        if (hi === null) throw errInvalid("Invalid character range");
        setRange(mask, lastLit, hi, icase);
        lastLit = null;
        justRange = true;
        continue;
      }
      justRange = false;
      const ch = this.readClassAtom(mask);
      if (ch !== null) {
        setChar(mask, ch, icase);
        lastLit = ch;
      } else {
        lastLit = null;
      }
    }
    throw errInvalid("Missing ']'");
  }

  private findPosixEnd(from: number): number {
    for (let i = from; i + 1 < this.pat.length; i++) {
      if (this.pat[i] === 58 && this.pat[i + 1] === 93) return i;
      if (this.pat[i] === 93) return -1;
    }
    return -1;
  }

  private readClassAtom(mask: Uint32Array): number | null {
    const b = this.pat[this.pos];
    if (b === 92) {
      this.pos++;
      if (this.pos >= this.pat.length) throw errInvalid("Trailing backslash");
      const c = this.pat[this.pos];
      if (c === 100 || c === 68 || c === 119 || c === 87 || c === 115 || c === 83) {
        this.pos++;
        addBuiltinClass(mask, c);
        return null;
      }
      const [ch, next] = singleEscape(this.pat, this.pos);
      this.pos = next;
      return ch;
    }
    this.pos++;
    return b;
  }
}

class NfaBuilder {
  states: Array<State> = [];

  private add(s: State): number {
    if (this.states.length >= MAX_STATES) throw errInvalid("Invalid regexp");
    const id = this.states.length;
    this.states.push(s);
    return id;
  }

  compile(ast: Ast, next: number): number {
    switch (ast.t) {
      case "empty":
        return next;
      case "any":
        return this.add({ t: "any", out: next });
      case "mask":
        return this.add({ t: "mask", mask: ast.mask, out: next });
      case "assert":
        return this.add({ t: "assert", kind: ast.kind, out: next });
      case "seq": {
        let cur = next;
        for (let i = ast.items.length - 1; i >= 0; i--) cur = this.compile(ast.items[i], cur);
        return cur;
      }
      case "alt": {
        let cur = this.compile(ast.branches[0], next);
        for (let i = 1; i < ast.branches.length; i++) {
          const right = this.compile(ast.branches[i], next);
          cur = this.add({ t: "split", a: cur, b: right });
        }
        return cur;
      }
      case "rep": {
        let cur = next;
        if (ast.max === null) {
          const split = this.add({ t: "split", a: next, b: next });
          const body = this.compile(ast.inner, split);
          this.states[split] = { t: "split", a: body, b: next };
          cur = split;
        } else {
          for (let i = ast.min; i < ast.max; i++) {
            const body = this.compile(ast.inner, cur);
            cur = this.add({ t: "split", a: body, b: next });
          }
        }
        for (let i = 0; i < ast.min; i++) cur = this.compile(ast.inner, cur);
        return cur;
      }
    }
  }

  build(ast: Ast): number {
    const match = this.add({ t: "match" });
    return this.compile(ast, match);
  }
}

export function compileRegex(pattern: Uint8Array, nocase: boolean): (input: Uint8Array) => boolean {
  if (pattern.length === 0) throw new RedisError("ERR regular expression is empty");
  const ast = new Parser(pattern, nocase).parse();
  const builder = new NfaBuilder();
  const start = builder.build(ast);
  const states = builder.states;
  const seen = new Int32Array(states.length);
  let gen = 0;
  let curr: Array<number> = [];
  let next: Array<number> = [];

  const addState = (id: number, list: Array<number>, input: Uint8Array, pos: number, g: number) => {
    const stack = [id];
    while (true) {
      const s = stack.pop();
      if (s === undefined) break;
      if (seen[s] === g) continue;
      seen[s] = g;
      const st = states[s];
      if (st.t === "split") {
        stack.push(st.b, st.a);
      } else if (st.t === "assert") {
        const leftWord = pos > 0 && isWordByte(input[pos - 1]);
        const rightWord = pos < input.length && isWordByte(input[pos]);
        const ok =
          st.kind === "bol"
            ? pos === 0
            : st.kind === "eol"
              ? pos === input.length
              : st.kind === "wb"
                ? leftWord !== rightWord
                : leftWord === rightWord;
        if (ok) stack.push(st.out);
      } else {
        list.push(s);
      }
    }
  };

  return (input: Uint8Array): boolean => {
    curr.length = 0;
    gen++;
    addState(start, curr, input, 0, gen);
    for (let pos = 0; pos <= input.length; pos++) {
      for (const s of curr) {
        if (states[s].t === "match") return true;
      }
      if (pos === input.length) break;
      const byte = input[pos];
      next.length = 0;
      gen++;
      addState(start, next, input, pos + 1, gen);
      for (const s of curr) {
        const st = states[s];
        if (st.t === "any" || (st.t === "mask" && hasBit(st.mask, byte))) {
          addState(st.out, next, input, pos + 1, gen);
        }
      }
      [curr, next] = [next, curr];
    }
    return false;
  };
}
