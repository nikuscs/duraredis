import { TYPE } from "../keytypes";
import type { MemberTables } from "../keytypes";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS bf_meta (
  key_id INTEGER PRIMARY KEY,
  size TEXT NOT NULL,
  options INTEGER NOT NULL,
  growth INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bf_filters (
  key_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  bytes TEXT NOT NULL,
  bits TEXT NOT NULL,
  size TEXT NOT NULL,
  error REAL NOT NULL,
  bpe REAL NOT NULL,
  hashes INTEGER NOT NULL,
  entries TEXT NOT NULL,
  n2 INTEGER NOT NULL,
  PRIMARY KEY (key_id, idx)
);
CREATE TABLE IF NOT EXISTS bf_chunks (
  key_id INTEGER NOT NULL,
  filter_idx INTEGER NOT NULL,
  chunk_idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key_id, filter_idx, chunk_idx)
);
CREATE TABLE IF NOT EXISTS cf_meta (
  key_id INTEGER PRIMARY KEY,
  num_buckets TEXT NOT NULL,
  num_items TEXT NOT NULL,
  num_deletes TEXT NOT NULL,
  num_filters INTEGER NOT NULL,
  bucket_size INTEGER NOT NULL,
  max_iterations INTEGER NOT NULL,
  expansion INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cf_filters (
  key_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  num_buckets TEXT NOT NULL,
  PRIMARY KEY (key_id, idx)
);
CREATE TABLE IF NOT EXISTS cf_chunks (
  key_id INTEGER NOT NULL,
  filter_idx INTEGER NOT NULL,
  chunk_idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key_id, filter_idx, chunk_idx)
);
CREATE TABLE IF NOT EXISTS cms_meta (
  key_id INTEGER PRIMARY KEY,
  width TEXT NOT NULL,
  depth TEXT NOT NULL,
  counter TEXT NOT NULL,
  cell_size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cms_chunks (
  key_id INTEGER NOT NULL,
  chunk_idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key_id, chunk_idx)
);
CREATE TABLE IF NOT EXISTS topk_meta (
  key_id INTEGER PRIMARY KEY,
  k INTEGER NOT NULL,
  width INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  decay REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS topk_heap (
  key_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  fp INTEGER NOT NULL,
  count INTEGER NOT NULL,
  item BLOB,
  PRIMARY KEY (key_id, idx)
);
CREATE TABLE IF NOT EXISTS topk_chunks (
  key_id INTEGER NOT NULL,
  chunk_idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key_id, chunk_idx)
);
CREATE TABLE IF NOT EXISTS tdigest_meta (
  key_id INTEGER PRIMARY KEY,
  compression REAL NOT NULL,
  bounds BLOB NOT NULL,
  cap INTEGER NOT NULL,
  merged_nodes INTEGER NOT NULL,
  unmerged_nodes INTEGER NOT NULL,
  total_compressions TEXT NOT NULL,
  merged_weight TEXT NOT NULL,
  unmerged_weight TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tdigest_chunks (
  key_id INTEGER NOT NULL,
  chunk_idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (key_id, chunk_idx)
);
`;

export const TABLES: MemberTables = {
  [TYPE.bloom]: [
    { table: "bf_meta", columns: "size, options, growth" },
    { table: "bf_filters", columns: "idx, bytes, bits, size, error, bpe, hashes, entries, n2" },
    { table: "bf_chunks", columns: "filter_idx, chunk_idx, data" },
  ],
  [TYPE.cuckoo]: [
    { table: "cf_meta", columns: "num_buckets, num_items, num_deletes, num_filters, bucket_size, max_iterations, expansion" },
    { table: "cf_filters", columns: "idx, num_buckets" },
    { table: "cf_chunks", columns: "filter_idx, chunk_idx, data" },
  ],
  [TYPE.cms]: [
    { table: "cms_meta", columns: "width, depth, counter, cell_size" },
    { table: "cms_chunks", columns: "chunk_idx, data" },
  ],
  [TYPE.topk]: [
    { table: "topk_meta", columns: "k, width, depth, decay" },
    { table: "topk_heap", columns: "idx, fp, count, item" },
    { table: "topk_chunks", columns: "chunk_idx, data" },
  ],
  [TYPE.tdigest]: [
    { table: "tdigest_meta", columns: "compression, bounds, cap, merged_nodes, unmerged_nodes, total_compressions, merged_weight, unmerged_weight" },
    { table: "tdigest_chunks", columns: "chunk_idx, data" },
  ],
};
