const STAR = 42;
const QUESTION = 63;
const OPEN = 91;
const CLOSE = 93;
const CARET = 94;
const DASH = 45;
const BACKSLASH = 92;
const MAX_DEPTH = 1000;

interface ClassMatch {
  matched: boolean;
  end: number;
}

function matchClass(pattern: Uint8Array, start: number, c: number, lower: (c: number) => number): ClassMatch {
  let p = start;
  const negate = pattern[p] === CARET;
  if (negate) p++;
  let matched = false;
  for (; p < pattern.length && pattern[p] !== CLOSE; p++) {
    if (pattern[p] === BACKSLASH && p + 1 < pattern.length) {
      p++;
      matched ||= lower(pattern[p]) === c;
      continue;
    }
    if (p + 2 < pattern.length && pattern[p + 1] === DASH) {
      const [a, b] = [lower(pattern[p]), lower(pattern[p + 2])].toSorted((x, y) => x - y);
      matched ||= c >= a && c <= b;
      p += 2;
      continue;
    }
    matched ||= lower(pattern[p]) === c;
  }
  return { matched: matched !== negate, end: Math.min(p, pattern.length - 1) };
}

export function globMatch(pattern: Uint8Array, s: Uint8Array, nocase = false): boolean {
  const lower = (c: number) => (nocase && c >= 65 && c <= 90 ? c + 32 : c);
  const match = (start: number, from: number, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let p = start;
    let i = from;
    while (p < pattern.length) {
      const c = pattern[p];
      if (c === STAR) {
        while (pattern[p + 1] === STAR) p++;
        if (p + 1 === pattern.length) return true;
        for (let j = i; j <= s.length; j++) if (match(p + 1, j, depth + 1)) return true;
        return false;
      }
      if (i >= s.length) return false;
      if (c === OPEN) {
        const cls = matchClass(pattern, p + 1, lower(s[i]), lower);
        if (!cls.matched) return false;
        p = cls.end + 1;
        i++;
        continue;
      }
      if (c === BACKSLASH && p + 1 < pattern.length) p++;
      if (c !== QUESTION && lower(pattern[p]) !== lower(s[i])) return false;
      p++;
      i++;
    }
    return i === s.length;
  };
  return match(0, 0, 0);
}
