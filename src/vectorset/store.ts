import { blob, fromBlob, keyString } from "../store/keyspace";
import type { DirtyLink, HnswNode, VectorSetIndex } from "./hnsw";
import { hydrateVector, toQuant } from "./math";
import type { QuantType } from "./math";

export type VectorSetMetaRow = {
  vset_uid: number;
  version: number;
  quant: number;
  dim: number;
  input_dim: number;
  m: number;
  max_level: number;
  entry_uid: number;
  max_node_uid: number;
  size: number;
  attrs_count: number;
};

export interface NodeRecord {
  uid: number;
  element: Uint8Array;
  level: number;
  vec: Uint8Array;
  norm: number;
  quantRange: number;
  attrs: Uint8Array | null;
}

interface DoCache {
  indices: Map<number, VectorSetIndex>;
  nextVsetUid: number | undefined;
}

const MAX_CACHED_INDICES = 64;
const DO_CACHES = new WeakMap<SqlStorage, DoCache>();

function getCache(sql: SqlStorage): DoCache {
  let cache = DO_CACHES.get(sql);
  if (!cache) {
    cache = { indices: new Map(), nextVsetUid: undefined };
    DO_CACHES.set(sql, cache);
  }
  return cache;
}

function touchCache(cache: DoCache, keyId: number, index: VectorSetIndex) {
  cache.indices.delete(keyId);
  cache.indices.set(keyId, index);
  if (cache.indices.size <= MAX_CACHED_INDICES) return;
  const oldest = cache.indices.keys().next().value;
  if (oldest !== undefined) cache.indices.delete(oldest);
}

export function evictIndex(sql: SqlStorage, keyId: number) {
  getCache(sql).indices.delete(keyId);
}

function allocateVsetUid(sql: SqlStorage): number {
  const cache = getCache(sql);
  if (cache.nextVsetUid === undefined) {
    const row = sql.exec<{ n: number }>("SELECT coalesce(max(vset_uid) + 1, 0) AS n FROM vectorset_meta").one();
    cache.nextVsetUid = row.n;
  }
  return cache.nextVsetUid++;
}

export function readMeta(sql: SqlStorage, keyId: number): VectorSetMetaRow | undefined {
  return sql.exec<VectorSetMetaRow>(
    "SELECT vset_uid, version, quant, dim, input_dim, m, max_level, entry_uid, max_node_uid, size, attrs_count FROM vectorset_meta WHERE key_id = ?",
    keyId,
  ).toArray()[0];
}

function packNeighbors(uids: Array<number>): ArrayBuffer {
  const buf = new ArrayBuffer(uids.length * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < uids.length; i++) dv.setUint32(i * 4, uids[i], true);
  return buf;
}

function unpackNeighbors(buf: ArrayBuffer): Array<number> {
  const dv = new DataView(buf);
  const n = buf.byteLength >>> 2;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
  return out;
}

function buildIndex(sql: SqlStorage, keyId: number, meta: VectorSetMetaRow): VectorSetIndex {
  const quant = toQuant(meta.quant);
  const nodes = new Map<number, HnswNode>();
  const byElement = new Map<string, number>();

  const nodeRows = sql.exec<{
    uid: number;
    element: ArrayBuffer;
    level: number;
    vec: ArrayBuffer;
    norm: number | null;
    quant_range: number | null;
    attrs: ArrayBuffer | null;
  }>("SELECT uid, element, level, vec, norm, quant_range, attrs FROM vectorset_nodes WHERE key_id = ?", keyId).toArray();

  for (const row of nodeRows) {
    const element = fromBlob(row.element);
    const elemKey = keyString(element);
    const vec = fromBlob(row.vec);
    const norm = row.norm ?? Number.NaN;
    const quantRange = row.quant_range ?? Number.NaN;
    const hydrated = hydrateVector(vec, quant, meta.dim, norm, quantRange);
    const links = Array.from({ length: row.level + 1 }, () => [] as Array<number>);
    nodes.set(row.uid, {
      uid: row.uid,
      element,
      elemKey,
      level: row.level,
      vec,
      f32: hydrated.f32,
      i8: hydrated.i8,
      u32: hydrated.u32,
      norm,
      quantRange,
      attrs: row.attrs ? fromBlob(row.attrs) : null,
      links,
    });
    byElement.set(elemKey, row.uid);
  }

  const linkRows = sql.exec<{ uid: number; level: number; neighbors: ArrayBuffer }>(
    "SELECT uid, level, neighbors FROM vectorset_links WHERE key_id = ?",
    keyId,
  ).toArray();

  for (const row of linkRows) {
    const node = nodes.get(row.uid);
    if (node && row.level <= node.level) node.links[row.level] = unpackNeighbors(row.neighbors);
  }

  return {
    vsetUid: meta.vset_uid,
    version: meta.version,
    quant,
    dim: meta.dim,
    inputDim: meta.input_dim,
    m: meta.m,
    maxLevel: meta.max_level,
    entryUid: meta.entry_uid,
    maxNodeUid: meta.max_node_uid,
    attrsCount: meta.attrs_count,
    nodes,
    byElement,
  };
}

export function loadIndex(sql: SqlStorage, keyId: number): VectorSetIndex {
  const meta = readMeta(sql, keyId);
  if (!meta) throw new Error(`duraredis: missing vectorset_meta for key_id ${keyId}`);
  const cache = getCache(sql);
  const cached = cache.indices.get(keyId);
  if (cached && cached.vsetUid === meta.vset_uid && cached.version === meta.version) {
    touchCache(cache, keyId, cached);
    return cached;
  }
  const built = buildIndex(sql, keyId, meta);
  touchCache(cache, keyId, built);
  return built;
}

export function createIndex(sql: SqlStorage, keyId: number, quant: QuantType, dim: number, inputDim: number, m: number): VectorSetIndex {
  const vsetUid = allocateVsetUid(sql);
  sql.exec(
    "INSERT INTO vectorset_meta (key_id, vset_uid, version, quant, dim, input_dim, m, max_level, entry_uid, max_node_uid, size, attrs_count) VALUES (?, ?, 1, ?, ?, ?, ?, 0, 0, 0, 0, 0)",
    keyId,
    vsetUid,
    quant,
    dim,
    inputDim,
    m,
  );
  const index: VectorSetIndex = {
    vsetUid,
    version: 1,
    quant,
    dim,
    inputDim,
    m,
    maxLevel: 0,
    entryUid: 0,
    maxNodeUid: 0,
    attrsCount: 0,
    nodes: new Map(),
    byElement: new Map(),
  };
  touchCache(getCache(sql), keyId, index);
  return index;
}

export function saveMeta(sql: SqlStorage, keyId: number, index: VectorSetIndex) {
  const nextVersion = index.version + 1;
  sql.exec(
    "UPDATE vectorset_meta SET version = ?, max_level = ?, entry_uid = ?, max_node_uid = ?, size = ?, attrs_count = ? WHERE key_id = ?",
    nextVersion,
    index.maxLevel,
    index.entryUid,
    index.maxNodeUid,
    index.nodes.size,
    index.attrsCount,
    keyId,
  );
  index.version = nextVersion;
}

export function persistAddedNode(sql: SqlStorage, keyId: number, index: VectorSetIndex, node: HnswNode, dirtyLinks: Array<DirtyLink>) {
  sql.exec(
    "INSERT INTO vectorset_nodes (key_id, uid, element, level, vec, norm, quant_range, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    keyId,
    node.uid,
    blob(node.element),
    node.level,
    blob(node.vec),
    node.norm,
    node.quantRange,
    node.attrs ? blob(node.attrs) : null,
  );
  for (const link of dirtyLinks) {
    const target = index.nodes.get(link.uid);
    if (!target) continue;
    sql.exec(
      "INSERT OR REPLACE INTO vectorset_links (key_id, uid, level, neighbors) VALUES (?, ?, ?, ?)",
      keyId,
      link.uid,
      link.level,
      packNeighbors(target.links[link.level]),
    );
  }
}

export function persistRemovedNode(sql: SqlStorage, keyId: number, index: VectorSetIndex, uid: number, dirtyLinks: Array<DirtyLink>) {
  sql.exec("DELETE FROM vectorset_links WHERE key_id = ? AND uid = ?", keyId, uid);
  sql.exec("DELETE FROM vectorset_nodes WHERE key_id = ? AND uid = ?", keyId, uid);
  for (const link of dirtyLinks) {
    const target = index.nodes.get(link.uid);
    if (!target) continue;
    sql.exec(
      "INSERT OR REPLACE INTO vectorset_links (key_id, uid, level, neighbors) VALUES (?, ?, ?, ?)",
      keyId,
      link.uid,
      link.level,
      packNeighbors(target.links[link.level]),
    );
  }
}

export function readNodeByElement(sql: SqlStorage, keyId: number, element: Uint8Array): NodeRecord | undefined {
  const meta = readMeta(sql, keyId);
  if (!meta) return undefined;
  const cached = getCache(sql).indices.get(keyId);
  if (cached && cached.vsetUid === meta.vset_uid && cached.version === meta.version) {
    const uid = cached.byElement.get(keyString(element));
    if (uid === undefined) return undefined;
    const node = cached.nodes.get(uid);
    if (!node) return undefined;
    return { uid: node.uid, element: node.element, level: node.level, vec: node.vec, norm: node.norm, quantRange: node.quantRange, attrs: node.attrs };
  }
  const row = sql.exec<{ uid: number; element: ArrayBuffer; level: number; vec: ArrayBuffer; norm: number | null; quant_range: number | null; attrs: ArrayBuffer | null }>(
    "SELECT uid, element, level, vec, norm, quant_range, attrs FROM vectorset_nodes WHERE key_id = ? AND element = ?",
    keyId,
    blob(element),
  ).toArray()[0];
  if (!row) return undefined;
  return {
    uid: row.uid,
    element: fromBlob(row.element),
    level: row.level,
    vec: fromBlob(row.vec),
    norm: row.norm ?? Number.NaN,
    quantRange: row.quant_range ?? Number.NaN,
    attrs: row.attrs ? fromBlob(row.attrs) : null,
  };
}

export function updateNodeAttrs(sql: SqlStorage, keyId: number, element: Uint8Array, nextAttrs: Uint8Array | null): boolean {
  const meta = readMeta(sql, keyId);
  if (!meta) return false;
  const row = sql.exec<{ uid: number; attrs: ArrayBuffer | null }>(
    "SELECT uid, attrs FROM vectorset_nodes WHERE key_id = ? AND element = ?",
    keyId,
    blob(element),
  ).toArray()[0];
  if (!row) return false;
  const hadAttrs = row.attrs !== null;
  const hasAttrs = nextAttrs !== null;
  const delta = (hasAttrs ? 1 : 0) - (hadAttrs ? 1 : 0);
  const nextVersion = meta.version + 1;
  sql.exec("UPDATE vectorset_nodes SET attrs = ? WHERE key_id = ? AND uid = ?", nextAttrs ? blob(nextAttrs) : null, keyId, row.uid);
  sql.exec("UPDATE vectorset_meta SET version = ?, attrs_count = attrs_count + ? WHERE key_id = ?", nextVersion, delta, keyId);
  const cached = getCache(sql).indices.get(keyId);
  if (cached && cached.vsetUid === meta.vset_uid && cached.version === meta.version) {
    const node = cached.nodes.get(row.uid);
    if (node) {
      node.attrs = nextAttrs;
      cached.attrsCount += delta;
      cached.version = nextVersion;
    } else {
      evictIndex(sql, keyId);
    }
  }
  return true;
}

export function rangeElements(
  sql: SqlStorage,
  keyId: number,
  min: Uint8Array | null,
  minExclusive: boolean,
  max: Uint8Array | null,
  maxExclusive: boolean,
  limit: number,
): Array<Uint8Array> {
  const conds = ["key_id = ?"];
  const params: Array<unknown> = [keyId];
  if (min !== null) {
    conds.push(`element ${minExclusive ? ">" : ">="} ?`);
    params.push(blob(min));
  }
  if (max !== null) {
    conds.push(`element ${maxExclusive ? "<" : "<="} ?`);
    params.push(blob(max));
  }
  const lim = limit < 0 ? "" : " LIMIT ?";
  if (limit >= 0) params.push(limit);
  return sql.exec<{ element: ArrayBuffer }>(
    `SELECT element FROM vectorset_nodes WHERE ${conds.join(" AND ")} ORDER BY element${lim}`,
    ...params,
  ).toArray().map((row) => fromBlob(row.element));
}

export function allElements(sql: SqlStorage, keyId: number): Array<Uint8Array> {
  return sql.exec<{ element: ArrayBuffer }>("SELECT element FROM vectorset_nodes WHERE key_id = ?", keyId)
    .toArray()
    .map((row) => fromBlob(row.element));
}
