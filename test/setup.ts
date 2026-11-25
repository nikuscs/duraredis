import { afterAll, beforeAll } from "bun:test";
import { startServer } from "./server";
import type { Server } from "./server";

let server: Server;
beforeAll(async () => {
  if (!process.env.DURAREDIS_NO_SERVER) server = await startServer();
});
afterAll(() => server?.stop());

export const serverHost = () => server.host;
export const serverPort = () => server.port;
export const serverUrl = (name: string) => server.url(name);

export const freshDb = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
