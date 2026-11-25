export const TYPE = {
  string: 0, hash: 1, list: 2, set: 3, zset: 4, stream: 5,
  json: 6, bloom: 7, cuckoo: 8, cms: 9, topk: 10, tdigest: 11, timeseries: 12, vectorset: 13, array: 14,
} as const;
export type KeyType = (typeof TYPE)[keyof typeof TYPE];
export const TYPE_NAME = {
  0: "string", 1: "hash", 2: "list", 3: "set", 4: "zset", 5: "stream",
  6: "ReJSON-RL", 7: "MBbloom--", 8: "MBbloomCF", 9: "CMSk-TYPE", 10: "TopK-TYPE", 11: "TDIS-TYPE", 12: "TSDB-TYPE", 13: "vectorset", 14: "array",
} as const satisfies Record<KeyType, string>;

const TYPES = new Set<number>(Object.values(TYPE));
const isKeyType = (n: number): n is KeyType => TYPES.has(n);

export function keyType(n: number): KeyType {
  if (isKeyType(n)) return n;
  throw new Error(`duraredis: unknown stored key type ${n}`);
}

export const EXPIRING_MEMBERS: Array<{ table: string; type: KeyType }> = [
  { table: "hash_fields", type: TYPE.hash },
  { table: "set_members", type: TYPE.set },
];

export const UNCOPYABLE = new Set<KeyType>([TYPE.bloom, TYPE.cuckoo, TYPE.cms, TYPE.topk, TYPE.tdigest, TYPE.vectorset]);

export type MemberTables = Partial<Record<KeyType, Array<{ table: string; columns: string }>>>;
