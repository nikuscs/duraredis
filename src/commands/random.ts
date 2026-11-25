export function shuffle<T>(values: Array<T>): Array<T> {
  const pool = [...values];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function sample<T>(values: Array<T>, count: number): Array<T> {
  if (count >= 0) return shuffle(values).slice(0, count);
  return Array.from({ length: -count }, () => values[Math.floor(Math.random() * values.length)]);
}
