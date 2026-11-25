import { DurableObject } from "cloudflare:workers";
import { Keyspace } from "../store/keyspace";
import { SCHEMA } from "../store/schema";
import { Connection } from "./connection";
import { Hub } from "./hub";
import { createDatabase, passwordMatches, readMeta } from "./lifecycle";
import { chunkOf, closeQuietly, refuse } from "./socket";

export class RedisDO extends DurableObject<Env> {
  private readonly closers = new Map<Connection, () => Promise<void>>();
  private readonly hub: Hub;
  private deleting = false;
  private nextId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (readMeta(ctx.storage)) ctx.storage.sql.exec(SCHEMA);
    this.hub = new Hub(new Keyspace(ctx.storage.sql), ctx.id.name ?? "", Date.now(), (fn) => ctx.storage.transactionSync(fn), (password) => this.authenticate(password));
  }

  private authenticate(password: string): boolean {
    const meta = readMeta(this.ctx.storage);
    if (meta) return passwordMatches(meta, password);
    createDatabase(this.ctx.storage, this.name, this.env.LIMITS.ttlSeconds, password);
    return true;
  }

  private get name(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("RedisDO must be addressed by name");
    return name;
  }

  async connect(socket: Socket): Promise<void> {
    const { idleSeconds, maxConnections } = this.env.LIMITS;
    if (this.deleting) return refuse(socket, "ERR duraredis: the database is being deleted, try again");
    if (this.closers.size >= maxConnections) return refuse(socket, "ERR max number of clients reached");

    const reader = socket.readable.getReader();
    const writer = socket.writable.getWriter();
    let closed = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let writing = Promise.resolve();
    const send = (bytes: Uint8Array) => {
      writing = writing.then(() => writer.write(bytes)).catch(() => {});
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(idle);
      await writing;
      await writer.close().catch(() => {});
      await closeQuietly(socket);
    };
    const conn = new Connection(this.hub, this.nextId++, this.name, send, () => void close());
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => (conn.waiting ? touch() : void close()), idleSeconds * 1000);
    };
    this.closers.set(conn, close);
    this.hub.connectionSet.add(conn);
    touch();

    try {
      while (!closed && !this.deleting && !conn.session.closing) {
        const next: ReadableStreamReadResult<unknown> = await reader.read();
        if (next.done) break;
        touch();
        conn.receive(chunkOf(next.value));
        await writing;
      }
    } catch {
      conn.session.closing = true;
    } finally {
      conn.close();
      this.hub.connectionSet.delete(conn);
      this.closers.delete(conn);
      reader.releaseLock();
      await close();
    }
  }

  async alarm() {
    const meta = readMeta(this.ctx.storage);
    if (!meta || meta.expiresAt === null) return;
    if (Date.now() < meta.expiresAt) return this.ctx.storage.setAlarm(meta.expiresAt);
    this.deleting = true;
    try {
      await Promise.all([...this.closers.values()].map((close) => close()));
      await this.ctx.storage.deleteAll();
    } finally {
      this.deleting = false;
    }
  }
}
