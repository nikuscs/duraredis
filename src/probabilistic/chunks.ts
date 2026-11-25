import { blob, fromBlob } from "../store/keyspace";

export const CHUNK_BYTES = 65_536;
export const CHUNK_MASK = 65_535;
export const MAX_ALLOC_BYTES = 64 * 1024 * 1024;

function chunkSize(totalBytes: number, chunkIdx: number): number {
  return Math.min(CHUNK_BYTES, totalBytes - chunkIdx * CHUNK_BYTES);
}

function isAllZero(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false;
  return true;
}

export class ChunkStore {
  private readonly cache = new Map<number, Uint8Array>();
  private readonly dirty = new Set<number>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly keyId: number,
    private readonly table: string,
    public totalBytes: number,
    private readonly filterIdx: number | null = null,
  ) {}

  get(chunkIdx: number): Uint8Array {
    const cached = this.cache.get(chunkIdx);
    if (cached) return cached;
    const len = chunkSize(this.totalBytes, chunkIdx);
    const row = this.filterIdx === null
      ? this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM ${this.table} WHERE key_id = ? AND chunk_idx = ?`, this.keyId, chunkIdx).toArray()[0]
      : this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM ${this.table} WHERE key_id = ? AND filter_idx = ? AND chunk_idx = ?`, this.keyId, this.filterIdx, chunkIdx).toArray()[0];
    const buf = new Uint8Array(len);
    if (row) {
      const raw = fromBlob(row.data);
      buf.set(raw.subarray(0, Math.min(raw.length, len)));
    }
    this.cache.set(chunkIdx, buf);
    return buf;
  }

  markDirty(chunkIdx: number) {
    this.dirty.add(chunkIdx);
  }

  readRange(offset: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    let pos = 0;
    while (pos < len) {
      const abs = offset + pos;
      const chunkIdx = Math.floor(abs / CHUNK_BYTES);
      const inChunk = abs % CHUNK_BYTES;
      const take = Math.min(len - pos, CHUNK_BYTES - inChunk);
      out.set(this.get(chunkIdx).subarray(inChunk, inChunk + take), pos);
      pos += take;
    }
    return out;
  }

  writeRange(offset: number, data: Uint8Array) {
    let pos = 0;
    while (pos < data.length) {
      const abs = offset + pos;
      const chunkIdx = Math.floor(abs / CHUNK_BYTES);
      const inChunk = abs % CHUNK_BYTES;
      const take = Math.min(data.length - pos, CHUNK_BYTES - inChunk);
      this.get(chunkIdx).set(data.subarray(pos, pos + take), inChunk);
      this.dirty.add(chunkIdx);
      pos += take;
    }
  }

  flush() {
    for (const chunkIdx of this.dirty) {
      const buf = this.cache.get(chunkIdx);
      if (!buf) continue;
      if (isAllZero(buf)) {
        if (this.filterIdx === null) this.sql.exec(`DELETE FROM ${this.table} WHERE key_id = ? AND chunk_idx = ?`, this.keyId, chunkIdx);
        else this.sql.exec(`DELETE FROM ${this.table} WHERE key_id = ? AND filter_idx = ? AND chunk_idx = ?`, this.keyId, this.filterIdx, chunkIdx);
        continue;
      }
      if (this.filterIdx === null) {
        this.sql.exec(`INSERT INTO ${this.table} (key_id, chunk_idx, data) VALUES (?, ?, ?) ON CONFLICT (key_id, chunk_idx) DO UPDATE SET data = excluded.data`,
          this.keyId, chunkIdx, blob(buf));
      } else {
        this.sql.exec(`INSERT INTO ${this.table} (key_id, filter_idx, chunk_idx, data) VALUES (?, ?, ?, ?) ON CONFLICT (key_id, filter_idx, chunk_idx) DO UPDATE SET data = excluded.data`,
          this.keyId, this.filterIdx, chunkIdx, blob(buf));
      }
    }
    this.dirty.clear();
  }
}
