import type { CompiledFilter } from "./filter";
import { evalFilter } from "./filter";
import { distance } from "./math";
import type { EncodedVector, QuantType } from "./math";

export interface HnswNode {
  uid: number;
  element: Uint8Array;
  elemKey: string;
  level: number;
  vec: Uint8Array;
  f32?: Float32Array;
  i8?: Int8Array;
  u32?: Uint32Array;
  norm: number;
  quantRange: number;
  attrs: Uint8Array | null;
  links: Array<Array<number>>;
}

export interface VectorSetIndex {
  vsetUid: number;
  version: number;
  quant: QuantType;
  dim: number;
  inputDim: number;
  m: number;
  maxLevel: number;
  entryUid: number;
  maxNodeUid: number;
  attrsCount: number;
  nodes: Map<number, HnswNode>;
  byElement: Map<string, number>;
}

export interface DirtyLink {
  uid: number;
  level: number;
}

export interface SearchHit {
  node: HnswNode;
  dist: number;
}

interface HeapItem {
  uid: number;
  dist: number;
}

class Heap {
  readonly uids: Array<number> = [];
  readonly dists: Array<number> = [];

  constructor(private readonly maxHeap: boolean) {}

  get size(): number {
    return this.uids.length;
  }

  get topDist(): number {
    return this.dists[0];
  }

  private better(aDist: number, aUid: number, bDist: number, bUid: number): boolean {
    if (aDist !== bDist) return this.maxHeap ? aDist > bDist : aDist < bDist;
    return this.maxHeap ? aUid > bUid : aUid < bUid;
  }

  push(uid: number, dist: number) {
    this.uids.push(uid);
    this.dists.push(dist);
    let i = this.uids.length - 1;
    while (i > 0) {
      const p = (i - 1) >>> 1;
      if (!this.better(this.dists[i], this.uids[i], this.dists[p], this.uids[p])) break;
      [this.uids[i], this.uids[p]] = [this.uids[p], this.uids[i]];
      [this.dists[i], this.dists[p]] = [this.dists[p], this.dists[i]];
      i = p;
    }
  }

  pop(): HeapItem {
    const uid = this.uids[0];
    const dist = this.dists[0];
    const lastUid = this.uids.pop();
    const lastDist = this.dists.pop();
    if (this.uids.length > 0 && lastUid !== undefined && lastDist !== undefined) {
      this.uids[0] = lastUid;
      this.dists[0] = lastDist;
      let i = 0;
      const n = this.uids.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && this.better(this.dists[l], this.uids[l], this.dists[best], this.uids[best])) best = l;
        if (r < n && this.better(this.dists[r], this.uids[r], this.dists[best], this.uids[best])) best = r;
        if (best === i) break;
        [this.uids[i], this.uids[best]] = [this.uids[best], this.uids[i]];
        [this.dists[i], this.dists[best]] = [this.dists[best], this.dists[i]];
        i = best;
      }
    }
    return { uid, dist };
  }
}

export const DEFAULT_M = 16;
export const DEFAULT_EF_BUILD = 200;
const MAX_LEVEL = 32;

export function randomLevel(): number {
  let lvl = 0;
  while (Math.random() < 0.2 && lvl < MAX_LEVEL) lvl++;
  return lvl;
}

export const maxLinks = (m: number, level: number): number => (level === 0 ? m * 2 : m);

function markDirty(dirty: Map<string, DirtyLink>, uid: number, level: number) {
  dirty.set(`${uid}:${level}`, { uid, level });
}

function greedyStep(index: VectorSetIndex, query: EncodedVector, startUid: number, level: number): HeapItem {
  let currUid = startUid;
  const startNode = index.nodes.get(currUid);
  if (!startNode) return { uid: currUid, dist: 1 };
  let currDist = distance(index.quant, index.dim, query, startNode);
  let improved = true;
  while (improved) {
    improved = false;
    const currNode = index.nodes.get(currUid);
    if (!currNode) break;
    for (const nextUid of currNode.links[level]) {
      const nextNode = index.nodes.get(nextUid);
      if (!nextNode) continue;
      const d = distance(index.quant, index.dim, query, nextNode);
      if (d < currDist || (d === currDist && nextUid < currUid)) {
        currUid = nextUid;
        currDist = d;
        improved = true;
      }
    }
  }
  return { uid: currUid, dist: currDist };
}

function searchLayer(index: VectorSetIndex, query: EncodedVector, entryUids: Array<number>, ef: number, level: number): Array<HeapItem> {
  const visited = new Set<number>();
  const candidates = new Heap(false);
  const results = new Heap(true);
  for (const uid of entryUids) {
    if (visited.has(uid)) continue;
    const node = index.nodes.get(uid);
    if (!node) continue;
    visited.add(uid);
    const d = distance(index.quant, index.dim, query, node);
    candidates.push(uid, d);
    results.push(uid, d);
    if (results.size > ef) results.pop();
  }
  while (candidates.size > 0) {
    const c = candidates.pop();
    if (results.size >= ef && c.dist > results.topDist) break;
    const cNode = index.nodes.get(c.uid);
    if (!cNode) continue;
    for (const nUid of cNode.links[level]) {
      if (visited.has(nUid)) continue;
      visited.add(nUid);
      const nNode = index.nodes.get(nUid);
      if (!nNode) continue;
      const d = distance(index.quant, index.dim, query, nNode);
      if (results.size < ef || d < results.topDist) {
        candidates.push(nUid, d);
        results.push(nUid, d);
        if (results.size > ef) results.pop();
      }
    }
  }
  const out: Array<HeapItem> = [];
  while (results.size > 0) out.push(results.pop());
  out.reverse();
  return out;
}

function selectNeighbors(index: VectorSetIndex, candidates: Array<HeapItem>, cap: number): Array<number> {
  if (candidates.length <= cap) return candidates.map((c) => c.uid);
  const selected: Array<{ uid: number; dist: number; node: HnswNode }> = [];
  const pruned: Array<number> = [];
  for (const c of candidates) {
    if (selected.length >= cap) break;
    const cNode = index.nodes.get(c.uid);
    if (!cNode) continue;
    let keep = true;
    for (const s of selected) {
      if (distance(index.quant, index.dim, cNode, s.node) < c.dist) {
        keep = false;
        break;
      }
    }
    if (keep) selected.push({ uid: c.uid, dist: c.dist, node: cNode });
    else pruned.push(c.uid);
  }
  const out = selected.map((s) => s.uid);
  for (let i = 0; i < pruned.length && out.length < cap; i++) out.push(pruned[i]);
  return out;
}

export function insertNode(index: VectorSetIndex, node: HnswNode, efConstruction: number): Array<DirtyLink> {
  const dirty = new Map<string, DirtyLink>();
  index.nodes.set(node.uid, node);
  index.byElement.set(node.elemKey, node.uid);
  if (node.attrs !== null) index.attrsCount++;
  for (let lc = 0; lc <= node.level; lc++) markDirty(dirty, node.uid, lc);

  if (index.entryUid === 0) {
    index.entryUid = node.uid;
    index.maxLevel = node.level;
    return [...dirty.values()];
  }

  let currUid = index.entryUid;
  for (let lc = index.maxLevel; lc > node.level; lc--) {
    currUid = greedyStep(index, node, currUid, lc).uid;
  }

  const top = Math.min(node.level, index.maxLevel);
  let entryUids = [currUid];
  for (let lc = top; lc >= 0; lc--) {
    const candidates = searchLayer(index, node, entryUids, efConstruction, lc);
    const selected = selectNeighbors(index, candidates, maxLinks(index.m, lc));
    node.links[lc] = selected;
    const cap = maxLinks(index.m, lc);
    for (const nbUid of selected) {
      const nb = index.nodes.get(nbUid);
      if (!nb) continue;
      const nbLinks = nb.links[lc];
      if (!nbLinks.includes(node.uid)) {
        nbLinks.push(node.uid);
        if (nbLinks.length > cap) {
          const scored: Array<HeapItem> = [];
          for (const id of nbLinks) {
            const target = index.nodes.get(id);
            if (target) scored.push({ uid: id, dist: distance(index.quant, index.dim, nb, target) });
          }
          scored.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.uid - b.uid));
          nb.links[lc] = selectNeighbors(index, scored, cap);
        }
        markDirty(dirty, nbUid, lc);
      }
    }
    entryUids = candidates.length ? candidates.map((c) => c.uid) : entryUids;
  }

  if (node.level > index.maxLevel) {
    index.entryUid = node.uid;
    index.maxLevel = node.level;
  }
  return [...dirty.values()];
}

export function removeNode(index: VectorSetIndex, uid: number): Array<DirtyLink> {
  const node = index.nodes.get(uid);
  if (!node) return [];
  const dirty = new Map<string, DirtyLink>();

  for (let lc = 0; lc <= node.level; lc++) {
    const oldNeighbors = node.links[lc];
    const cap = maxLinks(index.m, lc);
    for (const nbUid of oldNeighbors) {
      const nb = index.nodes.get(nbUid);
      if (!nb) continue;
      const filtered = nb.links[lc].filter((id) => id !== uid);
      if (filtered.length !== nb.links[lc].length) {
        nb.links[lc] = filtered;
        markDirty(dirty, nbUid, lc);
      }
      if (nb.links[lc].length < cap) {
        const candidates: Array<HeapItem> = [];
        for (const otherUid of oldNeighbors) {
          if (otherUid === nbUid || nb.links[lc].includes(otherUid)) continue;
          const otherNode = index.nodes.get(otherUid);
          if (otherNode) candidates.push({ uid: otherUid, dist: distance(index.quant, index.dim, nb, otherNode) });
        }
        candidates.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.uid - b.uid));
        for (const cand of candidates) {
          if (nb.links[lc].length >= cap) break;
          nb.links[lc].push(cand.uid);
          markDirty(dirty, nbUid, lc);
          const other = index.nodes.get(cand.uid);
          if (other && other.links[lc].length < cap && !other.links[lc].includes(nbUid)) {
            other.links[lc].push(nbUid);
            markDirty(dirty, cand.uid, lc);
          }
        }
      }
    }
  }

  index.nodes.delete(uid);
  index.byElement.delete(node.elemKey);
  if (node.attrs !== null) index.attrsCount--;

  if (index.nodes.size === 0) {
    index.entryUid = 0;
    index.maxLevel = 0;
  } else if (index.entryUid === uid || node.level === index.maxLevel) {
    let bestUid = 0;
    let bestLevel = -1;
    for (const n of index.nodes.values()) {
      if (n.level > bestLevel) {
        bestLevel = n.level;
        bestUid = n.uid;
      }
    }
    index.maxLevel = bestLevel;
    const currEntry = index.nodes.get(index.entryUid);
    if (!currEntry || currEntry.level < bestLevel) index.entryUid = bestUid;
  }
  return [...dirty.values()];
}

export function searchTruth(
  index: VectorSetIndex,
  query: EncodedVector,
  count: number,
  epsilon: number | undefined,
  filter: CompiledFilter | undefined,
): Array<SearchHit> {
  const hits: Array<SearchHit> = [];
  for (const node of index.nodes.values()) {
    if (filter && !evalFilter(filter, node.attrs)) continue;
    const dist = distance(index.quant, index.dim, query, node);
    if (epsilon !== undefined && dist > epsilon) continue;
    hits.push({ node, dist });
  }
  hits.sort((a, b) => (a.dist !== b.dist ? a.dist - b.dist : a.node.uid - b.node.uid));
  return hits.slice(0, count);
}

export function searchHnsw(
  index: VectorSetIndex,
  query: EncodedVector,
  count: number,
  ef: number | undefined,
  epsilon: number | undefined,
  filter: CompiledFilter | undefined,
  filterEf: number | undefined,
): Array<SearchHit> {
  if (index.entryUid === 0) return [];
  let currUid = index.entryUid;
  for (let lc = index.maxLevel; lc >= 1; lc--) {
    currUid = greedyStep(index, query, currUid, lc).uid;
  }
  const searchEf = ef !== undefined ? Math.max(ef, count) : Math.max(count * 10, 100);
  if (!filter) {
    const raw = searchLayer(index, query, [currUid], searchEf, 0);
    const out: Array<SearchHit> = [];
    for (const item of raw) {
      if (epsilon !== undefined && item.dist > epsilon) continue;
      const node = index.nodes.get(item.uid);
      if (node) out.push({ node, dist: item.dist });
      if (out.length >= count) break;
    }
    return out;
  }

  const maxEffort = filterEf ?? Math.max(count * 100, 2000);
  const visited = new Set<number>([currUid]);
  const candidates = new Heap(false);
  const passed = new Heap(true);
  const entryNode = index.nodes.get(currUid);
  if (!entryNode) return [];
  candidates.push(currUid, distance(index.quant, index.dim, query, entryNode));
  let evaluated = 0;

  while (candidates.size > 0 && evaluated < maxEffort) {
    const c = candidates.pop();
    if (passed.size >= count && evaluated >= searchEf && c.dist > passed.topDist) break;
    const cNode = index.nodes.get(c.uid);
    if (!cNode) continue;
    evaluated++;
    if ((epsilon === undefined || c.dist <= epsilon) && evalFilter(filter, cNode.attrs)) {
      passed.push(c.uid, c.dist);
      if (passed.size > count) passed.pop();
    }
    for (const nUid of cNode.links[0]) {
      if (visited.has(nUid)) continue;
      visited.add(nUid);
      const nNode = index.nodes.get(nUid);
      if (!nNode) continue;
      candidates.push(nUid, distance(index.quant, index.dim, query, nNode));
    }
  }

  const hits: Array<SearchHit> = [];
  while (passed.size > 0) {
    const item = passed.pop();
    const node = index.nodes.get(item.uid);
    if (node) hits.push({ node, dist: item.dist });
  }
  hits.reverse();
  return hits;
}
