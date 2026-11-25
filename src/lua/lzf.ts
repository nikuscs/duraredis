const HLOG = 16;
const HSIZE = 1 << HLOG;
const MAX_LIT = 1 << 5;
const MAX_OFF = 1 << 13;
const MAX_REF = (1 << 8) + (1 << 3);

const first = (data: Uint8Array, p: number) => (data[p] << 8) | data[p + 1];
const next = (v: number, data: Uint8Array, p: number) => ((v << 8) | data[p + 2]) >>> 0;
const index = (h: number) => (((h >>> (3 * 8 - HLOG)) - Math.imul(h, 5)) >>> 0) & (HSIZE - 1);

export function lzfCompress(input: Uint8Array, outLen: number): Uint8Array | undefined {
  if (!input.length || !outLen) return undefined;
  const table = new Int32Array(HSIZE);
  const out = new Uint8Array(outLen);
  const end = input.length;
  let ip = 0;
  let op = 1;
  let lit = 0;
  let hval = first(input, ip);
  const emitLiteral = (): boolean => {
    if (op >= outLen) return false;
    lit++;
    out[op++] = input[ip++];
    if (lit !== MAX_LIT) return true;
    out[op - lit - 1] = lit - 1;
    lit = 0;
    op++;
    return true;
  };
  while (ip < end - 2) {
    hval = next(hval, input, ip);
    const slot = index(hval);
    const ref = table[slot];
    table[slot] = ip;
    const off = ip - ref - 1;
    const matches = off < MAX_OFF && ref > 0 && input[ref + 2] === input[ip + 2] && input[ref] === input[ip] && input[ref + 1] === input[ip + 1];
    if (!matches) {
      if (!emitLiteral()) return undefined;
      continue;
    }
    let len = 2;
    const maxlen = Math.min(end - ip - len, MAX_REF);
    if (op + 3 + 1 >= outLen && op - (lit ? 0 : 1) + 3 + 1 >= outLen) return undefined;
    out[op - lit - 1] = lit - 1;
    if (!lit) op--;
    do len++; while (len < maxlen && input[ref + len] === input[ip + len]);
    len -= 2;
    ip++;
    if (len < 7) {
      out[op++] = (off >> 8) + (len << 5);
    } else {
      out[op++] = (off >> 8) + (7 << 5);
      out[op++] = len - 7;
    }
    out[op++] = off & 0xff;
    lit = 0;
    op++;
    ip += len + 1;
    if (ip >= end - 2) break;
    ip -= 2;
    hval = first(input, ip);
    hval = next(hval, input, ip);
    table[index(hval)] = ip;
    ip++;
    hval = next(hval, input, ip);
    table[index(hval)] = ip;
    ip++;
  }
  if (op + 3 > outLen) return undefined;
  while (ip < end) if (!emitLiteral()) return undefined;
  out[op - lit - 1] = lit - 1;
  if (!lit) op--;
  return out.slice(0, op);
}
