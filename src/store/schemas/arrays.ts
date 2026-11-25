import { TYPE } from "../schema";
import type { MemberTables } from "../schema";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS array_items (
  key_id INTEGER NOT NULL,
  idx BLOB NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (key_id, idx)
);
`;

export const TABLES: MemberTables = {
  [TYPE.array]: [{ table: "array_items", columns: "idx, value" }],
};
