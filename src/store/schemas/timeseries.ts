import { TYPE } from "../keytypes";
import type { MemberTables } from "../keytypes";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ts_meta (
  key_id INTEGER PRIMARY KEY,
  uid INTEGER NOT NULL,
  retention INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 4096,
  init_chunk_size INTEGER NOT NULL DEFAULT 4096,
  compressed INTEGER NOT NULL DEFAULT 1,
  dup_policy TEXT NOT NULL DEFAULT 'block',
  ignore_time INTEGER NOT NULL DEFAULT 0,
  ignore_val REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ts_samples (
  key_id INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  value REAL,
  neg_zero INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, timestamp)
);
CREATE TABLE IF NOT EXISTS ts_labels (
  id INTEGER PRIMARY KEY,
  key_id INTEGER NOT NULL,
  label BLOB NOT NULL,
  value BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS ts_labels_lv ON ts_labels(label, value, key_id);
CREATE INDEX IF NOT EXISTS ts_labels_key ON ts_labels(key_id, id);
CREATE TABLE IF NOT EXISTS ts_rules (
  id INTEGER PRIMARY KEY,
  source_key_id INTEGER NOT NULL,
  source_uid INTEGER NOT NULL,
  dest_key_id INTEGER NOT NULL,
  dest_uid INTEGER NOT NULL,
  aggregator TEXT NOT NULL,
  bucket_duration INTEGER NOT NULL,
  align_ts INTEGER NOT NULL DEFAULT 0,
  open_bucket_ts INTEGER
);
CREATE INDEX IF NOT EXISTS ts_rules_src ON ts_rules(source_key_id, source_uid);
CREATE INDEX IF NOT EXISTS ts_rules_dst ON ts_rules(dest_key_id, dest_uid);
`;

export const TABLES: MemberTables = {
  [TYPE.timeseries]: [
    { table: "ts_meta", columns: "uid, retention, chunk_size, init_chunk_size, compressed, dup_policy, ignore_time, ignore_val" },
    { table: "ts_samples", columns: "timestamp, value, neg_zero" },
    { table: "ts_labels", columns: "label, value" },
  ],
};
