import { TYPE } from "../schema";
import type { MemberTables } from "../schema";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS vectorset_meta (
  key_id INTEGER PRIMARY KEY,
  vset_uid INTEGER NOT NULL,
  version INTEGER NOT NULL,
  quant INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  input_dim INTEGER NOT NULL,
  m INTEGER NOT NULL,
  max_level INTEGER NOT NULL,
  entry_uid INTEGER NOT NULL,
  max_node_uid INTEGER NOT NULL,
  size INTEGER NOT NULL,
  attrs_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vectorset_nodes (
  key_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  element BLOB NOT NULL,
  level INTEGER NOT NULL,
  vec BLOB NOT NULL,
  norm REAL,
  quant_range REAL,
  attrs BLOB,
  PRIMARY KEY (key_id, uid),
  UNIQUE (key_id, element)
);
CREATE INDEX IF NOT EXISTS vectorset_nodes_elem ON vectorset_nodes(key_id, element);
CREATE TABLE IF NOT EXISTS vectorset_links (
  key_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  level INTEGER NOT NULL,
  neighbors BLOB NOT NULL,
  PRIMARY KEY (key_id, uid, level)
);
`;

export const TABLES: MemberTables = {
  [TYPE.vectorset]: [
    {
      table: "vectorset_meta",
      columns: "vset_uid, version, quant, dim, input_dim, m, max_level, entry_uid, max_node_uid, size, attrs_count",
    },
    {
      table: "vectorset_nodes",
      columns: "uid, element, level, vec, norm, quant_range, attrs",
    },
    {
      table: "vectorset_links",
      columns: "uid, level, neighbors",
    },
  ],
};
