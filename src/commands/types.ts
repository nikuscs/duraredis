import type { AuthResult } from "../database/guard";
import type { Fieldset } from "./himport";
import type { Command } from "../resp/parser";
import type { Proto, Reply } from "../resp/reply";
import type { Keyspace } from "../store/keyspace";

export interface Session {
  id: number;
  proto: Proto;
  name: Uint8Array | null;
  database: string;
  libName: string;
  libVersion: string;
  createdAt: number;
  closing: boolean;
  authenticated: boolean;
  client: string;
  fieldsets: Map<string, Fieldset>;
}

export interface Server {
  ks: Keyspace;
  database: string;
  startedAt: number;
  connections: () => Array<Session>;
  publish: (channel: Uint8Array, message: Uint8Array, shard: boolean) => number;
  channels: (pattern: Uint8Array | null, shard: boolean) => Array<Uint8Array>;
  subscribers: (channel: Uint8Array, shard: boolean) => number;
  patterns: () => number;
  unblock: (id: number, error: boolean) => boolean;
  authenticate: (password: string, client: string) => AuthResult;
  setPassword: (password: string | null) => void;
}

export type Mode = "client" | "multi" | "script";

export interface Ctx {
  ks: Keyspace;
  session: Session;
  server: Server;
  now: number;
  mode: Mode;
  lookup: (args: Command) => Spec | Reply;
  invoke: (spec: Spec, args: Command) => Reply;
}

export interface Block {
  t: "block";
  keys: Array<Uint8Array>;
  timeoutMs: number;
  onTimeout: Reply;
  retry?: Command;
}

export type Outcome = Reply | Block;

export type Flag = "write" | "readonly" | "fast" | "noscript" | "blocking";

export interface Spec {
  arity: number;
  flags: Array<Flag>;
  keys?: [number, number, number];
  label?: string;
  run: (ctx: Ctx, args: Command) => Outcome;
}

export type Table = Record<string, Spec>;

export const isBlock = (o: Outcome): o is Block => o.t === "block";

export const spec = (arity: number, flags: Array<Flag>, run: Spec["run"], keys: Spec["keys"] = [1, 1, 1]): Spec => ({ arity, flags, keys, run });

export const keyless = (arity: number, flags: Array<Flag>, run: Spec["run"]): Spec => ({ arity, flags, run });
